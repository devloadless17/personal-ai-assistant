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

    // ── Chat binding: the first private chat to message the bot becomes THE
    // client's chat; anything else is refused (and never reaches the agent).
    const chatId = String(msg.chat.id);
    if (!client.telegramChatId) {
      if (msg.chat.type !== 'private') return;
      await this.prisma.client.update({
        where: { id: client.id },
        data: { telegramChatId: chatId },
      });
      client = { ...client, telegramChatId: chatId };
      this.logger.log(`Client ${client.id} bound to Telegram chat ${chatId}`);
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
}
