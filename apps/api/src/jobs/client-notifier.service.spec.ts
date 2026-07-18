import { ClientNotifierService } from './client-notifier.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { TelegramService } from '../integrations/telegram/telegram.service';
import type { CryptoService } from '../crypto/crypto.service';
import type { Client } from '@prisma/client';

/**
 * The admin log must show EVERYTHING a client receives — reminder pings, the
 * daily brief and system alerts included, not just the chat back-and-forth.
 * These guard the two orderings that make that trustworthy: never log a message
 * that wasn't delivered, and never fail a delivery over a logging problem.
 */

const CLIENT = {
  id: 'c1',
  telegramBotTokenEnc: 'enc',
  telegramChatId: 'chat-1',
} as unknown as Client;

function make(opts?: { sendFails?: boolean; writeFails?: boolean }): {
  svc: ClientNotifierService;
  created: Record<string, unknown>[];
  sent: string[];
} {
  const created: Record<string, unknown>[] = [];
  const sent: string[] = [];
  const prisma = {
    message: {
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        if (opts?.writeFails) return Promise.reject(new Error('db down'));
        created.push(args.data);
        return Promise.resolve({});
      }),
    },
  } as unknown as PrismaService;
  const telegram = {
    sendMessage: jest.fn((_t: string, _c: string, text: string) => {
      if (opts?.sendFails) return Promise.reject(new Error('telegram down'));
      sent.push(text);
      return Promise.resolve(undefined);
    }),
  } as unknown as TelegramService;
  const crypto = { decrypt: () => 'bot-token' } as unknown as CryptoService;
  return { svc: new ClientNotifierService(prisma, telegram, crypto), created, sent };
}

describe('ClientNotifierService', () => {
  it('records a delivered system message with its kind', async () => {
    const { svc, created, sent } = make();
    await svc.send(CLIENT, '⏰ Reminder: Pay bill', 'reminder');
    expect(sent).toEqual(['⏰ Reminder: Pay bill']);
    expect(created).toEqual([
      { clientId: 'c1', direction: 'outbound', kind: 'reminder', content: '⏰ Reminder: Pay bill' },
    ]);
  });

  it('does NOT log a message that failed to send (no phantom rows in the log)', async () => {
    const { svc, created } = make({ sendFails: true });
    await expect(svc.send(CLIENT, 'hi', 'brief')).rejects.toThrow('telegram down');
    expect(created).toEqual([]);
  });

  it('never fails a delivery because logging failed', async () => {
    // The client already received it — an audit-trail hiccup must not surface as
    // a send failure, or the caller would revert its claim and double-send.
    const { svc, sent } = make({ writeFails: true });
    await expect(svc.send(CLIENT, 'delivered', 'alert')).resolves.toBeUndefined();
    expect(sent).toEqual(['delivered']);
  });

  it('throws before sending when the client has no bot token or bound chat', async () => {
    const { svc, sent, created } = make();
    const orphan = { id: 'c2', telegramBotTokenEnc: null, telegramChatId: null } as unknown as Client;
    await expect(svc.send(orphan, 'x', 'chat')).rejects.toThrow(/bot token|bound chat/);
    expect(sent).toEqual([]);
    expect(created).toEqual([]);
  });
});
