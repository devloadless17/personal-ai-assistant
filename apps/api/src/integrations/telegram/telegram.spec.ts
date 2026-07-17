import type { Client } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { ForbiddenException } from '@nestjs/common';
import { TelegramController } from './telegram.controller';
import { TelegramUpdateProcessor } from './telegram-update.processor';
import type { TelegramService } from './telegram.service';
import type { TelegramUpdate } from './telegram.types';
import type { CryptoService } from '../../crypto/crypto.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { TenancyService } from '../../tenancy/tenancy.service';
import type { AgentService } from '../../agent/agent.service';
import type { ClientScopedRepository } from '../../tenancy/client-scoped-repository';
import type { OpenAiTranscriptionService } from '../openai/openai-transcription.service';
import type { TimezoneService } from '../../timezone/timezone.service';

// A realistic cuid — the controller rejects non-cuid ids before any DB work.
const CID = 'ckabc123def456ghi789jkl01';
const CLIENT: Client = {
  id: CID,
  name: 'Test',
  status: 'active',
  timezone: 'UTC',
  assistantName: 'Aya',
  email: null,
  telegramBotTokenEnc: 'enc-token',
  telegramChatId: '777',
  telegramWebhookSecretEnc: 'enc-secret',
  googleOAuthEnc: null,
  googleNeedsReauth: false,
  telegramBotUsername: null,
  telegramBindCode: null,
  defaultReminderMinutes: 15,
  defaultMeetingMinutes: 60,
  reminderLeads: [15],
  dailyBriefHour: 7,
  lastBriefDate: null,
  lastBriefAt: null,
  homeTimezone: 'UTC',
  googleTimezone: null,
  timezonePinned: false,
  timezoneSource: null,
  timezoneUpdatedAt: null,
  lastTimezoneSyncAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const fakeCrypto = {
  decrypt: (v: string) => (v === 'enc-secret' ? 'the-real-secret' : 'bot-token'),
  encrypt: (v: string) => v,
} as unknown as CryptoService;

function makeUpdate(overrides?: {
  chatId?: number;
  text?: string;
  updateId?: number;
  voice?: { file_id?: string; duration?: number };
}): TelegramUpdate {
  const voice = overrides?.voice
    ? { file_id: overrides.voice.file_id ?? 'file-abc', duration: overrides.voice.duration ?? 5 }
    : undefined;
  return {
    update_id: overrides?.updateId ?? 1,
    message: {
      message_id: 10,
      chat: { id: overrides?.chatId ?? 777, type: 'private' },
      from: { id: 5, is_bot: false },
      // A voice update carries no text.
      text: voice ? undefined : (overrides?.text ?? 'hello'),
      voice,
      date: 1752600000,
    },
  };
}

describe('TelegramController — webhook authenticity', () => {
  function makeController(client: Client | null): {
    controller: TelegramController;
    enqueue: jest.Mock;
  } {
    const tenancy = {
      getActiveClient: jest.fn().mockResolvedValue(client),
    } as unknown as TenancyService;
    const enqueue = jest.fn();
    const processor = { enqueue } as unknown as TelegramUpdateProcessor;
    return { controller: new TelegramController(tenancy, fakeCrypto, processor), enqueue };
  }

  it('rejects a request with the wrong secret token', async () => {
    const { controller, enqueue } = makeController(CLIENT);
    await expect(
      controller.receive(CID, 'wrong-secret', makeUpdate()),
    ).rejects.toThrow(ForbiddenException);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects a request with no secret header', async () => {
    const { controller, enqueue } = makeController(CLIENT);
    await expect(controller.receive(CID, undefined, makeUpdate())).rejects.toThrow(
      ForbiddenException,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects unknown or disabled clients', async () => {
    const { controller, enqueue } = makeController(null);
    await expect(
      controller.receive('nope', 'the-real-secret', makeUpdate()),
    ).rejects.toThrow(ForbiddenException);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('acks and enqueues an authentic update', async () => {
    const { controller, enqueue } = makeController(CLIENT);
    const res = await controller.receive(CID, 'the-real-secret', makeUpdate());
    expect(res).toEqual({ ok: true });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('acks (but does not enqueue) authentic-but-unparsable updates', async () => {
    const { controller, enqueue } = makeController(CLIENT);
    const res = await controller.receive(CID, 'the-real-secret', { junk: true });
    expect(res).toEqual({ ok: true });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('TelegramUpdateProcessor — dedup, binding, serialization', () => {
  function makeProcessor(
    client: Client,
    opts?: { transcript?: string; transcribeConfigured?: boolean },
  ): {
    processor: TelegramUpdateProcessor;
    sent: string[];
    saveMessage: jest.Mock;
    respond: jest.Mock;
    transcribe: jest.Mock;
    hasInboundForUpdate: jest.Mock;
  } {
    const sent: string[] = [];
    const saveMessage = jest.fn().mockResolvedValue({});
    const respond = jest.fn().mockResolvedValue('the reply');
    const hasInboundForUpdate = jest.fn().mockResolvedValue(false);
    const repo = { saveMessage, hasInboundForUpdate } as unknown as ClientScopedRepository;
    const prisma = {
      client: { update: jest.fn().mockResolvedValue(client) },
    } as unknown as PrismaService;
    const tenancy = {
      repoFor: () => repo,
      // The processor re-loads the client at the start of each update.
      getActiveClient: jest.fn().mockResolvedValue(client),
    } as unknown as TenancyService;
    const agent = { respond } as unknown as AgentService;
    const telegram = {
      sendMessage: jest.fn().mockImplementation((_t: string, _c: string, text: string) => {
        sent.push(text);
        return Promise.resolve();
      }),
      sendTyping: jest.fn().mockResolvedValue(undefined),
      getFile: jest.fn().mockResolvedValue({ file_path: 'voice/file_1.oga' }),
      downloadFile: jest.fn().mockResolvedValue(Buffer.from('audio-bytes')),
    } as unknown as TelegramService;
    const transcribe = jest.fn().mockResolvedValue(opts?.transcript ?? 'add a task to call the bank');
    const transcription = {
      get isConfigured() {
        return opts?.transcribeConfigured ?? true;
      },
      transcribe,
    } as unknown as OpenAiTranscriptionService;
    // Default: sync is a no-op (not connected / throttled) — timezone unchanged.
    const timezone = {
      sync: jest.fn().mockResolvedValue({ synced: false }),
    } as unknown as TimezoneService;
    const processor = new TelegramUpdateProcessor(
      prisma,
      tenancy,
      agent,
      telegram,
      fakeCrypto,
      transcription,
      timezone,
    );
    return { processor, sent, saveMessage, respond, transcribe, hasInboundForUpdate };
  }

  async function flush(processor: TelegramUpdateProcessor, clientId: string): Promise<void> {
    // Wait for the per-client chain to drain.
    const chains = (processor as unknown as { chains: Map<string, Promise<void>> }).chains;
    while (chains.has(clientId)) await chains.get(clientId);
  }

  // ── Secure binding (F12): only a first chat presenting the /start <code> binds.
  const UNBOUND: Client = { ...CLIENT, telegramChatId: null, telegramBindCode: 'secret-code' };

  it('does NOT bind a first chat that lacks the correct start code', async () => {
    const { processor, respond, sent } = makeProcessor(UNBOUND);
    processor.enqueue(UNBOUND, makeUpdate({ text: 'hello' })); // no /start code
    await flush(processor, UNBOUND.id);
    expect(respond).not.toHaveBeenCalled();
    expect(sent[0]).toContain('link your administrator sent');
  });

  it('does NOT bind on a wrong start code', async () => {
    const { processor, respond } = makeProcessor(UNBOUND);
    processor.enqueue(UNBOUND, makeUpdate({ text: '/start wrong-code' }));
    await flush(processor, UNBOUND.id);
    expect(respond).not.toHaveBeenCalled();
  });

  it('binds a first chat that presents the correct start code, then welcomes', async () => {
    const { processor, respond, sent } = makeProcessor(UNBOUND);
    processor.enqueue(UNBOUND, makeUpdate({ text: '/start secret-code' }));
    await flush(processor, UNBOUND.id);
    // The /start message itself is not a request → agent not run this turn.
    expect(respond).not.toHaveBeenCalled();
    expect(sent[0]).toContain('your assistant'); // welcome message
  });

  it('processes a message end-to-end: dedup-save → agent → outbound → telegram send', async () => {
    const { processor, sent, saveMessage, respond } = makeProcessor(CLIENT);
    processor.enqueue(CLIENT, makeUpdate());
    await flush(processor, CLIENT.id);
    expect(saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ direction: 'inbound', telegramUpdateId: BigInt(1) }),
    );
    expect(respond).toHaveBeenCalledTimes(1);
    expect(saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ direction: 'outbound', content: 'the reply' }),
    );
    expect(sent).toEqual(['the reply']);
  });

  it('transcribes a voice note, saves the transcript, runs the agent, and echoes what it heard', async () => {
    const { processor, sent, saveMessage, respond, transcribe } = makeProcessor(CLIENT, {
      transcript: 'add a task to call the bank',
    });
    processor.enqueue(CLIENT, makeUpdate({ voice: {} }));
    await flush(processor, CLIENT.id);

    expect(transcribe).toHaveBeenCalledTimes(1);
    // Telegram voice path is …/file_1.oga, but OpenAI accepts `ogg` not `oga`
    // for the same Opus-in-OGG container — the extension must be normalized.
    expect(transcribe).toHaveBeenCalledWith(expect.any(Buffer), 'audio.ogg');
    // The transcript is stored as the inbound user turn (dedup key preserved).
    expect(saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: 'inbound',
        content: 'add a task to call the bank',
        telegramUpdateId: BigInt(1),
      }),
    );
    expect(respond).toHaveBeenCalledTimes(1);
    // Outbound echoes the transcript, then the agent reply — stored == sent.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('I heard');
    expect(sent[0]).toContain('add a task to call the bank');
    expect(sent[0]).toContain('the reply');
    expect(saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ direction: 'outbound', content: sent[0] }),
    );
  });

  it('asks the client to type when transcription is not configured, without running the agent', async () => {
    const { processor, sent, respond, transcribe } = makeProcessor(CLIENT, {
      transcribeConfigured: false,
    });
    processor.enqueue(CLIENT, makeUpdate({ voice: {} }));
    await flush(processor, CLIENT.id);

    expect(transcribe).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('aren’t set up');
  });

  it('refuses an over-long voice note without transcribing or running the agent', async () => {
    const { processor, sent, respond, transcribe } = makeProcessor(CLIENT);
    processor.enqueue(CLIENT, makeUpdate({ voice: { duration: 600 } }));
    await flush(processor, CLIENT.id);

    expect(transcribe).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
    expect(sent[0]).toContain('under 5 minutes');
  });

  it('replies honestly when transcription fails, without running the agent', async () => {
    const { processor, sent, respond, transcribe } = makeProcessor(CLIENT);
    transcribe.mockRejectedValueOnce(new Error('whisper down'));
    processor.enqueue(CLIENT, makeUpdate({ voice: {} }));
    await flush(processor, CLIENT.id);

    expect(respond).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('couldn’t process that voice note');
  });

  it('skips a redelivered voice note BEFORE transcribing (early dedup pre-check)', async () => {
    const { processor, sent, respond, transcribe, hasInboundForUpdate } = makeProcessor(CLIENT);
    // The first copy already committed its inbound row → pre-check sees it.
    hasInboundForUpdate.mockResolvedValueOnce(true);
    processor.enqueue(CLIENT, makeUpdate({ voice: {} }));
    await flush(processor, CLIENT.id);

    expect(transcribe).not.toHaveBeenCalled(); // no paid transcription on a dupe
    expect(respond).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('skips duplicate updates (unique-constraint hit) without running the agent', async () => {
    const { processor, sent, saveMessage, respond } = makeProcessor(CLIENT);
    saveMessage.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dupe', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    processor.enqueue(CLIENT, makeUpdate());
    await flush(processor, CLIENT.id);
    expect(respond).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('refuses messages from a foreign chat', async () => {
    const { processor, sent, respond } = makeProcessor(CLIENT);
    processor.enqueue(CLIENT, makeUpdate({ chatId: 999 }));
    await flush(processor, CLIENT.id);
    expect(respond).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('replies honestly when the agent fails', async () => {
    const { processor, sent, respond } = makeProcessor(CLIENT);
    respond.mockRejectedValueOnce(new Error('boom'));
    processor.enqueue(CLIENT, makeUpdate());
    await flush(processor, CLIENT.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('didn’t go through');
  });

  it('serializes concurrent updates for the same client', async () => {
    const { processor, respond } = makeProcessor(CLIENT);
    const order: number[] = [];
    respond
      .mockImplementationOnce(async () => {
        await new Promise((r) => setTimeout(r, 30));
        order.push(1);
        return 'first';
      })
      .mockImplementationOnce(() => {
        order.push(2);
        return Promise.resolve('second');
      });
    processor.enqueue(CLIENT, makeUpdate({ updateId: 1 }));
    processor.enqueue(CLIENT, makeUpdate({ updateId: 2 }));
    await flush(processor, CLIENT.id);
    expect(order).toEqual([1, 2]); // strictly in order, never interleaved
  });
});
