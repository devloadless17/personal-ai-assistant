import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI, { toFile } from 'openai';
import type { Env } from '../../config/env.validation';

/**
 * Speech-to-text for inbound Telegram voice notes. Claude has no audio API, so
 * transcription lives here as its own provider wrapper — same shape as
 * {@link AnthropicService} so it's trivial to fake in unit tests and so
 * model/key config live in one place.
 *
 * Whisper accepts Telegram's OGG/Opus voice notes directly; we pass the real
 * file extension so the API can detect the format.
 */
@Injectable()
export class OpenAiTranscriptionService {
  private readonly logger = new Logger(OpenAiTranscriptionService.name);
  private readonly client: OpenAI | null;
  readonly model: string;

  constructor(config: ConfigService<Env, true>) {
    const apiKey = config.get('OPENAI_API_KEY', { infer: true });
    this.model = config.get('OPENAI_TRANSCRIBE_MODEL', { infer: true });
    if (apiKey) {
      // A voice note is transcribed inside the per-client serialization chain,
      // so a hung request would block that client's next messages. Bound it:
      // 60s per attempt (generous for a ≤5-min note) with one retry.
      this.client = new OpenAI({ apiKey, timeout: 60_000, maxRetries: 1 });
    } else {
      this.client = null;
      this.logger.warn('OPENAI_API_KEY not set — voice messages cannot be transcribed until it is.');
    }
  }

  get isConfigured(): boolean {
    return this.client !== null;
  }

  /**
   * Transcribe audio bytes to text. `filename` must carry the real extension
   * (e.g. "voice.oga") so the API detects the format. THROWS on failure — the
   * caller decides how to tell the client; nothing is ever silently dropped.
   */
  async transcribe(audio: Buffer, filename: string): Promise<string> {
    if (!this.client) {
      throw new Error('OpenAI API key is not configured (set OPENAI_API_KEY).');
    }
    const result = await this.client.audio.transcriptions.create({
      file: await toFile(audio, filename),
      model: this.model,
    });
    return result.text.trim();
  }
}
