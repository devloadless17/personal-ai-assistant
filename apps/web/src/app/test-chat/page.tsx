"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ClientSummary } from "@assistant/shared";
import { api, getToken } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

/**
 * DEV TEST CHAT — drives the exact same agent pipeline a Telegram message
 * does (same model, tools, tenancy, audit log); only the transport differs.
 * The backing endpoint exists only when the API runs in development.
 */
export default function TestChatPage() {
  const router = useRouter();
  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const list = await api<ClientSummary[]>("/admin/clients");
      setClients(list);
      if (list[0]) setSelected((cur) => cur ?? list[0]!.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load clients");
    }
  }, []);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount; setState only post-await
    void load();
  }, [load, router]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !input.trim() || busy) return;
    const text = input.trim();
    setInput("");
    setError(null);
    setMessages((m) => [...m, { role: "user", text }]);
    setBusy(true);
    try {
      const { reply } = await api<{ reply: string }>("/dev/chat", {
        method: "POST",
        body: { clientId: selected, message: text },
        auth: false,
      });
      setMessages((m) => [...m, { role: "assistant", text: reply }]);
    } catch (err) {
      setError(
        err instanceof Error
          ? `${err.message} (note: this test chat only works while the API runs in development mode)`
          : "Send failed",
      );
    } finally {
      setBusy(false);
    }
  }

  const client = clients.find((c) => c.id === selected);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <Link href="/" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
            ← All clients
          </Link>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">Test chat</h1>
          <p className="text-sm text-muted-foreground">
            The exact pipeline Telegram uses — same brain, tools, and audit log.
          </p>
        </div>
        <select
          className="rounded-md border bg-background p-2 text-sm"
          value={selected ?? ""}
          onChange={(e) => {
            setSelected(e.target.value);
            setMessages([]);
          }}
          aria-label="Client"
        >
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {client && (
        <div className="mb-3 flex gap-1.5">
          <Badge variant="outline">{client.timezone}</Badge>
          <Badge variant={client.googleConnected ? "default" : "outline"}>
            Google{client.googleConnected ? " ✓" : " not connected"}
          </Badge>
          <Badge variant="outline">assistant: {client.assistantName}</Badge>
        </div>
      )}

      <div className="flex-1 space-y-3 overflow-y-auto rounded-lg border p-4" data-testid="chat-thread">
        {messages.length === 0 && (
          <p className="text-center text-sm text-muted-foreground">
            Say hi — try “what do I have today?” or “add a task to call the bank tomorrow”.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm ${
                m.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted"
              }`}
            >
              {m.text}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <div className="rounded-2xl bg-muted px-4 py-2 text-sm text-muted-foreground">
              thinking…
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      <form onSubmit={send} className="mt-3 flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message your assistant…"
          disabled={busy || !selected}
          autoFocus
        />
        <Button type="submit" disabled={busy || !input.trim() || !selected}>
          Send
        </Button>
      </form>
    </main>
  );
}
