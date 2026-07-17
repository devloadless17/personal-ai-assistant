import type {
  Prisma,
  PrismaClient,
  Task,
  Memory,
  Message,
  AuditLog,
  RecurrenceFreq,
  MemoryCategory,
} from '@prisma/client';

/** Dedupe, positives only, sorted earliest-ping-first — the ONE normalization
 * for a client's reminder lead list, reused by the repo, admin API and portal. */
export function normalizeReminderLeads(leads: number[]): number[] {
  return Array.from(new Set(leads.filter((n) => Number.isInteger(n) && n > 0))).sort((a, b) => b - a);
}

/**
 * THE tenant-isolation choke point.
 *
 * Tools and tenant-facing code never see a raw PrismaClient — they receive a
 * ClientScopedRepository bound to exactly one clientId. Every query below
 * injects that clientId into the WHERE clause (mutations match `id AND
 * clientId`), so reading or writing another tenant's rows is impossible to
 * express through this API. Mutations report affected rows: a 0-row update
 * surfaces as "not found" — never a silent no-op.
 */
export class ClientScopedRepository {
  constructor(
    private readonly prisma: PrismaClient,
    readonly clientId: string,
  ) {}

  // ── Tasks ──────────────────────────────────────────────────────────────────

  /**
   * Windowed task query — there is deliberately NO "fetch all" variant.
   * Defaults: open tasks. Callers pass a time window; results are capped.
   */
  async findTasks(params: {
    status?: 'open' | 'done';
    dueFrom?: Date;
    dueTo?: Date;
    includeUndated?: boolean;
    limit?: number;
  }): Promise<{ tasks: Task[]; more: number }> {
    const { status = 'open', dueFrom, dueTo, includeUndated = true, limit = 50 } = params;
    const cap = Math.min(Math.max(limit, 1), 100);

    const dueAtRange: Prisma.DateTimeNullableFilter | undefined =
      dueFrom || dueTo ? { gte: dueFrom, lte: dueTo } : undefined;

    const where: Prisma.TaskWhereInput = {
      clientId: this.clientId,
      status,
      // Companion calendar reminders are internal, not user-facing tasks —
      // the meeting itself is shown via the calendar.
      sourceEventId: null,
      ...(dueAtRange
        ? includeUndated
          ? { OR: [{ dueAt: dueAtRange }, { dueAt: null }] }
          : { dueAt: dueAtRange }
        : {}),
    };

    const [tasks, total] = await Promise.all([
      this.prisma.task.findMany({
        where,
        orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
        take: cap,
      }),
      this.prisma.task.count({ where }),
    ]);
    return { tasks, more: Math.max(0, total - tasks.length) };
  }

  async findTaskById(id: string): Promise<Task | null> {
    return this.prisma.task.findFirst({ where: { id, clientId: this.clientId } });
  }

  async createTask(data: {
    title: string;
    type?: 'task' | 'reminder';
    dueAt?: Date | null;
    reminderAt?: Date | null;
    notes?: string | null;
    sourceEventId?: string | null;
    reminderLeadMinutes?: number | null;
    recurrenceFreq?: RecurrenceFreq | null;
    recurrenceInterval?: number | null;
    recurrenceWeekdays?: number[];
    recurrenceUntil?: Date | null;
    recurrenceAnchor?: Date | null;
    recurrenceTimezone?: string | null;
  }): Promise<Task> {
    return this.prisma.task.create({ data: { ...data, clientId: this.clientId } });
  }

  /** Delete the companion reminder(s) for a calendar event, if any. */
  async deleteEventReminders(eventId: string): Promise<void> {
    await this.prisma.task.deleteMany({
      where: { clientId: this.clientId, sourceEventId: eventId },
    });
  }

  /** The lead time of an event's companion reminder, so a move can preserve it. */
  async getEventReminderLead(eventId: string): Promise<number | null> {
    const task = await this.prisma.task.findFirst({
      where: { clientId: this.clientId, sourceEventId: eventId },
      select: { reminderLeadMinutes: true },
    });
    return task?.reminderLeadMinutes ?? null;
  }

  /** The companion reminder's lead + recurrence, so moving a RECURRING meeting
   * can recreate a companion that still recurs (not silently a one-shot). */
  async getEventReminder(eventId: string): Promise<{
    reminderLeadMinutes: number | null;
    recurrenceFreq: RecurrenceFreq | null;
    recurrenceInterval: number | null;
    recurrenceWeekdays: number[];
    recurrenceUntil: Date | null;
  } | null> {
    const t = await this.prisma.task.findFirst({
      where: { clientId: this.clientId, sourceEventId: eventId },
      select: {
        reminderLeadMinutes: true,
        recurrenceFreq: true,
        recurrenceInterval: true,
        recurrenceWeekdays: true,
        recurrenceUntil: true,
      },
    });
    return t ?? null;
  }

  /** ALL companion reminders for an event (a meeting can have several — e.g. an
   * hour before AND ten minutes before). Used to preserve every lead + its
   * recurrence when a meeting is moved. */
  async getEventReminders(eventId: string): Promise<
    {
      reminderLeadMinutes: number | null;
      recurrenceFreq: RecurrenceFreq | null;
      recurrenceInterval: number | null;
      recurrenceWeekdays: number[];
      recurrenceUntil: Date | null;
      recurrenceTimezone: string | null;
    }[]
  > {
    return this.prisma.task.findMany({
      where: { clientId: this.clientId, sourceEventId: eventId },
      select: {
        reminderLeadMinutes: true,
        recurrenceFreq: true,
        recurrenceInterval: true,
        recurrenceWeekdays: true,
        recurrenceUntil: true,
        recurrenceTimezone: true,
      },
    });
  }

  /** Returns the updated task, or null if no row matched (id AND clientId). */
  async updateTask(
    id: string,
    data: Partial<{
      title: string;
      type: 'task' | 'reminder';
      status: 'open' | 'done';
      dueAt: Date | null;
      reminderAt: Date | null;
      reminderSent: boolean;
      notes: string | null;
      recurrenceFreq: RecurrenceFreq | null;
      recurrenceInterval: number | null;
      recurrenceWeekdays: number[];
      recurrenceUntil: Date | null;
      recurrenceAnchor: Date | null;
    }>,
  ): Promise<Task | null> {
    const { count } = await this.prisma.task.updateMany({
      where: { id, clientId: this.clientId },
      data,
    });
    if (count === 0) return null;
    return this.findTaskById(id);
  }

  /** Returns true if a row was deleted, false if nothing matched. */
  async deleteTask(id: string): Promise<boolean> {
    const { count } = await this.prisma.task.deleteMany({
      where: { id, clientId: this.clientId },
    });
    return count > 0;
  }

  // ── Preferences ─────────────────────────────────────────────────────────────

  /** Update the client's default reminder lead time (minutes before due). */
  async setDefaultReminderMinutes(minutes: number): Promise<void> {
    await this.prisma.client.update({
      where: { id: this.clientId },
      data: { defaultReminderMinutes: minutes },
    });
  }

  /** Update the client's daily-summary hour (0–23, their local time). */
  async setDailyBriefHour(hour: number): Promise<void> {
    await this.prisma.client.update({
      where: { id: this.clientId },
      data: { dailyBriefHour: hour },
    });
  }

  /** Set the client's default reminder lead times (minutes before a meeting).
   * Each value = one Telegram ping; [] = no automatic reminders. Normalized. */
  async setReminderLeads(leads: number[]): Promise<void> {
    await this.prisma.client.update({
      where: { id: this.clientId },
      data: { reminderLeads: normalizeReminderLeads(leads) },
    });
  }

  /** Update the client's default meeting/event length (minutes). */
  async setDefaultMeetingMinutes(minutes: number): Promise<void> {
    await this.prisma.client.update({
      where: { id: this.clientId },
      data: { defaultMeetingMinutes: minutes },
    });
  }

  /**
   * Set the client's CURRENT (effective) timezone from a conversational
   * declaration ("I'm in Tokyo"). Marks the source 'manual' and — deliberately —
   * does NOT touch googleTimezone, so a later real Google-detected move still
   * wins. Optionally re-home ("this is home now").
   */
  async setTimezone(timezone: string, opts?: { setAsHome?: boolean }): Promise<void> {
    await this.prisma.client.update({
      where: { id: this.clientId },
      data: {
        timezone,
        timezoneSource: 'manual',
        timezoneUpdatedAt: new Date(),
        ...(opts?.setAsHome ? { homeTimezone: timezone } : {}),
      },
    });
  }

  /** Pin/unpin the client to their current zone (ignore Google auto-sync).
   * Unpinning clears the sync throttle so location-following resumes on the
   * very next message/sweep instead of waiting out the throttle window. */
  async setTimezonePinned(pinned: boolean): Promise<void> {
    await this.prisma.client.update({
      where: { id: this.clientId },
      data: { timezonePinned: pinned, ...(pinned ? {} : { lastTimezoneSyncAt: null }) },
    });
  }

  // ── Memories (client profile/preferences) ──────────────────────────────────

  async getMemories(limit = 100): Promise<Memory[]> {
    return this.prisma.memory.findMany({
      where: { clientId: this.clientId },
      orderBy: { updatedAt: 'desc' },
      take: Math.min(limit, 200),
    });
  }

  async saveMemory(key: string, value: string, category?: MemoryCategory): Promise<Memory> {
    return this.prisma.memory.upsert({
      where: { clientId_key: { clientId: this.clientId, key } },
      create: { clientId: this.clientId, key, value, ...(category ? { category } : {}) },
      update: { value, ...(category ? { category } : {}) },
    });
  }

  async deleteMemory(key: string): Promise<boolean> {
    const { count } = await this.prisma.memory.deleteMany({
      where: { clientId: this.clientId, key },
    });
    return count > 0;
  }

  /** Update a memory's value/category by id (tenant-scoped). Null = not found. */
  async updateMemory(
    id: string,
    data: Partial<{ value: string; category: MemoryCategory }>,
  ): Promise<Memory | null> {
    const { count } = await this.prisma.memory.updateMany({
      where: { id, clientId: this.clientId },
      data,
    });
    if (count === 0) return null;
    return this.prisma.memory.findFirst({ where: { id, clientId: this.clientId } });
  }

  /** Delete a memory by id (tenant-scoped). False if nothing matched. */
  async deleteMemoryById(id: string): Promise<boolean> {
    const { count } = await this.prisma.memory.deleteMany({
      where: { id, clientId: this.clientId },
    });
    return count > 0;
  }

  // ── Messages (conversation history) ────────────────────────────────────────

  /** Last N messages, oldest→newest, O(N-recent) regardless of history size. */
  async recentMessages(limit = 30): Promise<Message[]> {
    const rows = await this.prisma.message.findMany({
      where: { clientId: this.clientId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(limit, 100),
    });
    return rows.reverse();
  }

  async saveMessage(data: {
    direction: 'inbound' | 'outbound';
    content: string;
    telegramUpdateId?: bigint;
  }): Promise<Message> {
    return this.prisma.message.create({ data: { ...data, clientId: this.clientId } });
  }

  /**
   * True if an inbound message for this Telegram update_id is already stored.
   * The unique(clientId, telegramUpdateId) index is the definitive dedup, but
   * this lets a caller skip expensive work (e.g. voice transcription) on a
   * webhook redelivery BEFORE paying for it — safe because updates for one
   * client are processed serially, so the winning row is committed first.
   */
  async hasInboundForUpdate(telegramUpdateId: bigint): Promise<boolean> {
    const existing = await this.prisma.message.findFirst({
      where: { clientId: this.clientId, telegramUpdateId },
      select: { id: true },
    });
    return existing !== null;
  }

  // ── Audit log ──────────────────────────────────────────────────────────────

  async writeAudit(entry: {
    toolName: string;
    input: Prisma.InputJsonValue;
    result: Prisma.InputJsonValue;
    success: boolean;
  }): Promise<AuditLog> {
    return this.prisma.auditLog.create({ data: { ...entry, clientId: this.clientId } });
  }
}
