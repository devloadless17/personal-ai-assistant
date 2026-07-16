import Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.validation';

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
      this.client = new Anthropic({ apiKey });
    } else {
      this.client = null;
      this.logger.warn('ANTHROPIC_API_KEY not set — the assistant cannot answer until it is.');
    }
  }

  get isConfigured(): boolean {
    return this.client !== null;
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
