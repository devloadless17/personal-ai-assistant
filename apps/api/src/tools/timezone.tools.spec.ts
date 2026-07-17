import type { Client } from '@prisma/client';
import { setTimezone } from './timezone.tools';
import type { ToolContext } from './tool.types';
import type { ClientScopedRepository } from '../tenancy/client-scoped-repository';

function ctxFor(clientOver: Partial<Client> = {}): {
  ctx: ToolContext;
  calls: { method: string; args: unknown[] }[];
} {
  const calls: { method: string; args: unknown[] }[] = [];
  const repo = {
    setTimezone: jest.fn((...args: unknown[]) => {
      calls.push({ method: 'setTimezone', args });
      return Promise.resolve();
    }),
    setTimezonePinned: jest.fn((...args: unknown[]) => {
      calls.push({ method: 'setTimezonePinned', args });
      return Promise.resolve();
    }),
  } as unknown as ClientScopedRepository;
  const client = {
    id: 'c1',
    timezone: 'Asia/Beirut',
    homeTimezone: 'Asia/Beirut',
    timezonePinned: false,
    ...clientOver,
  } as Client;
  return { ctx: { repo, client, now: new Date('2026-07-17T09:00:00Z') }, calls };
}

describe('set_timezone tool', () => {
  it('rejects an invalid IANA zone and changes nothing', async () => {
    const { ctx, calls } = ctxFor();
    const res = await setTimezone.execute({ timezone: 'Mars/Olympus' }, ctx);
    expect(res).toContain('ERROR');
    expect(calls).toHaveLength(0);
    expect(ctx.client.timezone).toBe('Asia/Beirut'); // unchanged
  });

  it('sets a valid zone and MUTATES ctx.client in-turn (so later anchoring uses it)', async () => {
    const { ctx, calls } = ctxFor();
    const res = await setTimezone.execute({ timezone: 'Asia/Tokyo' }, ctx);
    expect(calls[0]).toMatchObject({ method: 'setTimezone', args: ['Asia/Tokyo', { setAsHome: undefined }] });
    expect(ctx.client.timezone).toBe('Asia/Tokyo'); // in-turn mutation
    expect(ctx.client.timezoneSource).toBe('manual');
    expect(res).toContain('Asia/Tokyo');
  });

  it('set_as_home updates the home zone in-turn', async () => {
    const { ctx } = ctxFor();
    await setTimezone.execute({ timezone: 'Asia/Dubai', set_as_home: true }, ctx);
    expect(ctx.client.homeTimezone).toBe('Asia/Dubai');
  });

  it('pin stops auto-following', async () => {
    const { ctx, calls } = ctxFor();
    await setTimezone.execute({ timezone: 'Asia/Beirut', pin: true }, ctx);
    expect(calls.some((c) => c.method === 'setTimezonePinned' && c.args[0] === true)).toBe(true);
    expect(ctx.client.timezonePinned).toBe(true);
  });
});
