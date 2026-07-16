import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { ClientAuthService } from './client-auth.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { GoogleOAuthService } from '../integrations/google/google-oauth.service';

/**
 * Proves the client/admin token boundary: a client token carries type:'client'
 * and verify() rejects anything else — so an admin token (type absent/other)
 * can never authenticate a client route.
 */
describe('ClientAuthService — token isolation', () => {
  const jwt = new JwtService({ secret: 'test-secret-at-least-32-chars-long!!' });
  const prisma = {
    findFirst: jest.fn(),
  } as unknown as PrismaService;
  const google = {} as GoogleOAuthService;

  function svc(): ClientAuthService {
    return new ClientAuthService(prisma, jwt, google);
  }

  it('accepts a genuine client token', async () => {
    const token = await jwt.signAsync({ sub: 'c1', type: 'client', email: 'a@b.com' });
    const payload = await svc().verify(token);
    expect(payload.sub).toBe('c1');
  });

  it('rejects an admin-shaped token (no client type)', async () => {
    const adminToken = await jwt.signAsync({ sub: 'admin1', email: 'admin@x.com' });
    await expect(svc().verify(adminToken)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a token with a wrong type claim', async () => {
    const token = await jwt.signAsync({ sub: 'c1', type: 'something-else', email: 'a@b.com' });
    await expect(svc().verify(token)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a garbage token', async () => {
    await expect(svc().verify('not-a-jwt')).rejects.toThrow(UnauthorizedException);
  });
});
