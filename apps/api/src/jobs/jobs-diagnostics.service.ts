import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DailyBriefJob } from './daily-brief.job';
import { ReminderJob } from './reminder.job';

export interface JobsDiagnostics {
  serverTime: string;
  reminder: {
    running: boolean; // ticked within the last ~2 minutes?
    lastTickAt: string | null;
    secondsSinceLastTick: number | null;
    totalTicks: number;
    lastDueCount: number;
    lastSentCount: number;
    lastError: string | null;
  };
  dailyBrief: {
    running: boolean; // ticked within the last ~11 minutes (runs every 10)?
    lastTickAt: string | null;
    secondsSinceLastTick: number | null;
    totalTicks: number;
    lastSentCount: number;
    lastError: string | null;
    clients: {
      name: string;
      timezone: string;
      dailyBriefHour: number;
      lastBriefDate: string | null;
      chatBound: boolean;
    }[];
  };
  backlog: {
    overdueUnsent: number; // reminders past due but not yet delivered — should be ~0
    recent: {
      title: string;
      client: string;
      reminderAt: string;
      reminderSent: boolean;
      overdueSeconds: number;
    }[];
  };
}

/**
 * Live health of the background jobs, surfaced via GET /admin/diagnostics so
 * production cron behaviour is observable from the dashboard/API — no SSH
 * needed. If `reminder.running` is false, the cron isn't ticking; if
 * `backlog.overdueUnsent` grows, deliveries are failing.
 */
@Injectable()
export class JobsDiagnosticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reminder: ReminderJob,
    private readonly brief: DailyBriefJob,
  ) {}

  async get(): Promise<JobsDiagnostics> {
    const now = new Date();
    const lastTick = this.reminder.lastTickAt;
    const secondsSinceLastTick = lastTick
      ? Math.round((now.getTime() - lastTick.getTime()) / 1000)
      : null;

    const briefTick = this.brief.lastTickAt;
    const briefSince = briefTick ? Math.round((now.getTime() - briefTick.getTime()) / 1000) : null;
    const briefClients = await this.prisma.client.findMany({
      where: { status: 'active' },
      select: {
        name: true,
        timezone: true,
        dailyBriefHour: true,
        lastBriefDate: true,
        telegramChatId: true,
      },
    });

    const overdueUnsent = await this.prisma.task.count({
      where: {
        reminderSent: false,
        reminderAt: { lte: now, not: null },
        status: 'open',
        client: { status: 'active', telegramChatId: { not: null } },
      },
    });

    const recentRows = await this.prisma.task.findMany({
      where: { reminderAt: { not: null } },
      include: { client: { select: { name: true } } },
      orderBy: { reminderAt: 'desc' },
      take: 15,
    });

    return {
      serverTime: now.toISOString(),
      reminder: {
        running: secondsSinceLastTick !== null && secondsSinceLastTick < 125,
        lastTickAt: lastTick?.toISOString() ?? null,
        secondsSinceLastTick,
        totalTicks: this.reminder.ticks,
        lastDueCount: this.reminder.lastDueCount,
        lastSentCount: this.reminder.lastSentCount,
        lastError: this.reminder.lastError,
      },
      dailyBrief: {
        running: briefSince !== null && briefSince < 11 * 60,
        lastTickAt: briefTick?.toISOString() ?? null,
        secondsSinceLastTick: briefSince,
        totalTicks: this.brief.ticks,
        lastSentCount: this.brief.lastSentCount,
        lastError: this.brief.lastError,
        clients: briefClients.map((c) => ({
          name: c.name,
          timezone: c.timezone,
          dailyBriefHour: c.dailyBriefHour,
          lastBriefDate: c.lastBriefDate,
          chatBound: c.telegramChatId !== null,
        })),
      },
      backlog: {
        overdueUnsent,
        recent: recentRows.map((t) => ({
          title: t.title,
          client: t.client.name,
          reminderAt: (t.reminderAt as Date).toISOString(),
          reminderSent: t.reminderSent,
          overdueSeconds: Math.round((now.getTime() - (t.reminderAt as Date).getTime()) / 1000),
        })),
      },
    };
  }
}
