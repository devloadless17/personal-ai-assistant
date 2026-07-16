import { Injectable, Logger } from '@nestjs/common';

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

  private async call<T>(
    botToken: string,
    method: string,
    body: Record<string, unknown>,
    retries = 3,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const res = await fetch(this.api(botToken, method), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
        const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
        if (json.ok && json.result !== undefined) return json.result;
        // 4xx from Telegram (bad token, blocked bot…) — retrying won't help.
        if (res.status >= 400 && res.status < 500) {
          throw new Error(`Telegram ${method} rejected: ${json.description ?? res.status}`);
        }
        lastError = new Error(`Telegram ${method} failed: ${json.description ?? res.status}`);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('Telegram')) throw err;
        lastError = err;
      }
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, attempt * 1500));
      }
    }
    this.logger.error(`Telegram ${method} failed after ${retries} attempts`);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
}
