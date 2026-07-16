/**
 * Shared types between @assistant/api and @assistant/web.
 *
 * TYPE-ONLY for now: both consumers use `import type { ... }`, which is
 * erased at compile time, so no build step is needed. The moment a runtime
 * value (constant, zod schema) is added here, give this package a `build`
 * script emitting dist/ and repoint main/types — do not import values from
 * here before that.
 */

export type ClientStatus = 'active' | 'disabled';
export type TaskType = 'task' | 'reminder';
export type TaskStatus = 'open' | 'done';

/** Health endpoint contract (GET /health). */
export interface HealthReport {
  status: 'ok';
  db: 'up';
  timestamp: string;
}

/** Client summary as listed on the dashboard. */
export interface ClientSummary {
  id: string;
  name: string;
  status: ClientStatus;
  timezone: string;
  assistantName: string;
  telegramConnected: boolean;
  googleConnected: boolean;
  googleNeedsReauth: boolean;
  createdAt: string;
}

/** One audit-log row as shown on the dashboard. */
export interface AuditLogEntry {
  id: string;
  toolName: string;
  input: unknown;
  result: unknown;
  success: boolean;
  createdAt: string;
}

/**
 * Cursor-paginated list envelope — no endpoint ever returns "all rows".
 * Cursors are (createdAt, id) pairs: `id` is the tiebreaker so bursts of
 * rows created in the same millisecond can never be skipped or duplicated.
 */
export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}
