import { Injectable } from '@nestjs/common';
import type { Client } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ClientScopedRepository } from './client-scoped-repository';

/** Creates tenant-scoped repositories and resolves active clients. */
@Injectable()
export class TenancyService {
  constructor(private readonly prisma: PrismaService) {}

  repoFor(clientId: string): ClientScopedRepository {
    return new ClientScopedRepository(this.prisma, clientId);
  }

  /** Loads a client only if it exists AND is active. */
  async getActiveClient(clientId: string): Promise<Client | null> {
    return this.prisma.client.findFirst({
      where: { id: clientId, status: 'active' },
    });
  }
}
