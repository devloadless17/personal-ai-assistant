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
  email: string | null;
  telegramConnected: boolean;
  telegramBotUsername: string | null;
  /** t.me deep link with the one-time bind code — send this to the client. Null once bound. */
  telegramDeepLink: string | null;
  telegramChatBound: boolean;
  googleConnected: boolean;
  googleNeedsReauth: boolean;
  /** Reminder lead times (minutes before a meeting) — one ping each. [] = off. */
  reminderLeads: number[];
  /** Default meeting length (minutes) when only a start time is given. */
  defaultMeetingMinutes: number;
  dailyBriefHour: number;
  createdAt: string;
}

/** What a logged-in client sees about their own account (portal). */
export interface ClientMe {
  id: string;
  name: string;
  assistantName: string;
  timezone: string;
  telegramConnected: boolean;
  telegramBotUsername: string | null;
  /** t.me deep link with the one-time bind code, if the client hasn't bound yet. */
  telegramDeepLink: string | null;
  telegramChatBound: boolean;
  googleConnected: boolean;
  googleNeedsReauth: boolean;
  /** Reminder lead times (minutes before a meeting) — one ping each. [] = off. */
  reminderLeads: number[];
  /** Default meeting length (minutes) when only a start time is given. */
  defaultMeetingMinutes: number;
  dailyBriefHour: number;
}

/** A task row shown in the client portal. */
export interface PortalTask {
  id: string;
  title: string;
  type: TaskType;
  status: TaskStatus;
  dueAt: string | null;
  reminderAt: string | null;
  notes: string | null;
  /** Human recurrence summary (e.g. "every Sat") when this repeats, else null. */
  recurrence: string | null;
  /** Structured recurrence, so the calendar can project every occurrence. */
  recurrenceFreq: RecurrenceFreq | null;
  recurrenceInterval: number;
  recurrenceWeekdays: number[];
  recurrenceUntil: string | null;
  /** The series' first occurrence (immutable anchor). */
  recurrenceAnchor: string | null;
}

export type RecurrenceFreq = "DAILY" | "WEEKLY" | "MONTHLY";

/** A calendar event shown in the client portal. */
export interface PortalEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string | null;
  attendees: string[];
  recurring: boolean;
}

export type MemoryCategory = 'PROFILE' | 'PREFERENCE' | 'LONGTERM';

/** Something the assistant remembers about the client, shown in the portal. */
export interface PortalMemory {
  id: string;
  key: string;
  value: string;
  category: MemoryCategory;
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

/** A single message in a client's assistant conversation (admin view). */
export interface ConversationMessage {
  id: string;
  direction: "inbound" | "outbound";
  content: string;
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
