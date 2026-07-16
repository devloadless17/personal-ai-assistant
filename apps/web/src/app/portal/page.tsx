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
import { Input } from "@/components/ui/input";

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
          {me.telegramConnected ? "Telegram ✓" : "Telegram not linked"}
        </Badge>
      </div>

      <TelegramConnect connected={me.telegramConnected} onChanged={load} />

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

function TelegramConnect({
  connected,
  onChanged,
}: {
  connected: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const { botUsername } = await portalApi<{ botUsername: string }>("/client/telegram", {
        method: "POST",
        body: { botToken: token },
      });
      setOk(`Connected @${botUsername}. Open the bot in Telegram and send it a message to start.`);
      setToken("");
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Telegram bot {connected && <Badge>connected</Badge>}
        </CardTitle>
        <CardDescription>
          Create a bot with @BotFather in Telegram, then paste its token here to chat with your
          assistant. {connected && "Pasting a new token replaces the bot."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row">
          <Input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="123456789:AA…"
            type="password"
            autoComplete="off"
            required
          />
          <Button type="submit" disabled={busy}>
            {busy ? "Connecting…" : connected ? "Replace" : "Connect"}
          </Button>
        </form>
        {ok && <p className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">{ok}</p>}
        {error && (
          <p className="mt-3 text-sm text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
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
