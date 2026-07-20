import Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.validation';

/** Small, fast model for the yes/no fabrication backstop — this decision needs
 * speed and cheapness, not reasoning, and it runs on the reply path. */
const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Thin wrapper around the Anthropic SDK client. Exists so the agent loop can
 * be unit-tested with a fake `create` and so model/config live in one place.
 */
@Injectable()
export class AnthropicService {
  private readonly logger = new Logger(AnthropicService.name);
  private readonly client: Anthropic | null;
  readonly model: string;

  constructor(config: ConfigService<Env, true>) {
    const apiKey = config.get('ANTHROPIC_API_KEY', { infer: true });
    this.model = config.get('ANTHROPIC_MODEL', { infer: true });
    if (apiKey) {
      // Bound each request so a hung API call can't occupy a client's serialized
      // turn (up to MAX_TOOL_ITERATIONS × the SDK's ~10-min default otherwise),
      // which would stall that client's message queue and grow it unbounded.
      this.client = new Anthropic({ apiKey, timeout: 120_000, maxRetries: 2 });
    } else {
      this.client = null;
      this.logger.warn('ANTHROPIC_API_KEY not set — the assistant cannot answer until it is.');
    }
  }

  get isConfigured(): boolean {
    return this.client !== null;
  }

  /**
   * Cheap, bounded yes/no classification — the SEMANTIC backstop to the
   * regex-based fabrication guard.
   *
   * Pattern-matching a reply for "I booked it" only catches phrasings we've
   * already seen: a real client lost two reminders because the assistant wrote
   * "Will ping you Monday at 9 AM ✅" and the pattern only knew "I'll ping you".
   * A tiny model reading the sentence generalises where a regex cannot.
   *
   * Deliberately fail-OPEN (returns null on any error/timeout): this runs on the
   * reply path, so a classifier hiccup must never block a client's answer. The
   * caller treats null as "no opinion" and falls back to the regex verdict.
   */
  async classifyYesNo(params: {
    system: string;
    input: string;
    timeoutMs?: number;
  }): Promise<boolean | null> {
    if (!this.client) return null;
    try {
      const res = await this.client.messages.create(
        {
          model: CLASSIFIER_MODEL,
          max_tokens: 5,
          system: params.system,
          messages: [{ role: 'user', content: params.input }],
        },
        { timeout: params.timeoutMs ?? 8_000, maxRetries: 1 },
      );
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join(' ')
        .trim()
        .toLowerCase();
      if (text.startsWith('yes')) return true;
      if (text.startsWith('no')) return false;
      return null;
    } catch (err) {
      this.logger.warn(
        `Classifier call failed (falling back to pattern check): ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /** One model turn. SDK handles 429/5xx retries (default 2). */
  async createMessage(params: {
    system: Anthropic.TextBlockParam[];
    tools: Anthropic.Tool[];
    messages: Anthropic.MessageParam[];
    maxTokens?: number;
  }): Promise<Anthropic.Message> {
    if (!this.client) {
      throw new Error('Anthropic API key is not configured (set ANTHROPIC_API_KEY).');
    }
    return this.client.messages.create({
      model: this.model,
      max_tokens: params.maxTokens ?? 4096,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: params.system,
      tools: params.tools,
      messages: params.messages,
    });
  }
}
