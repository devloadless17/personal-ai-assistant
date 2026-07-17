import { Injectable, Logger } from '@nestjs/common';

/** A non-retryable Telegram failure (a 4xx) — surfaces immediately instead of
 * being retried. Anything else is treated as transient. */
class PermanentTelegramError extends Error {}

/**
 * Telegram Bot API client. Plain fetch — the API is simple HTTP POST.
 * Retries transient failures with backoff; a final failure THROWS so callers
 * must handle it (never a silent drop).
 *
 * SECURITY: bot tokens arrive decrypted from the caller and are never logged.
 */
@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);

  private api(botToken: string, method: string): string {
    return `https://api.telegram.org/bot${botToken}/${method}`;
  }

  /**
   * Shared retry skeleton for every Telegram request: run `attempt`, retry
   * transient failures with linear backoff, but surface a
   * PermanentTelegramError (a 4xx) immediately. THROWS the last error after
   * `retries` attempts — never a silent drop.
   */
  private async withRetry<T>(label: string, attempt: () => Promise<T>, retries = 3): Promise<T> {
    let lastError: unknown;
    for (let i = 1; i <= retries; i++) {
      try {
        return await attempt();
      } catch (err) {
        if (err instanceof PermanentTelegramError) throw err;
        lastError = err;
      }
      if (i < retries) {
        await new Promise((r) => setTimeout(r, i * 1500));
      }
    }
    this.logger.error(`Telegram ${label} failed after ${retries} attempts`);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async call<T>(
    botToken: string,
    method: string,
    body: Record<string, unknown>,
    retries = 3,
  ): Promise<T> {
    return this.withRetry(
      method,
      async () => {
        const res = await fetch(this.api(botToken, method), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
        const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
        if (json.ok && json.result !== undefined) return json.result;
        // 429 = rate limited: TRANSIENT, must be retried (with backoff) — never
        // treat it as permanent, or an interactive reply is lost on a brief burst.
        if (res.status === 429) {
          throw new Error(`Telegram ${method} rate-limited (429): ${json.description ?? ''}`);
        }
        // Other 4xx from Telegram (bad token, blocked bot…) — retrying won't help.
        if (res.status >= 400 && res.status < 500) {
          throw new PermanentTelegramError(
            `Telegram ${method} rejected: ${json.description ?? res.status}`,
          );
        }
        throw new Error(`Telegram ${method} failed: ${json.description ?? res.status}`);
      },
      retries,
    );
  }

  async sendMessage(botToken: string, chatId: string | number, text: string): Promise<void> {
    // Telegram hard limit is 4096 chars/message — split honestly, never truncate.
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));
    for (const chunk of chunks) {
      await this.call(botToken, 'sendMessage', { chat_id: chatId, text: chunk });
    }
  }

  /** Best-effort "typing…" indicator so the client sees the assistant working.
   * Purely cosmetic — never let it fail or delay the real reply. */
  async sendTyping(botToken: string, chatId: string | number): Promise<void> {
    try {
      await this.call(botToken, 'sendChatAction', { chat_id: chatId, action: 'typing' }, 1);
    } catch {
      // ignore — the actual message send is what matters
    }
  }

  /** Registers the per-client webhook with its secret token. */
  async setWebhook(botToken: string, url: string, secretToken: string): Promise<void> {
    await this.call(botToken, 'setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: ['message'],
      drop_pending_updates: false,
    });
  }

  async deleteWebhook(botToken: string): Promise<void> {
    await this.call(botToken, 'deleteWebhook', {});
  }

  /** Validates a bot token and returns the bot's username. */
  async getMe(botToken: string): Promise<{ username: string }> {
    return this.call<{ username: string }>(botToken, 'getMe', {});
  }

  /** Resolves a file_id to a downloadable file_path on Telegram's file server. */
  async getFile(botToken: string, fileId: string): Promise<{ file_path: string }> {
    return this.call<{ file_path: string }>(botToken, 'getFile', { file_id: fileId });
  }

  /**
   * Downloads a file's bytes from Telegram's file server. Separate request from
   * `call()` because that endpoint returns JSON and this one returns binary,
   * but it shares the same 15s timeout and retry/backoff via `withRetry`. The
   * token is in the URL — never logged.
   */
  async downloadFile(botToken: string, filePath: string, retries = 3): Promise<Buffer> {
    const url = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
    return this.withRetry(
      'file download',
      async () => {
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (res.ok) return Buffer.from(await res.arrayBuffer());
        // 4xx (expired/invalid file_path) — retrying won't help.
        if (res.status >= 400 && res.status < 500) {
          throw new PermanentTelegramError(`Telegram file download rejected: ${res.status}`);
        }
        throw new Error(`Telegram file download failed: ${res.status}`);
      },
      retries,
    );
  }
}
