import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ClientAuthService } from './client-auth.service';
import type { ClientJwtPayload } from './client-auth.service';

/** Request augmented with the authenticated client's payload. */
export interface ClientRequest extends Request {
  client: ClientJwtPayload;
}

/**
 * Guards client-portal routes. Verifies the client token and attaches the
 * clientId to the request. Because every downstream query is scoped by this
 * clientId, a client can only ever touch their own data.
 */
@Injectable()
export class ClientAuthGuard implements CanActivate {
  constructor(private readonly auth: ClientAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ClientRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    req.client = await this.auth.verify(header.slice('Bearer '.length));
    return true;
  }
}
