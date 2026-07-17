import type { Client } from '@prisma/client';
import { TimezoneService } from './timezone.service';
import type { GoogleOAuthService } from '../integrations/google/google-oauth.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * The travel-detection reconciliation rule is the riskiest logic in the
 * timezone system — these tests pin each clause against the specific bug it
 * prevents (re-announce-when-pinned, first-sync mass-switch, manual override).
 */
function makeClient(over: Partial<Client> = {}): Client {
  return {
    id: 'c1',
    timezone: 'Asia/Beirut',
    homeTimezone: 'Asia/Beirut',
    googleTimezone: null,
    timezonePinned: false,
    timezoneSource: null,
    timezoneUpdatedAt: null,
    lastTimezoneSyncAt: null,
    ...over,
  } as Client;
}

/** A TimezoneService with the Google I/O seam and DB stubbed. */
function makeService(googleTz: string | null): {
  service: TimezoneService;
  updates: { where: Record<string, unknown>; data: Record<string, unknown> }[];
} {
  const updates: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
  const prisma = {
    client: {
      updateMany: jest.fn().mockImplementation((args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updates.push(args);
        return Promise.resolve({ count: 1 });
      }),
    },
  } as unknown as PrismaService;
  const oauth = {} as unknown as GoogleOAuthService;
  const service = new TimezoneService(prisma, oauth);
  // Stub the single Google-I/O seam.
  jest
    .spyOn(service as unknown as { readGoogleTimezone: () => Promise<string | null> }, 'readGoogleTimezone')
    .mockResolvedValue(googleTz);
  return { service, updates };
}

describe('TimezoneService.sync — travel reconciliation rule', () => {
  it('FIRST sync captures a baseline only — never switches or announces', async () => {
    // googleTimezone null → first read. Even though Google (Tokyo) differs from
    // the admin-set zone (Beirut), we must NOT switch on deploy day.
    const { service, updates } = makeService('Asia/Tokyo');
    const res = await service.sync(makeClient({ googleTimezone: null, timezone: 'Asia/Beirut' }));
    expect(res).toEqual({ synced: true, switched: false });
    expect(updates[0]?.data).toMatchObject({ googleTimezone: 'Asia/Tokyo' });
    expect(updates[0]?.data).not.toHaveProperty('timezone'); // no switch
  });

  it('a real move (googleTimezone changed) switches and reports it', async () => {
    const { service, updates } = makeService('Asia/Tokyo');
    const res = await service.sync(
      makeClient({ googleTimezone: 'Asia/Beirut', timezone: 'Asia/Beirut' }),
    );
    expect(res).toEqual({ synced: true, switched: true, from: 'Asia/Beirut', to: 'Asia/Tokyo' });
    expect(updates[0]?.data).toMatchObject({
      googleTimezone: 'Asia/Tokyo',
      timezone: 'Asia/Tokyo',
      timezoneSource: 'google',
    });
  });

  it('PINNED: does NOT switch AND does NOT advance googleTimezone (so unpin later reconciles)', async () => {
    // Freezing googleTimezone while pinned is what lets a later unpin detect the
    // divergence and switch the traveler to their real zone.
    const { service, updates } = makeService('Asia/Tokyo');
    const pinned = makeClient({
      googleTimezone: 'Asia/Beirut',
      timezone: 'Asia/Beirut',
      timezonePinned: true,
    });
    const res = await service.sync(pinned);
    expect(res).toEqual({ synced: true, switched: false });
    expect(updates[0]?.data).not.toHaveProperty('timezone'); // pinned → no switch
    expect(updates[0]?.data).not.toHaveProperty('googleTimezone'); // frozen while pinned
  });

  it('after unpin, the next sync switches the traveler to their real (Google) zone', async () => {
    // Pinned froze googleTimezone at Beirut; client is really in Tokyo and unpins.
    const { service, updates } = makeService('Asia/Tokyo');
    const res = await service.sync(
      makeClient({ googleTimezone: 'Asia/Beirut', timezone: 'Asia/Beirut', timezonePinned: false }),
    );
    expect(res).toEqual({ synced: true, switched: true, from: 'Asia/Beirut', to: 'Asia/Tokyo' });
    expect(updates[0]?.data).toMatchObject({ timezone: 'Asia/Tokyo', googleTimezone: 'Asia/Tokyo' });
  });

  it('does NOT revert a manual override while Google reports the same old zone', async () => {
    // Client manually set Dubai; Google still says Beirut (phone auto-tz off).
    // googleTimezone(Beirut) == last read(Beirut) → no move → manual Dubai stays.
    const { service, updates } = makeService('Asia/Beirut');
    const res = await service.sync(
      makeClient({ googleTimezone: 'Asia/Beirut', timezone: 'Asia/Dubai', timezoneSource: 'manual' }),
    );
    expect(res).toEqual({ synced: true, switched: false });
    expect(updates[0]?.data).not.toHaveProperty('timezone');
  });

  it('no-ops when not connected / unreadable (null) without touching timezone', async () => {
    const { service, updates } = makeService(null);
    const res = await service.sync(makeClient({ googleTimezone: 'Asia/Beirut' }));
    expect(res).toEqual({ synced: false });
    // Only the throttle marker is touched, never the timezone.
    for (const u of updates) expect(u.data).not.toHaveProperty('timezone');
  });

  it('throttles: a very recent sync is skipped entirely', async () => {
    const { service, updates } = makeService('Asia/Tokyo');
    const res = await service.sync(
      makeClient({ googleTimezone: 'Asia/Beirut', lastTimezoneSyncAt: new Date() }),
    );
    expect(res).toEqual({ synced: false });
    expect(updates).toHaveLength(0); // no DB write at all
  });

  it('ignores a junk (non-IANA) Google value', async () => {
    const { service, updates } = makeService('Not/AZone');
    const res = await service.sync(makeClient({ googleTimezone: 'Asia/Beirut' }));
    expect(res).toEqual({ synced: false });
    for (const u of updates) expect(u.data).not.toHaveProperty('timezone');
  });

  it('guards the write with the expected lastTimezoneSyncAt (compare-and-set)', async () => {
    const stamp = new Date('2020-01-01T00:00:00Z'); // far past → clears throttle
    const { service, updates } = makeService('Asia/Tokyo');
    await service.sync(
      makeClient({ googleTimezone: 'Asia/Beirut', lastTimezoneSyncAt: stamp }),
    );
    // The write is conditioned on the exact prior stamp (compare-and-set).
    expect(updates[0]?.where).toMatchObject({ id: 'c1', lastTimezoneSyncAt: stamp });
  });
});
