import { z } from 'zod';
import type { RecurrenceFreq, Task } from '@prisma/client';
import { defineTool } from './tool.types';
import { formatInTz, isoDateTime } from './time';

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** How the model specifies recurrence; translated to the DB recurrence fields. */
const repeatSchema = z.object({
  freq: z.enum(['daily', 'weekly', 'monthly']),
  interval: z.number().int().min(1).max(60).optional().describe('Every N periods (default 1).'),
  weekdays: z
    .array(z.number().int().min(0).max(6))
    .optional()
    .describe('WEEKLY only: which days (0=Sun … 6=Sat), e.g. [5]=Fri, [1,2,3,4,5]=weekdays.'),
  until: isoDateTime.optional().describe('Optional end date; the series stops after this.'),
});

type RepeatInput = z.infer<typeof repeatSchema>;

function repeatToFields(repeat: RepeatInput): {
  recurrenceFreq: RecurrenceFreq;
  recurrenceInterval: number;
  recurrenceWeekdays: number[];
  recurrenceUntil: Date | null;
} {
  return {
    recurrenceFreq: repeat.freq.toUpperCase() as RecurrenceFreq,
    recurrenceInterval: repeat.interval ?? 1,
    recurrenceWeekdays: repeat.freq === 'weekly' ? (repeat.weekdays ?? []) : [],
    recurrenceUntil: repeat.until ?? null,
  };
}

function describeRecurrence(t: Task): string {
  if (!t.recurrenceFreq) return '';
  const n = t.recurrenceInterval ?? 1;
  const every = n > 1 ? `every ${n} ` : 'every ';
  if (t.recurrenceFreq === 'DAILY') return `${every}${n > 1 ? 'days' : 'day'}`;
  if (t.recurrenceFreq === 'MONTHLY') return `${every}${n > 1 ? 'months' : 'month'}`;
  if (t.recurrenceWeekdays.length > 0) {
    return `every ${t.recurrenceWeekdays.map((w) => WEEKDAY_NAMES[w] ?? '?').join(', ')}`;
  }
  return `${every}${n > 1 ? 'weeks' : 'week'}`;
}

/**
 * Resolve the reminder time from either an absolute time or a lead offset.
 * `changed: false` means neither was supplied → leave the reminder as-is.
 */
type ReminderResolution =
  | { changed: false }
  | { changed: true; value: Date | null }
  | { error: string };

function resolveReminderAt(
  reminderAt: Date | null | undefined,
  minutesBefore: number | null | undefined,
  dueAt: Date | null | undefined,
): ReminderResolution {
  if (reminderAt !== undefined) return { changed: true, value: reminderAt };
  if (minutesBefore === undefined) return { changed: false };
  // 0 or null both mean "no reminder" — consistent with create_calendar_event
  // and the "no automatic reminders" preference.
  if (minutesBefore === null || minutesBefore === 0) return { changed: true, value: null };
  if (!dueAt) {
    return { error: 'a reminder lead time needs a due time — set due_at as well' };
  }
  return { changed: true, value: new Date(dueAt.getTime() - minutesBefore * 60_000) };
}

function renderTask(t: Task, tz: string): string {
  const bits = [
    `[id:${t.id}] ${t.title}`,
    `(${t.type}, ${t.status})`,
    t.dueAt ? `due ${formatInTz(t.dueAt, tz)}` : 'no due date',
  ];
  if (t.reminderAt) bits.push(`reminder ${formatInTz(t.reminderAt, tz)}`);
  if (t.recurrenceFreq) bits.push(`repeats ${describeRecurrence(t)}`);
  if (t.notes) bits.push(`notes: ${t.notes}`);
  return bits.join(' — ');
}

export const getTasks = defineTool({
  name: 'get_tasks',
  description:
    'List the client\'s tasks/reminders in a time window. Call this before answering any question about tasks and before updating/completing/deleting one (to get its id). Defaults to OPEN tasks. Never fetches everything — always windowed and capped.',
  schema: z.object({
    status: z.enum(['open', 'done']).optional().describe('Filter by status. Default: open.'),
    from: isoDateTime.optional().describe('Window start (ISO 8601). Omit for no lower bound.'),
    to: isoDateTime.optional().describe('Window end (ISO 8601). Omit for no upper bound.'),
    include_undated: z
      .boolean()
      .optional()
      .describe('Include tasks with no due date (default true).'),
    limit: z.number().int().min(1).max(100).optional().describe('Max results (default 50).'),
  }),
  async execute(input, ctx) {
    const { tasks, more } = await ctx.repo.findTasks({
      status: input.status,
      dueFrom: input.from,
      dueTo: input.to,
      includeUndated: input.include_undated,
      limit: input.limit,
    });
    if (tasks.length === 0) return 'No tasks found in that window.';
    const tz = ctx.client.timezone;
    const lines = tasks.map((t) => renderTask(t, tz));
    if (more > 0) lines.push(`(…and ${more} more — narrow the window to see them)`);
    return lines.join('\n');
  },
});

export const createTask = defineTool({
  name: 'create_task',
  description:
    "Create a task or reminder in the client's task list (NOT on the calendar — calendar events are separate). To send a Telegram reminder, use reminder_minutes_before (e.g. 15 = ping 15 min before due) — this respects the client's preferred lead time — or reminder_at for an exact time.",
  schema: z.object({
    title: z.string().min(1).max(500).describe('Short task title.'),
    type: z.enum(['task', 'reminder']).optional().describe('Default: task.'),
    due_at: isoDateTime.optional().describe('Due datetime (ISO 8601), if any.'),
    reminder_minutes_before: z
      .number()
      .int()
      .min(0)
      .max(10080)
      .optional()
      .describe(
        "Minutes before due_at to send a reminder. Prefer this. Use the client's default lead time unless they specify a different one for this task.",
      ),
    reminder_at: isoDateTime
      .optional()
      .describe('Exact reminder datetime (ISO 8601). Use only when the client names a specific time.'),
    repeat: repeatSchema
      .optional()
      .describe(
        'Make it a RECURRING reminder ("every Friday", "every day", "monthly"). The first reminder time (reminder_at or due_at) is the anchor; it re-fires each period.',
      ),
    notes: z.string().max(2000).optional().describe('Extra details, if any.'),
  }),
  async execute(input, ctx) {
    const rem = resolveReminderAt(input.reminder_at, input.reminder_minutes_before, input.due_at);
    if ('error' in rem) return `ERROR: ${rem.error}. Nothing was created.`;
    const type = input.type ?? 'task';
    let reminderAt = rem.changed ? rem.value : null;
    let dueAt = input.due_at ?? null;
    // App-owned guarantee: a REMINDER must actually fire. The model sometimes
    // sets a due time but forgets the reminder fields — leaving reminderAt null,
    // which the cron can never match (silent no-op). So for a reminder with a
    // due time and NO reminder specified, default the ping to the due time
    // itself (the client asked to be reminded AT that time). Never trust the
    // model to remember this. `!rem.changed` means the model gave no reminder
    // field at all — an explicit `reminder_minutes_before: 0` (rem.changed with
    // value null) is a deliberate "no reminder" and is respected.
    if (type === 'reminder' && !rem.changed && dueAt) {
      reminderAt = dueAt;
    }
    // Symmetry: a reminder given only as a ping time ("remind me at 9:30") has
    // no due time — treat the ping time AS its scheduled time so it always
    // carries a date (never shows "no date") and appears in day/task views.
    if (type === 'reminder' && dueAt === null && reminderAt) {
      dueAt = reminderAt;
    }
    // A recurring reminder needs an anchor time to re-fire from.
    if (input.repeat && !reminderAt) {
      return 'ERROR: a recurring reminder needs a time — set reminder_at (or due_at). Nothing was created.';
    }
    const task = await ctx.repo.createTask({
      title: input.title,
      type: input.type,
      dueAt,
      reminderAt,
      notes: input.notes ?? null,
      ...(input.repeat ? repeatToFields(input.repeat) : {}),
    });
    return `Created: ${renderTask(task, ctx.client.timezone)}`;
  },
});

export const updateTask = defineTool({
  name: 'update_task',
  description:
    'Update an existing task/reminder (rename, reschedule, change reminder, edit notes, reopen). Get the task id from get_tasks first. To mark done use complete_task; to remove use delete_task.',
  schema: z.object({
    task_id: z.string().min(1).describe('The task id from get_tasks.'),
    title: z.string().min(1).max(500).optional(),
    type: z.enum(['task', 'reminder']).optional(),
    status: z.enum(['open', 'done']).optional().describe('Set "open" to reopen a done task.'),
    due_at: isoDateTime.nullable().optional().describe('New due datetime, or null to clear.'),
    reminder_minutes_before: z
      .number()
      .int()
      .min(0)
      .max(10080)
      .nullable()
      .optional()
      .describe('New reminder lead time in minutes before due, or null to clear the reminder.'),
    reminder_at: isoDateTime
      .nullable()
      .optional()
      .describe('New exact reminder datetime, or null to clear.'),
    repeat: repeatSchema
      .nullable()
      .optional()
      .describe('Set/replace the recurrence, or null to STOP repeating ("stop reminding me every Friday").'),
    notes: z.string().max(2000).nullable().optional(),
  }),
  async execute(input, ctx) {
    const { task_id, due_at, reminder_at, reminder_minutes_before, repeat, ...rest } = input;

    // We may need the existing task to resolve a lead-time, to keep a
    // reminder's lead when only the due time moves, OR to honour the
    // reminder-must-fire guarantee when converting a task to a reminder
    // (type:'reminder' alone) — then effectiveDue must reflect the STORED due
    // date, else the guarantee is skipped and the reminder silently never fires.
    const needsExisting =
      (reminder_minutes_before != null && due_at === undefined) ||
      due_at !== undefined ||
      rest.type === 'reminder';
    const existing = needsExisting ? await ctx.repo.findTaskById(task_id) : null;

    const dueRef = due_at !== undefined ? due_at : (existing?.dueAt ?? null);
    let rem = resolveReminderAt(reminder_at, reminder_minutes_before, dueRef);
    if ('error' in rem) return `ERROR: ${rem.error}. Nothing was changed.`;

    // F6: rescheduling the due time (with no explicit reminder change) shifts
    // an existing reminder to keep the SAME lead — never leaves it behind.
    if (
      !rem.changed &&
      due_at !== undefined &&
      due_at !== null &&
      existing?.dueAt &&
      existing.reminderAt
    ) {
      const lead = existing.dueAt.getTime() - existing.reminderAt.getTime();
      rem = { changed: true, value: new Date(due_at.getTime() - lead) };
    }

    // App-owned guarantee (mirror of create_task): a reminder must keep a live
    // ping. If the effective type is 'reminder' with a due time but the model
    // touched no reminder field (!rem.changed) and none exists, default the
    // ping to the due time. An explicit clear (rem.changed, value null) stands.
    const effectiveType = rest.type ?? existing?.type;
    const effectiveDue = due_at !== undefined ? due_at : (existing?.dueAt ?? null);
    if (
      effectiveType === 'reminder' &&
      !rem.changed &&
      (existing?.reminderAt ?? null) === null &&
      effectiveDue
    ) {
      rem = { changed: true, value: effectiveDue };
    }

    // Symmetry (mirror of create_task): a reminder given only a ping time and no
    // due time gets its scheduled time = the ping time, so it always carries a
    // date (never "no date").
    const resultingReminder = rem.changed ? rem.value : (existing?.reminderAt ?? null);
    const backfillDue =
      effectiveType === 'reminder' && effectiveDue === null && resultingReminder !== null
        ? resultingReminder
        : undefined;

    // Recurrence: an object sets/replaces it; `null` stops the series; `undefined`
    // (omitted) leaves it as-is.
    const recurrencePatch =
      repeat === undefined
        ? {}
        : repeat === null
          ? { recurrenceFreq: null, recurrenceInterval: 1, recurrenceWeekdays: [], recurrenceUntil: null }
          : repeatToFields(repeat);

    const task = await ctx.repo.updateTask(task_id, {
      ...rest,
      ...(due_at !== undefined
        ? { dueAt: due_at }
        : backfillDue
          ? { dueAt: backfillDue }
          : {}),
      ...(rem.changed
        ? { reminderAt: rem.value, reminderSent: false } // rescheduled reminder re-arms
        : {}),
      ...recurrencePatch,
    });
    if (!task) return `ERROR: no task with id ${task_id} exists for this client. Nothing was changed.`;
    return `Updated: ${renderTask(task, ctx.client.timezone)}`;
  },
});

export const completeTask = defineTool({
  name: 'complete_task',
  description: 'Mark a task as done. Get the task id from get_tasks first.',
  schema: z.object({
    task_id: z.string().min(1).describe('The task id from get_tasks.'),
  }),
  async execute(input, ctx) {
    const task = await ctx.repo.updateTask(input.task_id, { status: 'done' });
    if (!task)
      return `ERROR: no task with id ${input.task_id} exists for this client. Nothing was changed.`;
    return `Marked done: ${task.title}`;
  },
});

export const deleteTask = defineTool({
  name: 'delete_task',
  description:
    'Permanently delete a task/reminder. Only when the client explicitly asks to delete/remove it (completing is complete_task). Get the id from get_tasks first.',
  schema: z.object({
    task_id: z.string().min(1).describe('The task id from get_tasks.'),
  }),
  async execute(input, ctx) {
    const task = await ctx.repo.findTaskById(input.task_id);
    if (!task)
      return `ERROR: no task with id ${input.task_id} exists for this client. Nothing was deleted.`;
    await ctx.repo.deleteTask(input.task_id);
    return `Deleted task: ${task.title}`;
  },
});
