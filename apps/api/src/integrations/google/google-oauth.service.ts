import { randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { CryptoService } from '../../crypto/crypto.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { Env } from '../../config/env.validation';

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

/** What we persist (encrypted) per client. */
const tokenBundleSchema = z.object({
  refresh_token: z.string(),
  access_token: z.string().optional(),
  expiry_date: z.number().optional(),
});
export type GoogleTokenBundle = z.infer<typeof tokenBundleSchema>;

/**
 * Per-client Google OAuth2.
 *
 * Flow: admin generates a connect link for a client → client signs in with
 * their Google account and consents → callback stores the encrypted token
 * bundle. Access tokens are refreshed automatically before every calendar
 * call; a permanently failed refresh flags `googleNeedsReauth` and is
 * surfaced honestly — never a silent failure.
 *
 * The OAuth `state` parameter is a signed one-time value bound to the
 * clientId, so a callback can never attach tokens to the wrong client.
 */
@Injectable()
export class GoogleOAuthService {
  private readonly logger = new Logger(GoogleOAuthService.name);
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly redirectUri?: string;
  /** state → { clientId, expires } (one-time, 15 min TTL). */
  private readonly pendingStates = new Map<string, { clientId: string; expires: number }>();

  constructor(
    config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {
    this.clientId = config.get('GOOGLE_CLIENT_ID', { infer: true });
    this.clientSecret = config.get('GOOGLE_CLIENT_SECRET', { infer: true });
    this.redirectUri = config.get('GOOGLE_REDIRECT_URI', { infer: true });
    if (!this.isConfigured) {
      this.logger.warn('Google OAuth not configured — calendar features disabled until it is.');
    }
  }

  get isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret && this.redirectUri);
  }

  private newOAuthClient(): OAuth2Client {
    if (!this.isConfigured) {
      throw new Error('Google OAuth is not configured (GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI).');
    }
    return new google.auth.OAuth2(this.clientId, this.clientSecret, this.redirectUri);
  }

  /** Admin-triggered: the URL the client opens to authorize their calendar. */
  buildConnectUrl(clientId: string): string {
    const oauth = this.newOAuthClient();
    const state = randomBytes(24).toString('hex');
    this.pendingStates.set(state, { clientId, expires: Date.now() + 15 * 60_000 });
    this.gcStates();
    return oauth.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent', // always get a refresh_token
      scope: SCOPES,
      state,
    });
  }

  /** OAuth callback: exchanges the code and stores the encrypted bundle. */
  async handleCallback(code: string, state: string): Promise<{ clientId: string }> {
    const pending = this.pendingStates.get(state);
    this.pendingStates.delete(state); // one-time use
    if (!pending || pending.expires < Date.now()) {
      throw new Error('Invalid or expired OAuth state — restart the connection from the dashboard.');
    }

    const oauth = this.newOAuthClient();
    const { tokens } = await oauth.getToken(code);
    if (!tokens.refresh_token) {
      throw new Error('Google did not return a refresh token — remove the app from the Google account\'s third-party access and try again.');
    }

    const bundle: GoogleTokenBundle = {
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token ?? undefined,
      expiry_date: tokens.expiry_date ?? undefined,
    };
    await this.prisma.client.update({
      where: { id: pending.clientId },
      data: {
        googleOAuthEnc: this.crypto.encrypt(JSON.stringify(bundle)),
        googleNeedsReauth: false,
      },
    });
    this.logger.log(`Google Calendar connected for client ${pending.clientId}`);
    return { clientId: pending.clientId };
  }

  /**
   * Authorized OAuth2 client for a connected client, refreshing and
   * re-persisting the access token as needed. Returns null if not connected.
   * Flags needs-reauth (and throws) when the grant is revoked/expired.
   */
  async authorizedClientFor(client: {
    id: string;
    googleOAuthEnc: string | null;
  }): Promise<OAuth2Client | null> {
    if (!client.googleOAuthEnc || !this.isConfigured) return null;

    const bundle = tokenBundleSchema.parse(
      JSON.parse(this.crypto.decrypt(client.googleOAuthEnc)),
    );
    const oauth = this.newOAuthClient();
    oauth.setCredentials(bundle);

    // Refresh proactively when missing/near expiry (60s slack).
    const needsRefresh =
      !bundle.access_token || !bundle.expiry_date || bundle.expiry_date < Date.now() + 60_000;
    if (needsRefresh) {
      try {
        const { credentials } = await oauth.refreshAccessToken();
        const updated: GoogleTokenBundle = {
          refresh_token: credentials.refresh_token ?? bundle.refresh_token,
          access_token: credentials.access_token ?? undefined,
          expiry_date: credentials.expiry_date ?? undefined,
        };
        oauth.setCredentials(updated);
        await this.prisma.client.update({
          where: { id: client.id },
          data: { googleOAuthEnc: this.crypto.encrypt(JSON.stringify(updated)) },
        });
      } catch (err) {
        // invalid_grant = revoked/expired consent → needs re-auth, say so.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('invalid_grant')) {
          await this.prisma.client.update({
            where: { id: client.id },
            data: { googleNeedsReauth: true },
          });
          this.logger.warn(`Client ${client.id}: Google grant revoked — flagged needs-reauth`);
          throw new Error(
            'Google Calendar access was revoked or expired — the client must reconnect their calendar.',
          );
        }
        throw err;
      }
    }
    return oauth;
  }

  private gcStates(): void {
    const now = Date.now();
    for (const [state, entry] of this.pendingStates) {
      if (entry.expires < now) this.pendingStates.delete(state);
    }
  }
}
