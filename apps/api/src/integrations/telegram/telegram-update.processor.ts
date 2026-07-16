import { Injectable, Logger } from '@nestjs/common';
import type { Client } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { AgentService } from '../../agent/agent.service';
import { CryptoService } from '../../crypto/crypto.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TenancyService } from '../../tenancy/tenancy.service';
import { TelegramService } from './telegram.service';
import type { TelegramUpdate } from './telegram.types';

/**
 * Processes Telegram updates AFTER the webhook has fast-acked.
 *
 * Guarantees:
 * - DEDUP: (clientId, update_id) unique constraint — Telegram's webhook
 *   redeliveries can never double-process a message.
 * - SERIALIZATION: one in-flight agent run per client (promise chain), so
 *   rapid consecutive messages can't race each other's context.
 * - HONESTY: failures reply "didn't go through" when possible and are always
 *   logged; nothing is silently dropped.
 *
 * NOTE: serialization is in-process — correct for the single-API-container
 * deployment. Scaling to multiple API instances requires moving this to a
 * shared queue (e.g. BullMQ) — flagged in the README.
 */
@Injectable()
export class TelegramUpdateProcessor {
  private readonly logger = new Logger(TelegramUpdateProcessor.name);
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
    private readonly agent: AgentService,
    private readonly telegram: TelegramService,
    private readonly crypto: CryptoService,
  ) {}

  /** Fire-and-forget from the controller; work is chained per client. */
  enqueue(client: Client, update: TelegramUpdate): void {
    const tail = this.chains.get(client.id) ?? Promise.resolve();
    const next = tail
      .then(() => this.process(client, update))
      .catch((err: unknown) => {
        this.logger.error(
          `Update ${update.update_id} for client ${client.id} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
        );
      })
      .finally(() => {
        // Trim the chain map when this client goes idle.
        if (this.chains.get(client.id) === next) this.chains.delete(client.id);
      });
    this.chains.set(client.id, next);
  }

  private async process(client: Client, update: TelegramUpdate): Promise<void> {
    const msg = update.message;
    if (!msg || msg.from?.is_bot) return; // nothing actionable
    const botToken = client.telegramBotTokenEnc
      ? this.crypto.decrypt(client.telegramBotTokenEnc)
      : null;
    if (!botToken) {
      this.logger.error(`Client ${client.id} received an update but has no bot token stored`);
      return;
    }

    // ── Chat binding: only a FIRST private chat that presents the correct
    // one-time code (from the admin's t.me deep link, sent as "/start <code>")
    // may bind. This stops a leaked/guessed bot link from hijacking the
    // client's assistant. After binding, other chats are refused.
    const chatId = String(msg.chat.id);
    if (!client.telegramChatId) {
      if (msg.chat.type !== 'private') return;
      const presented = this.extractStartCode(msg.text);
      if (!client.telegramBindCode || presented !== client.telegramBindCode) {
        this.logger.warn(
          `Client ${client.id}: chat ${chatId} tried to bind without a valid code — refused`,
        );
        if (msg.text) {
          await this.telegram.sendMessage(
            botToken,
            chatId,
            'To start, please open the exact link your administrator sent you.',
          );
        }
        return;
      }
      // Bind, and burn the code so the link can't bind a second chat.
      await this.prisma.client.update({
        where: { id: client.id },
        data: { telegramChatId: chatId, telegramBindCode: null },
      });
      client = { ...client, telegramChatId: chatId, telegramBindCode: null };
      this.logger.log(`Client ${client.id} bound to Telegram chat ${chatId} via code`);
      await this.telegram.sendMessage(
        botToken,
        chatId,
        `Hi! I'm ${client.assistantName}, your assistant. Ask me about your day, or tell me to add a task or book a meeting.`,
      );
      // The "/start <code>" message itself isn't a real request — stop here.
      return;
    } else if (client.telegramChatId !== chatId) {
      this.logger.warn(
        `Client ${client.id}: update from foreign chat ${chatId} refused (bound to ${client.telegramChatId})`,
      );
      return;
    }

    if (!msg.text) {
      await this.telegram.sendMessage(
        botToken,
        chatId,
        'I can only read text messages for now — please type your request.',
      );
      return;
    }

    const repo = this.tenancy.repoFor(client.id);

    // ── Dedup via unique(clientId, telegramUpdateId): a redelivery hits
    // P2002 and is skipped — double-processing is impossible.
    try {
      await repo.saveMessage({
        direction: 'inbound',
        content: msg.text,
        telegramUpdateId: BigInt(update.update_id),
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        this.logger.log(`Duplicate update ${update.update_id} for client ${client.id} skipped`);
        return;
      }
      throw err;
    }

    let reply: string;
    try {
      reply = await this.agent.respond(client);
    } catch (err) {
      this.logger.error(
        `Agent failed for client ${client.id}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
      reply = 'Sorry — that didn’t go through on my side. Nothing was changed. Please try again.';
    }

    await repo.saveMessage({ direction: 'outbound', content: reply });
    await this.telegram.sendMessage(botToken, chatId, reply);
  }

  /** Extract the payload from a "/start <code>" message (Telegram deep link). */
  private extractStartCode(text: string | undefined): string | null {
    if (!text) return null;
    const match = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]+)/.exec(text.trim());
    return match?.[1] ?? null;
  }
}
