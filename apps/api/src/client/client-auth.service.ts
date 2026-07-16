import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { GoogleOAuthService } from '../integrations/google/google-oauth.service';
import { PrismaService } from '../prisma/prisma.service';

/** Payload carried in a client-portal session token. */
export interface ClientJwtPayload {
  sub: string; // clientId
  type: 'client'; // distinguishes from admin tokens — a client token can
  // NEVER be used on admin routes and vice-versa (guards check the type).
  email: string;
}

/**
 * Client-portal authentication via "Sign in with Google".
 *
 * A client can log in only if the admin has assigned their Gmail to a client
 * record (no open sign-up). One Google consent proves identity AND grants
 * calendar access. The issued token is scoped to that one clientId, so the
 * tenancy layer confines the client to strictly their own data.
 */
@Injectable()
export class ClientAuthService {
  private readonly logger = new Logger(ClientAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly google: GoogleOAuthService,
  ) {}

  /** The Google URL the client's browser opens to sign in. */
  buildLoginUrl(): string {
    return this.google.buildClientLoginUrl();
  }

  /**
   * Handles the Google callback: verifies the identity, matches the email to
   * an active client, stores any fresh calendar tokens, and returns a session
   * token. Throws (honestly) when the email has no assigned account.
   */
  async completeLogin(code: string, state: string): Promise<{ token: string; clientName: string }> {
    const { email, bundle } = await this.google.verifyClientLogin(code, state);

    const client = await this.prisma.client.findFirst({
      where: { email, status: 'active' },
    });
    if (!client) {
      this.logger.warn(`Portal login rejected for ${email}: no active client with that email`);
      throw new UnauthorizedException(
        'No assistant account is linked to this Google account. Ask your administrator to add you.',
      );
    }

    // First consent returns a refresh token → persist calendar access.
    if (bundle) await this.google.persistTokensForClient(client.id, bundle);

    const payload: ClientJwtPayload = { sub: client.id, type: 'client', email };
    const token = await this.jwt.signAsync(payload);
    this.logger.log(`Client ${client.id} logged into the portal`);
    return { token, clientName: client.name };
  }

  async verify(token: string): Promise<ClientJwtPayload> {
    // The decoded claims are untrusted — type them loosely and validate.
    let raw: { sub?: unknown; type?: unknown; email?: unknown };
    try {
      raw = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired session');
    }
    if (raw.type !== 'client' || typeof raw.sub !== 'string' || typeof raw.email !== 'string') {
      throw new UnauthorizedException('Not a client session');
    }
    return { sub: raw.sub, type: 'client', email: raw.email };
  }
}
