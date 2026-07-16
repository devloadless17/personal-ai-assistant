import { randomBytes } from 'node:crypto';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CryptoService } from '../../crypto/crypto.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TelegramService } from './telegram.service';
import type { Env } from '../../config/env.validation';

/**
 * Connects a client's Telegram bot — validates the token against the real Bot
 * API, encrypts it, generates a webhook secret, and registers the webhook.
 * Used by BOTH the admin dashboard and the client self-service portal so the
 * connect logic lives in exactly one place. Fails loudly — no half-connected
 * states.
 */
@Injectable()
export class TelegramConnectionService {
  private readonly logger = new Logger(TelegramConnectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly telegram: TelegramService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async connect(clientId: string, botToken: string): Promise<{ botUsername: string }> {
    const client = await this.prisma.client.findUnique({ where: { id: clientId } });
    if (!client) throw new NotFoundException('Client not found');

    let botUsername: string;
    try {
      botUsername = (await this.telegram.getMe(botToken)).username;
    } catch {
      throw new BadRequestException('Telegram rejected that bot token — check it with @BotFather.');
    }

    const publicApiUrl = this.config.get('PUBLIC_API_URL', { infer: true });
    if (publicApiUrl.includes('localhost')) {
      throw new BadRequestException(
        'The server is running on a localhost URL — Telegram webhooks need a public HTTPS address (deploy first, or use a tunnel).',
      );
    }

    const secret = randomBytes(32).toString('hex');
    await this.telegram.setWebhook(botToken, `${publicApiUrl}/telegram/${clientId}`, secret);

    await this.prisma.client.update({
      where: { id: clientId },
      data: {
        telegramBotTokenEnc: this.crypto.encrypt(botToken),
        telegramWebhookSecretEnc: this.crypto.encrypt(secret),
        telegramChatId: null, // rebind on the next first message
      },
    });
    this.logger.log(`Telegram connected for client ${clientId} (@${botUsername})`);
    return { botUsername };
  }
}
