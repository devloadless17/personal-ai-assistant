import { Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import type { Env } from '../config/env.validation';

/** A valid bcrypt(cost 12) hash of a random string. Compared against on the
 * unknown-email login path so a real bcrypt op runs either way (constant-shape
 * timing → no admin-email enumeration). It matches no real password. */
const DUMMY_BCRYPT_HASH = '$2b$12$NZBbMyD73mmcBmQ3.dP.0eDgb0cVsU2ttsvu6k.Oc9BFGKmfhdwWy';

export interface AdminJwtPayload {
  sub: string;
  // Distinguishes admin tokens from client-portal tokens. Both are signed
  // with the same JWT_SECRET, so WITHOUT this discriminator a client's portal
  // token would pass admin verification — a privilege-escalation hole. Both
  // guards enforce their own type.
  type: 'admin';
  email: string;
}

/**
 * Dashboard admin authentication.
 *
 * Bootstrap: if no admin exists and ADMIN_EMAIL/ADMIN_PASSWORD are set, the
 * first admin is created at boot (password bcrypt-hashed) — no manual seeding
 * step, no default credentials ever.
 */
@Injectable()
export class AdminAuthService implements OnModuleInit {
  private readonly logger = new Logger(AdminAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async onModuleInit(): Promise<void> {
    const count = await this.prisma.adminUser.count();
    if (count > 0) return;
    const email = this.config.get('ADMIN_EMAIL', { infer: true });
    const password = this.config.get('ADMIN_PASSWORD', { infer: true });
    if (!email || !password) {
      this.logger.warn(
        'No admin user exists and ADMIN_EMAIL/ADMIN_PASSWORD are unset — dashboard login is impossible until they are provided.',
      );
      return;
    }
    await this.prisma.adminUser.create({
      data: { email, passwordHash: await hash(password, 12) },
    });
    this.logger.log(`Bootstrapped admin user ${email}`);
  }

  async login(email: string, password: string): Promise<{ token: string }> {
    const admin = await this.prisma.adminUser.findUnique({ where: { email } });
    // Constant-SHAPE flow: run a real bcrypt compare even for an unknown email
    // (against a fixed dummy hash) so response time doesn't reveal whether an
    // admin email exists (user enumeration). Both branches do one bcrypt op.
    const ok = await compare(password, admin?.passwordHash ?? DUMMY_BCRYPT_HASH);
    if (!admin || !ok) throw new UnauthorizedException('Invalid email or password');

    const payload: AdminJwtPayload = { sub: admin.id, type: 'admin', email: admin.email };
    return { token: await this.jwt.signAsync(payload) };
  }

  async verify(token: string): Promise<AdminJwtPayload> {
    // The decoded claims are untrusted — type them loosely and validate.
    let raw: { sub?: unknown; type?: unknown; email?: unknown };
    try {
      // Pin the algorithm — never accept anything but the HS256 we signed with.
      raw = await this.jwt.verifyAsync(token, { algorithms: ['HS256'] });
    } catch {
      throw new UnauthorizedException('Invalid or expired session');
    }
    // Reject anything that isn't an admin token (e.g. a client-portal token
    // signed with the same secret). Prevents cross-role privilege escalation.
    if (raw.type !== 'admin' || typeof raw.sub !== 'string' || typeof raw.email !== 'string') {
      throw new UnauthorizedException('Not an admin session');
    }
    return { sub: raw.sub, type: 'admin', email: raw.email };
  }
}
