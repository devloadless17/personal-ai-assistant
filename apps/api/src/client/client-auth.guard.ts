import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { TenancyService } from '../tenancy/tenancy.service';
import { ClientAuthService } from './client-auth.service';
import type { ClientJwtPayload } from './client-auth.service';

/** Request augmented with the authenticated client's payload. */
export interface ClientRequest extends Request {
  client: ClientJwtPayload;
}

/**
 * Guards client-portal routes. Verifies the client token AND re-checks that
 * the client is still active on every request — a long-lived token must not
 * outlive a disabled account. Because every downstream query is scoped by the
 * token's clientId, a client can only ever touch their own data.
 */
@Injectable()
export class ClientAuthGuard implements CanActivate {
  constructor(
    private readonly auth: ClientAuthService,
    private readonly tenancy: TenancyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ClientRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const payload = await this.auth.verify(header.slice('Bearer '.length));
    // Freshness check: a token issued before the admin disabled this client
    // must stop working immediately — not at the 30-day expiry.
    const client = await this.tenancy.getActiveClient(payload.sub);
    if (!client) throw new UnauthorizedException('This account is no longer active');
    req.client = payload;
    return true;
  }
}
