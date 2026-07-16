import { timingSafeEqual } from 'node:crypto';
import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { CryptoService } from '../../crypto/crypto.service';
import { TenancyService } from '../../tenancy/tenancy.service';
import { TelegramUpdateProcessor } from './telegram-update.processor';
import { telegramUpdateSchema } from './telegram.types';

/**
 * Per-client Telegram webhook: POST /telegram/:clientId
 *
 * - AUTHENTICITY: X-Telegram-Bot-Api-Secret-Token must match the per-client
 *   secret we registered with setWebhook (constant-time compare). Anything
 *   else is rejected — a forged request can never reach the agent.
 * - FAST-ACK: validates, enqueues, returns 200 immediately. Telegram never
 *   times out; slow agent runs never block the HTTP worker. Malformed or
 *   irrelevant updates are acked too (returning errors would make Telegram
 *   redeliver garbage forever).
 */
@Controller('telegram')
export class TelegramController {
  constructor(
    private readonly tenancy: TenancyService,
    private readonly crypto: CryptoService,
    private readonly processor: TelegramUpdateProcessor,
  ) {}

  @Post(':clientId')
  @HttpCode(200)
  async receive(
    @Param('clientId') clientId: string,
    @Headers('x-telegram-bot-api-secret-token') secretHeader: string | undefined,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const client = await this.tenancy.getActiveClient(clientId);
    if (!client?.telegramWebhookSecretEnc) {
      // Unknown/disabled client or webhook never configured — reject.
      throw new ForbiddenException();
    }

    const expected = this.crypto.decrypt(client.telegramWebhookSecretEnc);
    if (!secretHeader || !this.safeEqual(secretHeader, expected)) {
      throw new ForbiddenException();
    }

    const parsed = telegramUpdateSchema.safeParse(body);
    if (parsed.success) {
      this.processor.enqueue(client, parsed.data);
    }
    // Ack regardless — authenticity was verified; unparsable updates are
    // update types we don't handle (edits, stickers-only, etc.).
    return { ok: true };
  }

  private safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }
}
