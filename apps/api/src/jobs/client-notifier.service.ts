import { Injectable, Logger } from '@nestjs/common';
import type { Client, MessageKind } from '@prisma/client';
import { CryptoService } from '../crypto/crypto.service';
import { TelegramService } from '../integrations/telegram/telegram.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * THE choke point for system-initiated Telegram messages.
 *
 * Background jobs used to call TelegramService.sendMessage directly, so reminder
 * pings, daily briefs and conflict notices reached the client but were NEVER
 * recorded — the admin message log showed only the chat back-and-forth, and had
 * no way to answer "what did my system actually send this client?". Routing all
 * of them through here means every outbound message is persisted with a `kind`.
 *
 * Ordering is deliberate: SEND FIRST, then record. A failed send throws before
 * anything is written (no phantom "sent" row), and if the send succeeds but the
 * write fails we keep the delivery and only lose a log line — never the reverse.
 * The logging failure is swallowed for the same reason: an audit-trail hiccup
 * must not fail a delivery the client already received, nor trigger a caller's
 * retry/revert path and double-send.
 */
@Injectable()
export class ClientNotifierService {
  private readonly logger = new Logger(ClientNotifierService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
    private readonly crypto: CryptoService,
  ) {}

  /**
   * Deliver `text` to the client's bound chat and record it as an outbound
   * message of `kind`. Throws if the client isn't reachable or the send fails,
   * so callers keep their existing retry/lease semantics.
   */
  async send(client: Client, text: string, kind: MessageKind): Promise<void> {
    const botToken = client.telegramBotTokenEnc
      ? this.crypto.decrypt(client.telegramBotTokenEnc)
      : null;
    if (!botToken || !client.telegramChatId) {
      throw new Error('client has no bot token or bound chat');
    }
    await this.telegram.sendMessage(botToken, client.telegramChatId, text);
    await this.record(client.id, text, kind);
  }

  /**
   * Record an already-delivered message. Separate so callers that must send with
   * their own token/chat handling still get an audit trail.
   */
  async record(clientId: string, text: string, kind: MessageKind): Promise<void> {
    try {
      await this.prisma.message.create({
        data: { clientId, direction: 'outbound', kind, content: text },
      });
    } catch (err) {
      // Never fail (or retry) a delivery over a logging problem.
      this.logger.error(
        `Failed to record ${kind} message for client ${clientId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
