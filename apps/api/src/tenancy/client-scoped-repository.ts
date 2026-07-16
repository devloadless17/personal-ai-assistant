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
