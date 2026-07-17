"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ClientSummary } from "@assistant/shared";
import { api } from "@/lib/api-client";
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
import { Label } from "@/components/ui/label";
import { ReminderLeadsEditor, leadsToMinutes } from "@/components/reminder-leads-editor";

export function SetupTab({
  client,
  onChanged,
}: {
  client: ClientSummary;
  onChanged: () => void | Promise<void>;
}) {
  return (
    <div className="space-y-4">
      <EditClientCard client={client} onChanged={onChanged} />
      <TelegramCard client={client} onChanged={onChanged} />
      <GoogleCard client={client} />
      <PreferencesCard client={client} onChanged={onChanged} />
      <StatusCard client={client} onChanged={onChanged} />
      <DangerZoneCard client={client} />
    </div>
  );
}

function EditClientCard({
  client,
  onChanged,
}: {
  client: ClientSummary;
  onChanged: () => void | Promise<void>;
}) {
  const [name, setName] = useState(client.name);
  const [assistantName, setAssistantName] = useState(client.assistantName);
  const [timezone, setTimezone] = useState(client.timezone);
  const [email, setEmail] = useState(client.email ?? "");
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOk(false);
    try {
      await api(`/admin/clients/${client.id}`, {
        method: "PATCH",
        body: {
          name,
          assistantName,
          timezone,
          ...(email.trim() ? { email: email.trim() } : {}),
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
        <CardTitle>Client details</CardTitle>
        <CardDescription>Name, assistant name, timezone, and portal-login email.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="ed-name">Client name</Label>
            <Input id="ed-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ed-an">Assistant name</Label>
            <Input
              id="ed-an"
              value={assistantName}
              onChange={(e) => setAssistantName(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ed-tz">Timezone (IANA)</Label>
            <Input
              id="ed-tz"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ed-email">Client&apos;s Gmail (portal login)</Label>
            <Input
              id="ed-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="client@gmail.com"
            />
          </div>
          <div className="sm:col-span-2 flex items-center gap-3">
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save changes"}
            </Button>
            {ok && <span className="text-sm text-emerald-600 dark:text-emerald-400">Saved ✓</span>}
            {error && (
              <span className="text-sm text-red-600 dark:text-red-400" role="alert">
                {error}
              </span>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function DangerZoneCard({ client }: { client: ClientSummary }) {
  const router = useRouter();
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const armed = confirmText.trim().toLowerCase() === "delete";

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/clients/${client.id}`, { method: "DELETE" });
      router.push("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete");
      setBusy(false);
    }
  }

  return (
    <Card className="border-red-300 dark:border-red-900">
      <CardHeader>
        <CardTitle className="text-red-700 dark:text-red-400">Delete client</CardTitle>
        <CardDescription>
          Permanently removes {client.name}, their tasks, chat history, and audit log, and stops
          their bot. This cannot be undone. To disable temporarily, use “Disable client” above
          instead. Type <span className="font-mono font-semibold">delete</span> to confirm.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 sm:flex-row">
        <Input
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder="type: delete"
          className="sm:max-w-48"
        />
        <Button variant="destructive" onClick={remove} disabled={!armed || busy}>
          {busy ? "Deleting…" : "Delete permanently"}
        </Button>
        {error && (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function TelegramCard({
  client,
  onChanged,
}: {
  client: ClientSummary;
  onChanged: () => void | Promise<void>;
}) {
  const [botToken, setBotToken] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const { botUsername } = await api<{ botUsername: string }>(
        `/admin/clients/${client.id}/telegram`,
        { method: "POST", body: { botToken } },
      );
      setResult(
        `Connected @${botUsername} — webhook registered. Copy the secure link below and send it to the client.`,
      );
      setBotToken("");
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
          Telegram bot
          {client.telegramConnected && <Badge>connected</Badge>}
        </CardTitle>
        <CardDescription>
          Create a dedicated bot for this client with @BotFather, then paste
          its token — the webhook is set automatically.
          {client.telegramConnected && " Pasting a new token replaces the bot."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {client.telegramBotUsername && (
          <ShareableBotLink client={client} onChanged={onChanged} />
        )}
        <form onSubmit={connect} className="flex flex-col gap-3 sm:flex-row">
          <div className="flex-1">
            <Label htmlFor="bot-token" className="sr-only">
              Bot token
            </Label>
            <Input
              id="bot-token"
              required
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder="123456789:AA…"
              type="password"
              autoComplete="off"
            />
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? "Connecting…" : client.telegramConnected ? "Replace bot" : "Connect"}
          </Button>
        </form>
        {result && <p className="text-sm text-emerald-600 dark:text-emerald-400">{result}</p>}
        {error && (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ShareableBotLink({
  client,
  onChanged,
}: {
  client: ClientSummary;
  onChanged: () => void | Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetMsg, setResetMsg] = useState<string | null>(null);

  async function resetBinding() {
    setResetting(true);
    setResetMsg(null);
    try {
      await api(`/admin/clients/${client.id}/telegram/reset-binding`, { method: "POST" });
      setResetMsg("A fresh link was generated below — send it to the intended client.");
      await onChanged();
    } catch {
      setResetMsg("Couldn't reset the binding.");
    } finally {
      setResetting(false);
    }
  }

  // Bound and no pending link → the intended client is already chatting.
  if (client.telegramChatBound && !client.telegramDeepLink) {
    return (
      <div className="rounded-md border bg-muted/40 p-3">
        <p className="text-sm font-medium">Connected &amp; chatting ✓</p>
        <p className="mb-2 text-xs text-muted-foreground">
          @{client.telegramBotUsername} is linked to this client. If the wrong person linked, reset
          to issue a new secure link that only your intended client can use.
        </p>
        <Button variant="ghost" size="sm" type="button" onClick={resetBinding} disabled={resetting}>
          {resetting ? "Resetting…" : "Reset & issue new link"}
        </Button>
        {resetMsg && <p className="mt-2 text-xs text-muted-foreground">{resetMsg}</p>}
      </div>
    );
  }

  if (!client.telegramDeepLink) return null;

  return (
    <div className="rounded-md border bg-muted/40 p-3">
      <p className="text-sm font-medium">Send this secure link to the client</p>
      <p className="mb-2 text-xs text-muted-foreground">
        They tap it and press Start — no setup on their side. Only this exact link can link their
        account (a leaked bot name alone can’t), and it binds to the first person who opens it.
      </p>
      <div className="flex items-center gap-2">
        <Input readOnly value={client.telegramDeepLink} className="font-mono text-xs" />
        <Button
          variant="secondary"
          type="button"
          onClick={async () => {
            await navigator.clipboard.writeText(client.telegramDeepLink ?? "");
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? "Copied ✓" : "Copy"}
        </Button>
      </div>
      {resetMsg && <p className="mt-2 text-xs text-muted-foreground">{resetMsg}</p>}
    </div>
  );
}

function PreferencesCard({
  client,
  onChanged,
}: {
  client: ClientSummary;
  onChanged: () => void | Promise<void>;
}) {
  const [leads, setLeads] = useState<string[]>(client.reminderLeads.map(String));
  const [meetingLen, setMeetingLen] = useState(String(client.defaultMeetingMinutes));
  const [briefHour, setBriefHour] = useState(String(client.dailyBriefHour));
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOk(false);
    try {
      await api(`/admin/clients/${client.id}`, {
        method: "PATCH",
        body: {
          reminderLeads: leadsToMinutes(leads),
          defaultMeetingMinutes: Number(meetingLen),
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
        <CardTitle>Defaults</CardTitle>
        <CardDescription>
          Meeting reminders, default meeting length and the daily-summary hour. The client can
          change these too (portal or by asking the assistant), and override reminders per meeting.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-5">
          <ReminderLeadsEditor leads={leads} onChange={setLeads} idPrefix="admin" />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="pref-meetlen">Default meeting length</Label>
              <select
                id="pref-meetlen"
                className="w-full rounded-md border bg-background p-2 text-sm"
                value={meetingLen}
                onChange={(e) => setMeetingLen(e.target.value)}
              >
                {[15, 30, 45, 60, 90, 120, 180].map((m) => (
                  <option key={m} value={m}>
                    {m < 60 ? `${m} minutes` : `${m / 60} hour${m >= 120 ? "s" : ""}${m % 60 ? " 30 min" : ""}`}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pref-brief">Daily summary at</Label>
              <select
                id="pref-brief"
                className="w-full rounded-md border bg-background p-2 text-sm"
                value={briefHour}
                onChange={(e) => setBriefHour(e.target.value)}
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {h % 12 === 0 ? 12 : h % 12}:00 {h < 12 ? "AM" : "PM"}
                  </option>
                ))}
              </select>
            </div>
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

function GoogleCard({ client }: { client: ClientSummary }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ url: string }>(`/admin/clients/${client.id}/google/connect-url`, {
        method: "POST",
      });
      setUrl(res.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate link");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Google Calendar
          {client.googleNeedsReauth ? (
            <Badge variant="destructive">needs re-auth</Badge>
          ) : client.googleConnected ? (
            <Badge>connected</Badge>
          ) : null}
        </CardTitle>
        <CardDescription>
          Generate a one-time link (valid 15 minutes) and send it to the
          client — they sign in with their Google account and approve calendar
          access. No password ever touches this system.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button onClick={generate} disabled={busy} variant="outline">
          {busy ? "Generating…" : "Generate connection link"}
        </Button>
        {url && (
          <div className="flex items-center gap-2">
            <Input readOnly value={url} className="font-mono text-xs" />
            <Button
              variant="secondary"
              onClick={async () => {
                await navigator.clipboard.writeText(url);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? "Copied ✓" : "Copy"}
            </Button>
          </div>
        )}
        {error && (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function StatusCard({
  client,
  onChanged,
}: {
  client: ClientSummary;
  onChanged: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const disabling = client.status === "active";

  async function toggle() {
    if (disabling && !confirming) {
      setConfirming(true); // destructive action requires explicit confirmation
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/clients/${client.id}`, {
        method: "PATCH",
        body: { status: disabling ? "disabled" : "active" },
      });
      setConfirming(false);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update status");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Client status</CardTitle>
        <CardDescription>
          Disabling immediately stops the assistant from responding — webhooks
          are rejected and jobs skip this client. History and audit log are kept.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex items-center gap-3">
        <Button
          variant={disabling ? "destructive" : "default"}
          onClick={toggle}
          disabled={busy}
        >
          {busy
            ? "Working…"
            : disabling
              ? confirming
                ? "Click again to confirm disable"
                : "Disable client"
              : "Re-enable client"}
        </Button>
        {confirming && (
          <Button variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        )}
        {error && (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
