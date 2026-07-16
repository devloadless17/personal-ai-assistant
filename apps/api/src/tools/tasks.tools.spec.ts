import type { Client, Task } from '@prisma/client';
import { createTask, updateTask } from './tasks.tools';
import type { ToolContext } from './tool.types';
import type { ClientScopedRepository } from '../tenancy/client-scoped-repository';

/**
 * The app-owned reminder guarantee: a `type: reminder` with a due time ALWAYS
 * gets a firing `reminderAt`, even when the model forgets to set one. Without
 * this, a reminder is created with reminderAt=null and the cron can never match
 * it — the exact "created but never notifies" bug seen in production.
 */

const CLIENT = { id: 'c1', timezone: 'UTC', name: 'T', assistantName: 'A' } as Client;

function ctxCapturing(): { ctx: ToolContext; created: Record<string, unknown>[]; updates: Record<string, unknown>[] } {
  const created: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const existing: Task = {
    id: 'task-1',
    title: 'old',
    type: 'reminder',
    status: 'open',
    dueAt: null,
    reminderAt: null,
    reminderSent: false,
    notes: null,
    sourceEventId: null,
    reminderLeadMinutes: null,
    clientId: CLIENT.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Task;
  const repo = {
    createTask: jest.fn().mockImplementation((data: Record<string, unknown>) => {
      created.push(data);
      return Promise.resolve({ ...existing, ...data, id: 'task-new' });
    }),
    findTaskById: jest.fn().mockResolvedValue(existing),
    updateTask: jest.fn().mockImplementation((_id: string, data: Record<string, unknown>) => {
      updates.push(data);
      return Promise.resolve({ ...existing, ...data });
    }),
  } as unknown as ClientScopedRepository;
  return {
    ctx: { repo, client: CLIENT, now: new Date('2026-07-16T09:00:00Z') },
    created,
    updates,
  };
}

describe('tasks tools — reminder firing guarantee', () => {
  it('a reminder with a due time but NO reminder fields still gets reminderAt = due time', async () => {
    const { ctx, created } = ctxCapturing();
    await createTask.execute(
      { title: 'Take a shower', type: 'reminder', due_at: new Date('2026-07-16T18:30:00Z') },
      ctx,
    );
    expect(created).toHaveLength(1);
    // The bug was reminderAt=null here; the guarantee sets it to the due time.
    expect(created[0]?.reminderAt).toEqual(new Date('2026-07-16T18:30:00Z'));
  });

  it('an explicit reminder_minutes_before still wins over the default', async () => {
    const { ctx, created } = ctxCapturing();
    await createTask.execute(
      {
        title: 'Meeting',
        type: 'reminder',
        due_at: new Date('2026-07-16T18:00:00Z'),
        reminder_minutes_before: 15,
      },
      ctx,
    );
    expect(created[0]?.reminderAt).toEqual(new Date('2026-07-16T17:45:00Z'));
  });

  it('a plain TASK with a due date is NOT forced to have a reminder', async () => {
    const { ctx, created } = ctxCapturing();
    await createTask.execute(
      { title: 'Report due', type: 'task', due_at: new Date('2026-07-16T18:00:00Z') },
      ctx,
    );
    expect(created[0]?.reminderAt).toBeNull();
  });

  it('reminder_minutes_before = 0 means NO reminder even for a reminder-type', async () => {
    const { ctx, created } = ctxCapturing();
    await createTask.execute(
      {
        title: 'no ping',
        type: 'reminder',
        due_at: new Date('2026-07-16T18:00:00Z'),
        reminder_minutes_before: 0,
      },
      ctx,
    );
    expect(created[0]?.reminderAt).toBeNull();
  });

  it('updating a reminder that had NO reminderAt to a new due time re-arms the ping', async () => {
    // The existing fake task is a type:reminder with reminderAt=null (the bug
    // state). Setting a due time must give it a firing reminderAt + re-arm it.
    const { ctx, updates } = ctxCapturing();
    await updateTask.execute(
      { task_id: 'task-1', due_at: new Date('2026-07-16T20:00:00Z') },
      ctx,
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.reminderAt).toEqual(new Date('2026-07-16T20:00:00Z'));
    expect(updates[0]?.reminderSent).toBe(false);
  });
});
