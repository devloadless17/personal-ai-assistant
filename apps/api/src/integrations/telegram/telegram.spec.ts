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

const CLIENT: Client = {
  id: 'client-1',
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
  defaultReminderMinutes: 15,
  dailyBriefHour: 7,
  lastBriefDate: null,
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
}): TelegramUpdate {
  return {
    update_id: overrides?.updateId ?? 1,
    message: {
      message_id: 10,
      chat: { id: overrides?.chatId ?? 777, type: 'private' },
      from: { id: 5, is_bot: false },
      text: overrides?.text ?? 'hello',
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
      controller.receive('client-1', 'wrong-secret', makeUpdate()),
    ).rejects.toThrow(ForbiddenException);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects a request with no secret header', async () => {
    const { controller, enqueue } = makeController(CLIENT);
    await expect(controller.receive('client-1', undefined, makeUpdate())).rejects.toThrow(
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
    const res = await controller.receive('client-1', 'the-real-secret', makeUpdate());
    expect(res).toEqual({ ok: true });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('acks (but does not enqueue) authentic-but-unparsable updates', async () => {
    const { controller, enqueue } = makeController(CLIENT);
    const res = await controller.receive('client-1', 'the-real-secret', { junk: true });
    expect(res).toEqual({ ok: true });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('TelegramUpdateProcessor — dedup, binding, serialization', () => {
  function makeProcessor(client: Client): {
    processor: TelegramUpdateProcessor;
    sent: string[];
    saveMessage: jest.Mock;
    respond: jest.Mock;
  } {
    const sent: string[] = [];
    const saveMessage = jest.fn().mockResolvedValue({});
    const respond = jest.fn().mockResolvedValue('the reply');
    const repo = { saveMessage } as unknown as ClientScopedRepository;
    const prisma = {
      client: { update: jest.fn().mockResolvedValue(client) },
    } as unknown as PrismaService;
    const tenancy = { repoFor: () => repo } as unknown as TenancyService;
    const agent = { respond } as unknown as AgentService;
    const telegram = {
      sendMessage: jest.fn().mockImplementation((_t: string, _c: string, text: string) => {
        sent.push(text);
        return Promise.resolve();
      }),
    } as unknown as TelegramService;
    const processor = new TelegramUpdateProcessor(prisma, tenancy, agent, telegram, fakeCrypto);
    return { processor, sent, saveMessage, respond };
  }

  async function flush(processor: TelegramUpdateProcessor, clientId: string): Promise<void> {
    // Wait for the per-client chain to drain.
    const chains = (processor as unknown as { chains: Map<string, Promise<void>> }).chains;
    while (chains.has(clientId)) await chains.get(clientId);
  }

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
