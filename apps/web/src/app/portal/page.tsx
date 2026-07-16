"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { ClientMe, PortalEvent, PortalTask } from "@assistant/shared";
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
  const [calendar, setCalendar] = useState<{ connected: boolean; events: PortalEvent[] } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [m, t, c] = await Promise.all([
        portalApi<ClientMe>("/client/me"),
        portalApi<PortalTask[]>("/client/tasks"),
        portalApi<{ connected: boolean; events: PortalEvent[] }>("/client/calendar"),
      ]);
      setMe(m);
      setTasks(t);
      setCalendar(c);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load your data");
    }
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

      <Card>
        <CardHeader>
          <CardTitle>Upcoming — next 7 days</CardTitle>
          <CardDescription>
            Live from your Google Calendar, including events you add there directly.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!calendar?.connected ? (
            <p className="text-sm text-muted-foreground">
              Calendar not linked yet — sign in with Google again to grant access.
            </p>
          ) : calendar.events.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing scheduled. Enjoy the clear week!</p>
          ) : (
            <ul className="space-y-2" data-testid="calendar-list">
              {calendar.events.map((e) => (
                <li key={e.id} className="flex items-start justify-between gap-3 border-b pb-2 last:border-0">
                  <span className="text-sm font-medium">{e.title}</span>
                  <span className="whitespace-nowrap text-xs text-muted-foreground">
                    {formatWhen(e, me.timezone)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your tasks</CardTitle>
          <CardDescription>Open tasks and reminders your assistant is tracking.</CardDescription>
        </CardHeader>
        <CardContent>
          {tasks.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No open tasks. Tell your assistant on Telegram to add one.
            </p>
          ) : (
            <ul className="space-y-2" data-testid="task-list">
              {tasks.map((t) => (
                <li key={t.id} className="flex items-start justify-between gap-3 border-b pb-2 last:border-0">
                  <span className="text-sm">{t.title}</span>
                  <span className="whitespace-nowrap text-xs text-muted-foreground">
                    {t.dueAt ? formatDate(t.dueAt, me.timezone) : "no date"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </main>
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

function formatWhen(e: PortalEvent, tz: string): string {
  if (e.allDay) return `All day · ${formatDate(e.start, tz)}`;
  return formatDate(e.start, tz);
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
