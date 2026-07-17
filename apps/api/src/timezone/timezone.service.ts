import { Injectable, Logger } from '@nestjs/common';
import type { Client } from '@prisma/client';
import { GoogleCalendarGateway } from '../integrations/google/google-calendar.gateway';
import { GoogleOAuthService } from '../integrations/google/google-oauth.service';
import { PrismaService } from '../prisma/prisma.service';
import { isValidTimezone } from '../tools/time';

/** Don't re-hit Google more than once per client per this window (opportunistic
 * per-message sync); the hourly sweep always clears it. */
const SYNC_THROTTLE_MS = 15 * 60_000;
/** Hard cap on the Google read so timezone sync never stalls message handling. */
const GOOGLE_READ_TIMEOUT_MS = 3_000;

/** Outcome of a sync. `switched` = the effective timezone actually changed and
 * the caller should tell the client. */
export type TimezoneSyncResult =
  | { synced: false }
  | { synced: true; switched: false }
  | { synced: true; switched: true; from: string; to: string };

/**
 * Keeps `client.timezone` accurate for travelers by reading the timezone Google
 * Calendar reports (Google auto-updates it from the user's phone). The single
 * place the "did they move?" decision is made — see sync() for the exact rule
 * and the bugs each clause prevents.
 *
 * Best-effort throughout: any failure (Google down, revoked, not connected)
 * no-ops and leaves the current timezone untouched.
 */
@Injectable()
export class TimezoneService {
  private readonly logger = new Logger(TimezoneService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly oauth: GoogleOAuthService,
  ) {}

  /**
   * Reconcile `client.timezone` with the client's Google Calendar timezone.
   *
   * Rule (each clause fixes a real bug):
   * - ALWAYS advance `googleTimezone` (even pinned / no-switch) → a move is
   *   detected exactly once, never re-announced every tick.
   * - First sync (googleTimezone null) captures a baseline only — no switch, no
   *   announce → deploy day never mass-switches admin-set zones.
   * - Switch only on a real move, when not pinned, and when it differs.
   * - Optimistic guard on `lastTimezoneSyncAt` → cron / per-message / tool
   *   writes can't clobber each other; a lost race reconciles next tick.
   */
  async sync(client: Client): Promise<TimezoneSyncResult> {
    // Throttle opportunistic calls; the hourly sweep is always past the window.
    if (
      client.lastTimezoneSyncAt &&
      Date.now() - client.lastTimezoneSyncAt.getTime() < SYNC_THROTTLE_MS
    ) {
      return { synced: false };
    }

    let googleTz: string | null;
    try {
      googleTz = await this.readGoogleTimezone(client);
    } catch (err) {
      // Revoked/expired consent is already flagged by authorizedClientFor; any
      // other error is transient. Never let it break the caller.
      this.logger.debug(
        `Timezone sync skipped for client ${client.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.touchSyncedAt(client);
      return { synced: false };
    }

    if (!googleTz || !isValidTimezone(googleTz)) {
      // Not connected, unreadable, or junk value → record the attempt so a flaky
      // Google isn't hammered per message, and leave the timezone untouched.
      await this.touchSyncedAt(client);
      return { synced: false };
    }

    const firstSync = client.googleTimezone == null;
    const moved = !firstSync && googleTz !== client.googleTimezone;
    const switchable = moved && !client.timezonePinned && googleTz !== client.timezone;

    const now = new Date();
    const data: Record<string, unknown> = { lastTimezoneSyncAt: now };
    // Only TRACK Google's zone while NOT pinned. If we advanced googleTimezone
    // while pinned, then after the client unpins, googleTz would already equal
    // googleTimezone → no "move" detected → they'd stay frozen on the old zone.
    // Freezing googleTimezone at the pre-pin value means the first sync AFTER an
    // unpin sees the divergence and switches them to their real location.
    if (!client.timezonePinned) data.googleTimezone = googleTz;
    if (switchable) {
      data.timezone = googleTz;
      data.timezoneSource = 'google';
      data.timezoneUpdatedAt = now;
    }

    const { count } = await this.prisma.client.updateMany({
      where: { id: client.id, lastTimezoneSyncAt: client.lastTimezoneSyncAt },
      data,
    });
    if (count === 0) return { synced: false }; // another writer won; reconciles next tick

    if (switchable) {
      this.logger.log(`Client ${client.id} timezone auto-switched ${client.timezone} → ${googleTz}`);
      return { synced: true, switched: true, from: client.timezone, to: googleTz };
    }
    return { synced: true, switched: false };
  }

  /**
   * Read the client's Google Calendar timezone (null if not connected /
   * unreadable). Isolated as the single Google-I/O seam so sync()'s
   * reconciliation rule is unit-testable without real googleapis.
   */
  protected async readGoogleTimezone(client: Client): Promise<string | null> {
    const auth = await this.oauth.authorizedClientFor(client);
    if (!auth) return null; // not connected → conversational path only
    const gateway = new GoogleCalendarGateway(auth, client.timezone);
    return this.withTimeout(gateway.getUserTimezone());
  }

  /** Advance the throttle marker (guarded) after a failed/empty read. */
  private async touchSyncedAt(client: Client): Promise<void> {
    try {
      await this.prisma.client.updateMany({
        where: { id: client.id, lastTimezoneSyncAt: client.lastTimezoneSyncAt },
        data: { lastTimezoneSyncAt: new Date() },
      });
    } catch {
      // best-effort only
    }
  }

  private async withTimeout<T>(p: Promise<T>): Promise<T | null> {
    return Promise.race([
      p,
      new Promise<null>((resolve) => {
        setTimeout(() => {
          resolve(null);
        }, GOOGLE_READ_TIMEOUT_MS);
      }),
    ]);
  }
}
