"use client";

import { useState } from "react";
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

export function SetupTab({
  client,
  onChanged,
}: {
  client: ClientSummary;
  onChanged: () => void | Promise<void>;
}) {
  return (
    <div className="space-y-4">
      <TelegramCard client={client} onChanged={onChanged} />
      <GoogleCard client={client} />
      <StatusCard client={client} onChanged={onChanged} />
    </div>
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
        `Connected @${botUsername} — webhook registered. Ask the client to open t.me/${botUsername} and send any message to activate.`,
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
      <CardContent>
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
        {result && <p className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">{result}</p>}
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
