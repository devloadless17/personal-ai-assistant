import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Single PrismaClient for the whole app, connected on boot and cleanly
 * disconnected on shutdown.
 *
 * NOTE: tools and tenant-facing code must NOT inject this directly — they go
 * through the tenancy layer (ClientScopedRepository, Milestone 2) so every
 * query is provably scoped to one clientId.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
