/**
 * Shared types between @assistant/api and @assistant/web.
 * Keep this dependency-free: plain types and constants only.
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

/** Cursor-paginated list envelope — no endpoint ever returns "all rows". */
export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}
