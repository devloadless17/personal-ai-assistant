import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
// Single source of truth for the health contract — shared with the dashboard.
import type { HealthReport } from '@assistant/shared';
import { PrismaService } from '../prisma/prisma.service';

// Container healthchecks poll this — never rate-limit them.
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Deep health check: proves the process is up AND the database round-trip
   * works. Returns 503 (not a fake 200) if the DB is unreachable — honest
   * failure is a project-wide rule.
   */
  @Get()
  async check(): Promise<HealthReport> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({ status: 'error', db: 'down' });
    }
    return { status: 'ok', db: 'up', timestamp: new Date().toISOString() };
  }
}
