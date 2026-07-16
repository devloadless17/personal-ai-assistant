import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramService } from '../integrations/telegram/telegram.service';
import type { Env } from '../config/env.validation';

/**
 * Pushes critical failures to YOUR (the admin's) Telegram so problems find
 * you instead of waiting to be found. No-ops (with a log) when not
 * configured. Alerting must never crash the caller.
 */
@Injectable()
export class AdminAlertService {
  private readonly logger = new Logger(AdminAlertService.name);
  private readonly botToken?: string;
  private readonly chatId?: string;
  /** alert-key → last-sent ms; 1 alert per key per hour (no alert storms). */
  private readonly lastSent = new Map<string, number>();

  constructor(
    config: ConfigService<Env, true>,
    private readonly telegram: TelegramService,
  ) {
    this.botToken = config.get('ADMIN_ALERT_BOT_TOKEN', { infer: true });
    this.chatId = config.get('ADMIN_ALERT_CHAT_ID', { infer: true });
  }

  async alert(key: string, message: string): Promise<void> {
    const last = this.lastSent.get(key) ?? 0;
    if (Date.now() - last < 60 * 60_000) return; // throttled
    this.lastSent.set(key, Date.now());

    this.logger.warn(`ADMIN ALERT [${key}]: ${message}`);
    if (!this.botToken || !this.chatId) return;
    try {
      await this.telegram.sendMessage(this.botToken, this.chatId, `🚨 ${message}`);
    } catch (err) {
      this.logger.error(
        `Failed to deliver admin alert: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
