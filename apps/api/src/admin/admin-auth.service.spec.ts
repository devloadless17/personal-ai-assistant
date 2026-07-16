import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminAuthService } from './admin-auth.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Proves the admin/client token boundary from the ADMIN side: an admin token
 * carries type:'admin' and verify() rejects anything else — so a client-portal
 * token (same JWT_SECRET, type:'client') can NEVER authenticate an admin route.
 * This is the counterpart to client-auth.service.spec.ts.
 */
describe('AdminAuthService — token isolation', () => {
  const jwt = new JwtService({ secret: 'test-secret-at-least-32-chars-long!!' });
  const prisma = {} as PrismaService;
  const config = {} as ConfigService<never, true>;

  function svc(): AdminAuthService {
    return new AdminAuthService(prisma, jwt, config);
  }

  it('accepts a genuine admin token', async () => {
    const token = await jwt.signAsync({ sub: 'admin1', type: 'admin', email: 'admin@x.com' });
    const payload = await svc().verify(token);
    expect(payload.sub).toBe('admin1');
  });

  it('REJECTS a client-portal token on admin verification (no privilege escalation)', async () => {
    const clientToken = await jwt.signAsync({ sub: 'c1', type: 'client', email: 'c@x.com' });
    await expect(svc().verify(clientToken)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a token with no type claim (legacy/forged)', async () => {
    const token = await jwt.signAsync({ sub: 'x', email: 'x@x.com' });
    await expect(svc().verify(token)).rejects.toThrow(UnauthorizedException);
  });
});
