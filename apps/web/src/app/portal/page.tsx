"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { ClientMe, PortalEvent, PortalMemory, PortalTask } from "@assistant/shared";
import { clearClientToken, getClientToken, portalApi } from "@/lib/portal-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function PortalPage() {
  const router = useRouter();
  const [me, setMe] = useState<ClientMe | null>(null);
  const [tasks, setTasks] = useState<PortalTask[]>([]);
  const [memories, setMemories] = useState<PortalMemory[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    // Settle independently so one failing endpoint doesn't blank the whole
    // portal; only a failing /me is fatal. Calendar EVENTS are fetched by the
    // month view itself (which paginates the visible range), so we don't fetch
    // them here — `me.googleConnected` tells us whether to show them.
    const [mR, tR, memR] = await Promise.allSettled([
      portalApi<ClientMe>("/client/me"),
      portalApi<PortalTask[]>("/client/tasks"),
      portalApi<PortalMemory[]>("/client/memory"),
    ]);
    if (mR.status !== "fulfilled") {
      setError(mR.reason instanceof Error ? mR.reason.message : "Failed to load your data");
      return;
    }
    setMe(mR.value);
    if (tR.status === "fulfilled") setTasks(tR.value);
    if (memR.status === "fulfilled") setMemories(memR.value);
  }, []);

  useEffect(() => {
    if (!getClientToken()) {
      router.replace("/portal/login");
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount; setState only post-await
    void load();
  }, [load, router]);

  if (error) {
    return (
      <main className="mx-auto w-full max-w-2xl flex-1 p-6">
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>
      </main>
    );
  }
  if (!me) {
    return (
      <main className="mx-auto w-full max-w-2xl flex-1 p-6">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Hi {me.name} 👋</h1>
          <p className="text-sm text-muted-foreground">
            Your assistant “{me.assistantName}” · {me.timezone}
          </p>
        </div>
        <Button
          variant="ghost"
          onClick={() => {
            clearClientToken();
            router.replace("/portal/login");
          }}
        >
          Sign out
        </Button>
      </div>

      <div className="flex gap-1.5">
        <Badge variant={me.googleNeedsReauth ? "destructive" : me.googleConnected ? "default" : "outline"}>
          {me.googleNeedsReauth ? "Calendar — reconnect" : me.googleConnected ? "Calendar ✓" : "Calendar not linked"}
        </Badge>
        <Badge variant={me.telegramConnected ? "default" : "outline"}>
          {me.telegramConnected ? "Telegram ✓" : "Telegram being set up"}
        </Badge>
      </div>

      <ChatOnTelegram me={me} />
      <Preferences me={me} onChanged={load} />

      <MonthCalendar me={me} tasks={tasks} calendarConnected={me.googleConnected} />

      {tasks.some((t) => t.recurrence) && (
        <Card>
          <CardHeader>
            <CardTitle>🔁 Recurring</CardTitle>
            <CardDescription>Reminders and meetings that repeat. Next occurrence shown.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {tasks
                .filter((t) => t.recurrence)
                .map((t) => (
                  <li key={t.id} className="flex items-start justify-between gap-3 border-b pb-2 last:border-0">
                    <span className="min-w-0 break-words text-sm">
                      {t.title}
                      <span className="ml-2 text-xs text-muted-foreground">· {t.recurrence}</span>
                    </span>
                    <span className="whitespace-nowrap text-right text-xs text-muted-foreground">
                      {t.reminderAt
                        ? `⏰ ${formatDate(t.reminderAt, me.timezone)}`
                        : t.dueAt
                          ? formatDate(t.dueAt, me.timezone)
                          : ""}
                    </span>
                  </li>
                ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Your tasks</CardTitle>
          <CardDescription>Open tasks and reminders your assistant is tracking.</CardDescription>
        </CardHeader>
        <CardContent>
          {tasks.filter((t) => !t.recurrence).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No one-off tasks. Tell your assistant on Telegram to add one.
            </p>
          ) : (
            <ul className="space-y-2" data-testid="task-list">
              {tasks
                .filter((t) => !t.recurrence)
                .map((t) => (
                  <li key={t.id} className="flex items-start justify-between gap-3 border-b pb-2 last:border-0">
                    <span className="min-w-0 break-words text-sm">{t.title}</span>
                    <span className="text-right text-xs text-muted-foreground">
                      <span className="block whitespace-nowrap">
                        {t.dueAt
                          ? formatDate(t.dueAt, me.timezone)
                          : t.reminderAt
                            ? `⏰ ${formatDate(t.reminderAt, me.timezone)}`
                            : "no date"}
                      </span>
                      {t.dueAt && t.reminderAt && t.reminderAt !== t.dueAt && (
                        <span className="block whitespace-nowrap text-[11px] opacity-80">
                          ⏰ {formatDate(t.reminderAt, me.timezone)}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <AssistantMemory memories={memories} onChanged={load} />
    </main>
  );
}

const MEMORY_GROUPS: { key: PortalMemory["category"]; label: string }[] = [
  { key: "PROFILE", label: "Profile" },
  { key: "PREFERENCE", label: "Preferences" },
  { key: "LONGTERM", label: "Long-term" },
];

function AssistantMemory({
  memories,
  onChanged,
}: {
  memories: PortalMemory[];
  onChanged: () => void | Promise<void>;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const remove = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await portalApi(`/client/memory/${id}`, { method: "DELETE" });
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't remove that — please try again.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>What your assistant knows about you</CardTitle>
        <CardDescription>
          Facts and preferences your assistant remembers. Remove anything you don&apos;t want it to
          keep — or just tell it &quot;forget that&quot; on Telegram.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error && (
          <p className="mb-2 text-xs text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}
        {memories.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing remembered yet. As you chat, your assistant will learn your preferences.
          </p>
        ) : (
          <div className="space-y-4">
            {MEMORY_GROUPS.map(({ key, label }) => {
              const items = memories.filter((m) => m.category === key);
              if (items.length === 0) return null;
              return (
                <div key={key}>
                  <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {label}
                  </p>
                  <ul className="space-y-1">
                    {items.map((m) => (
                      <li
                        key={m.id}
                        className="flex items-start justify-between gap-3 border-b pb-1 last:border-0"
                      >
                        <span className="min-w-0 break-words text-sm">{m.value}</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busyId === m.id}
                          onClick={() => void remove(m.id)}
                          aria-label={`Forget ${m.key}`}
                        >
                          Remove
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type DayItem = { label: string; kind: "meeting" | "event" | "task" | "reminder"; time?: string; sort: number };

const KIND_STYLE: Record<DayItem["kind"], string> = {
  meeting: "bg-blue-100 text-blue-800 dark:bg-blue-500/25 dark:text-blue-200",
  event: "bg-sky-100 text-sky-800 dark:bg-sky-500/25 dark:text-sky-200",
  task: "bg-amber-100 text-amber-900 dark:bg-amber-500/25 dark:text-amber-200",
  reminder: "bg-emerald-100 text-emerald-900 dark:bg-emerald-500/25 dark:text-emerald-200",
};
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function localYMD(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/** Minutes into the LOCAL day (client tz) — for ordering same-day items. */
function localMinutes(iso: string, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return (h === 24 ? 0 : h) * 60 + m;
}

type GridCell = { y: number; m: number; d: number; inMonth: boolean; key: string };

/** Does a recurring task occur on this calendar cell? Mirrors the server's
 * recurrence rules so the calendar shows EVERY occurrence, not just the next. */
function taskOccursOn(cell: GridCell, t: PortalTask, tz: string): boolean {
  const freq = t.recurrenceFreq;
  if (!freq) return false;
  const base = t.recurrenceAnchor ?? t.reminderAt ?? t.dueAt;
  if (!base) return false;
  const [ay, am, ad] = localYMD(base, tz).split("-").map(Number);
  const anchorNum = Date.UTC(ay!, am! - 1, ad!);
  const cellNum = Date.UTC(cell.y, cell.m, cell.d);
  if (cellNum < anchorNum) return false; // before the series began
  if (t.recurrenceUntil) {
    const [uy, um, ud] = localYMD(t.recurrenceUntil, tz).split("-").map(Number);
    if (cellNum > Date.UTC(uy!, um! - 1, ud!)) return false;
  }
  const interval = Math.max(1, t.recurrenceInterval || 1);
  const DAY = 86_400_000;
  const cellWeekday = new Date(cellNum).getUTCDay();
  if (freq === "DAILY") return ((cellNum - anchorNum) / DAY) % interval === 0;
  if (freq === "WEEKLY") {
    if (t.recurrenceWeekdays.length > 0) return t.recurrenceWeekdays.includes(cellWeekday);
    const days = (cellNum - anchorNum) / DAY;
    return days % 7 === 0 && (days / 7) % interval === 0;
  }
  // MONTHLY: the anchor day-of-month (clamped for short months), every N months.
  const daysInCellMonth = new Date(Date.UTC(cell.y, cell.m + 1, 0)).getUTCDate();
  if (cell.d !== Math.min(ad!, daysInCellMonth)) return false;
  const months = (cell.y - ay!) * 12 + (cell.m - (am! - 1));
  return months >= 0 && months % interval === 0;
}

function MonthCalendar({
  me,
  tasks,
  calendarConnected,
}: {
  me: ClientMe;
  tasks: PortalTask[];
  calendarConnected: boolean;
}) {
  const tz = me.timezone;
  const todayKey = localYMD(new Date().toISOString(), tz);
  const [ym, setYm] = useState(() => {
    const [y, m] = todayKey.split("-").map(Number);
    return { y: y!, m: m! - 1 }; // month 0-indexed
  });
  const [events, setEvents] = useState<PortalEvent[]>([]);

  // 6-week grid (42 cells) starting on the Sunday on/before the 1st.
  const cells = useMemo(() => {
    const first = new Date(Date.UTC(ym.y, ym.m, 1));
    const start = new Date(Date.UTC(ym.y, ym.m, 1 - first.getUTCDay()));
    return Array.from({ length: 42 }, (_, i) => {
      const dt = new Date(start.getTime() + i * 86_400_000);
      const y = dt.getUTCFullYear();
      const m = dt.getUTCMonth();
      const d = dt.getUTCDate();
      return { y, m, d, inMonth: m === ym.m, key: `${y}-${pad2(m + 1)}-${pad2(d)}` };
    });
  }, [ym]);

  useEffect(() => {
    if (!calendarConnected) return;
    const from = new Date(Date.UTC(cells[0]!.y, cells[0]!.m, cells[0]!.d)).toISOString();
    const to = new Date(Date.UTC(cells[41]!.y, cells[41]!.m, cells[41]!.d + 1)).toISOString();
    let cancelled = false;
    portalApi<{ connected: boolean; events: PortalEvent[] }>(
      `/client/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    )
      .then((r) => {
        if (!cancelled) setEvents(r.events);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [cells, calendarConnected]);

  // Bucket every item (meetings/events + tasks/reminders) onto its local day.
  const byDay = useMemo(() => {
    const map = new Map<string, DayItem[]>();
    const add = (key: string, item: DayItem) => {
      const arr = map.get(key) ?? [];
      arr.push(item);
      map.set(key, arr);
    };
    for (const e of events) {
      add(localYMD(e.start, tz), {
        label: e.title,
        kind: e.attendees && e.attendees.length > 0 ? "meeting" : "event",
        time: e.allDay ? undefined : formatTime(e.start, tz),
        sort: e.allDay ? -1 : localMinutes(e.start, tz),
      });
    }
    for (const t of tasks) {
      const kind = t.type === "reminder" ? ("reminder" as const) : ("task" as const);
      const timeIso = t.reminderAt ?? t.dueAt;
      const time = timeIso ? formatTime(timeIso, tz) : undefined;
      // Local minutes-into-day for stable ordering of same-day items.
      const minute = timeIso ? localMinutes(timeIso, tz) : 0;
      if (t.recurrenceFreq) {
        // Project the series onto EVERY matching day in the visible grid.
        for (const c of cells) {
          if (taskOccursOn(c, t, tz)) add(c.key, { label: t.title, kind, time, sort: minute });
        }
      } else {
        const iso = t.dueAt ?? t.reminderAt;
        if (iso) add(localYMD(iso, tz), { label: t.title, kind, time, sort: minute });
      }
    }
    for (const arr of map.values()) arr.sort((a, b) => a.sort - b.sort);
    return map;
  }, [events, tasks, cells, tz]);

  const monthLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC", // cells are UTC-based calendar dates; anchor the label to UTC too
    month: "long",
    year: "numeric",
  }).format(new Date(Date.UTC(ym.y, ym.m, 1)));
  const shift = (delta: number) => {
    const total = ym.y * 12 + ym.m + delta;
    setYm({ y: Math.floor(total / 12), m: ((total % 12) + 12) % 12 });
  };
  const goToday = () => {
    const [y, m] = todayKey.split("-").map(Number);
    setYm({ y: y!, m: m! - 1 });
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle>{monthLabel}</CardTitle>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={goToday}>
            Today
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Previous month" onClick={() => shift(-1)}>
            ‹
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Next month" onClick={() => shift(1)}>
            ›
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {!calendarConnected && (
          <p className="mb-2 text-xs text-muted-foreground">
            Calendar not linked — meetings won&apos;t show until you sign in with Google. Tasks and
            reminders still appear below.
          </p>
        )}
        <div className="overflow-x-auto">
          <div className="min-w-[560px]">
            <div className="grid grid-cols-7 border-b text-center text-[11px] font-medium text-muted-foreground">
              {WEEKDAYS.map((w) => (
                <div key={w} className="py-1.5">
                  {w}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {cells.map((c) => {
                const items = byDay.get(c.key) ?? [];
                const isToday = c.key === todayKey;
                return (
                  <div
                    key={c.key}
                    className={`min-h-[92px] border-b border-r p-1 ${
                      c.inMonth ? "" : "bg-muted/30 text-muted-foreground"
                    }`}
                  >
                    <div className="mb-1 flex justify-end">
                      <span
                        className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs ${
                          isToday ? "bg-primary font-semibold text-primary-foreground" : ""
                        }`}
                      >
                        {c.d}
                      </span>
                    </div>
                    <div className="space-y-0.5">
                      {items.slice(0, 3).map((it, i) => (
                        <div
                          key={i}
                          title={`${it.time ? `${it.time} · ` : ""}${it.label}`}
                          className={`truncate rounded px-1 py-0.5 text-[10px] leading-tight ${KIND_STYLE[it.kind]}`}
                        >
                          {it.time ? `${it.time} ` : ""}
                          {it.label}
                        </div>
                      ))}
                      {items.length > 3 && (
                        <div className="px-1 text-[10px] text-muted-foreground">
                          +{items.length - 3} more
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
          <Legend className="bg-blue-500/60" label="Meeting" />
          <Legend className="bg-sky-500/60" label="Event" />
          <Legend className="bg-amber-500/70" label="Task" />
          <Legend className="bg-emerald-500/70" label="Reminder" />
        </div>
      </CardContent>
    </Card>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-block h-2.5 w-2.5 rounded-sm ${className}`} />
      {label}
    </span>
  );
}

function ChatOnTelegram({ me }: { me: ClientMe }) {
  // Before binding: the secure deep link (with code). After binding: the plain
  // bot link (they're already connected).
  const link =
    me.telegramDeepLink ??
    (me.telegramChatBound && me.telegramBotUsername
      ? `https://t.me/${me.telegramBotUsername}`
      : null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Chat with your assistant</CardTitle>
        <CardDescription>
          Your assistant lives in Telegram — tap below to start chatting. Ask it about your day,
          add tasks, or book meetings, all in plain language.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {link ? (
          <Button render={<a href={link} target="_blank" rel="noopener noreferrer" />}>
            {me.telegramChatBound ? "Open your assistant on Telegram" : "Start chatting on Telegram"}
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">
            Your administrator is setting up your Telegram assistant. You&apos;ll get a link here
            once it&apos;s ready.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Preferences({ me, onChanged }: { me: ClientMe; onChanged: () => void | Promise<void> }) {
  const [reminder, setReminder] = useState(String(me.defaultReminderMinutes));
  const [briefHour, setBriefHour] = useState(String(me.dailyBriefHour));
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOk(false);
    try {
      await portalApi("/client/preferences", {
        method: "PATCH",
        body: {
          defaultReminderMinutes: Number(reminder),
          dailyBriefHour: Number(briefHour),
        },
      });
      setOk(true);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Preferences</CardTitle>
        <CardDescription>
          How far ahead to remind you, and when to send your daily summary. Your assistant follows
          these — and you can always override a single reminder just by asking it in chat.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1.5">
            <label htmlFor="rem" className="text-sm font-medium">
              Remind me before tasks
            </label>
            <select
              id="rem"
              className="w-full rounded-md border bg-background p-2 text-sm"
              value={reminder}
              onChange={(e) => setReminder(e.target.value)}
            >
              <option value="0">No automatic reminders</option>
              <option value="5">5 minutes before</option>
              <option value="10">10 minutes before</option>
              <option value="15">15 minutes before</option>
              <option value="30">30 minutes before</option>
              <option value="60">1 hour before</option>
              <option value="120">2 hours before</option>
              <option value="1440">1 day before</option>
            </select>
          </div>
          <div className="flex-1 space-y-1.5">
            <label htmlFor="brief" className="text-sm font-medium">
              Daily summary at
            </label>
            <select
              id="brief"
              className="w-full rounded-md border bg-background p-2 text-sm"
              value={briefHour}
              onChange={(e) => setBriefHour(e.target.value)}
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {formatHour(h)}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </form>
        {ok && <p className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">Saved ✓</p>}
        {error && (
          <p className="mt-3 text-sm text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function formatHour(h: number): string {
  const period = h < 12 ? "AM" : "PM";
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}:00 ${period}`;
}

function formatTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

function formatDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}
