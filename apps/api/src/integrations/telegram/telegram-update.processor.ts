import { Injectable, Logger } from '@nestjs/common';
import type { Client } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { AgentService } from '../../agent/agent.service';
import { CryptoService } from '../../crypto/crypto.service';
import { OpenAiTranscriptionService } from '../openai/openai-transcription.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TenancyService } from '../../tenancy/tenancy.service';
import { TelegramService } from './telegram.service';
import type { TelegramUpdate } from './telegram.types';

/** Voice notes longer than this are refused — keeps transcription cost/latency
 * bounded and nudges clients toward short, actionable requests. */
const MAX_VOICE_SECONDS = 300;

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
    private readonly transcription: OpenAiTranscriptionService,
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

    // Re-load the client from the DB at the start of each (serialized) update,
    // so a message queued behind a just-completed bind sees the COMMITTED
    // binding state instead of the stale snapshot captured at webhook time.
    const fresh = await this.tenancy.getActiveClient(client.id);
    if (!fresh) {
      this.logger.warn(`Client ${client.id} no longer active — dropping update ${update.update_id}`);
      return;
    }
    client = fresh;

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
        // Nudge on any real content (text OR a voice/audio note) — a client who
        // opens a fresh bot and records a voice note should not get silence.
        if (msg.text || msg.voice || msg.audio) {
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

    const repo = this.tenancy.repoFor(client.id);
    const updateId = BigInt(update.update_id);

    // ── Early dedup: skip a webhook redelivery BEFORE doing expensive work.
    // Updates for one client run serially (the per-client chain), so the first
    // copy's inbound row is committed before a redelivery reaches this check —
    // this stops a duplicate voice note from being re-downloaded and re-billed
    // for transcription. The unique constraint below is still the backstop.
    if (await repo.hasInboundForUpdate(updateId)) {
      this.logger.log(`Duplicate update ${update.update_id} for client ${client.id} skipped`);
      return;
    }

    // Resolve the request to text: typed text passes through; a voice note is
    // transcribed first. A null return means we already told the client why we
    // couldn't proceed (unsupported type, transcription off, failure) — stop.
    const wasVoice = Boolean(msg.voice ?? msg.audio);
    const text = await this.resolveText(botToken, chatId, msg);
    if (text === null) return;

    // ── Dedup backstop via unique(clientId, telegramUpdateId): if a redelivery
    // raced past the check above (e.g. multi-instance), P2002 skips it here.
    try {
      await repo.saveMessage({
        direction: 'inbound',
        content: text,
        telegramUpdateId: updateId,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        this.logger.log(`Duplicate update ${update.update_id} for client ${client.id} skipped`);
        return;
      }
      throw err;
    }

    // Show "typing…" while the agent works — makes multi-tool turns feel live.
    // (Telegram's indicator expires after ~5s, so this also refreshes the one
    // resolveText showed during voice transcription — not a redundant call.)
    await this.telegram.sendTyping(botToken, chatId);

    let reply: string;
    try {
      reply = await this.agent.respond(client);
    } catch (err) {
      this.logger.error(
        `Agent failed for client ${client.id}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
      reply = 'Sorry — that didn’t go through on my side. Nothing was changed. Please try again.';
    }

    // Echo-then-act: for voice, prepend what we heard so a mis-hearing is
    // obvious to the client immediately. Store exactly what we sent.
    const outbound = wasVoice ? `🎙️ I heard: “${text}”\n\n${reply}` : reply;
    await repo.saveMessage({ direction: 'outbound', content: outbound });
    await this.telegram.sendMessage(botToken, chatId, outbound);
  }

  /**
   * Turns an inbound message into the text the agent should act on.
   * - text → returned as-is.
   * - voice/audio → downloaded from Telegram and transcribed.
   * - anything else → the client is told we only read text/voice.
   *
   * Returns null when the request can't proceed AND the client has already been
   * told why (so the caller just stops). Never silently drops a message.
   */
  private async resolveText(
    botToken: string,
    chatId: string,
    msg: NonNullable<TelegramUpdate['message']>,
  ): Promise<string | null> {
    if (msg.text) return msg.text;

    const media = msg.voice ?? msg.audio;
    if (!media) {
      await this.telegram.sendMessage(
        botToken,
        chatId,
        'I can only read text and voice messages for now — please type or record your request.',
      );
      return null;
    }

    if (!this.transcription.isConfigured) {
      await this.telegram.sendMessage(
        botToken,
        chatId,
        'Voice messages aren’t set up yet — please type your request for now.',
      );
      return null;
    }

    if (media.duration > MAX_VOICE_SECONDS) {
      await this.telegram.sendMessage(
        botToken,
        chatId,
        'That voice note is a bit long for me — please keep it under 5 minutes, or type your request.',
      );
      return null;
    }

    // Transcription can take a moment — show the client we're working on it.
    await this.telegram.sendTyping(botToken, chatId);
    try {
      const file = await this.telegram.getFile(botToken, media.file_id);
      const audio = await this.telegram.downloadFile(botToken, file.file_path);
      // Whisper detects the format from the extension. Take Telegram's REAL one
      // (e.g. "voice/file_5.oga") rather than guessing — a forwarded m4a/ogg
      // audio would otherwise be mislabelled .mp3 and rejected. Fall back per
      // message type only when the path carries no usable extension.
      const pathExt = file.file_path.split('.').pop()?.toLowerCase();
      const ext = pathExt && /^[a-z0-9]{2,4}$/.test(pathExt) ? pathExt : msg.voice ? 'oga' : 'mp3';
      const transcript = await this.transcription.transcribe(audio, `audio.${ext}`);
      if (!transcript) {
        await this.telegram.sendMessage(
          botToken,
          chatId,
          'I couldn’t make out any words in that voice note — could you try again?',
        );
        return null;
      }
      return transcript;
    } catch (err) {
      this.logger.error(
        `Transcription failed for chat ${chatId}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
      await this.telegram.sendMessage(
        botToken,
        chatId,
        'Sorry — I couldn’t process that voice note on my side. Nothing was changed. Please try again or type it.',
      );
      return null;
    }
  }

  /** Extract the payload from a "/start <code>" message (Telegram deep link). */
  private extractStartCode(text: string | undefined): string | null {
    if (!text) return null;
    const match = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]+)/.exec(text.trim());
    return match?.[1] ?? null;
  }
}
