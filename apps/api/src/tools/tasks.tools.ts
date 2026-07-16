import { z } from 'zod';
import type { Task } from '@prisma/client';
import { defineTool } from './tool.types';
import { formatInTz, isoDateTime } from './time';

function renderTask(t: Task, tz: string): string {
  const bits = [
    `[id:${t.id}] ${t.title}`,
    `(${t.type}, ${t.status})`,
    t.dueAt ? `due ${formatInTz(t.dueAt, tz)}` : 'no due date',
  ];
  if (t.reminderAt) bits.push(`reminder ${formatInTz(t.reminderAt, tz)}`);
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
    'Create a task or reminder in the client\'s task list (NOT on the calendar — calendar events are separate). Use type "reminder" with reminder_at when the client wants to be pinged on Telegram at a specific time.',
  schema: z.object({
    title: z.string().min(1).max(500).describe('Short task title.'),
    type: z.enum(['task', 'reminder']).optional().describe('Default: task.'),
    due_at: isoDateTime.optional().describe('Due datetime (ISO 8601), if any.'),
    reminder_at: isoDateTime
      .optional()
      .describe('When to send a Telegram reminder (ISO 8601), if the client asked for one.'),
    notes: z.string().max(2000).optional().describe('Extra details, if any.'),
  }),
  async execute(input, ctx) {
    const task = await ctx.repo.createTask({
      title: input.title,
      type: input.type,
      dueAt: input.due_at ?? null,
      reminderAt: input.reminder_at ?? null,
      notes: input.notes ?? null,
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
    reminder_at: isoDateTime
      .nullable()
      .optional()
      .describe('New reminder datetime, or null to clear.'),
    notes: z.string().max(2000).nullable().optional(),
  }),
  async execute(input, ctx) {
    const { task_id, due_at, reminder_at, ...rest } = input;
    const task = await ctx.repo.updateTask(task_id, {
      ...rest,
      ...(due_at !== undefined ? { dueAt: due_at } : {}),
      ...(reminder_at !== undefined
        ? { reminderAt: reminder_at, reminderSent: false } // rescheduled reminder re-arms
        : {}),
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
