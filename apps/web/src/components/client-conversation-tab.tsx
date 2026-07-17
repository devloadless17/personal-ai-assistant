"use client";

import { useCallback, useEffect, useState } from "react";
import type { ConversationMessage, Paginated } from "@assistant/shared";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";

/** Super-admin read-only view of a client's assistant conversation, rendered as
 * chat bubbles (oldest → newest). Used to see how clients talk to the assistant
 * and improve it. The API returns newest-first pages; we reverse for display. */
export function ConversationTab({ clientId }: { clientId: string }) {
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  const load = useCallback(
    async (cur: string | null) => {
      try {
        const params = new URLSearchParams({ limit: "50" });
        if (cur) params.set("cursor", cur);
        const page = await api<Paginated<ConversationMessage>>(
          `/admin/clients/${clientId}/messages?${params.toString()}`,
        );
        // API is newest-first; prepend older pages so the list stays chronological.
        setMessages((prev) => [...[...page.items].reverse(), ...prev]);
        setCursor(page.nextCursor);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load conversation");
      } finally {
        setBusy(false);
      }
    },
    [clientId],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount; setState only post-await
    void load(null);
  }, [load]);

  return (
    <div className="space-y-3" data-testid="conversation-tab">
      {error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      {messages.length === 0 && !busy ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm text-muted-foreground">
            No messages yet. Every message this client exchanges with their assistant will
            appear here.
          </p>
        </div>
      ) : (
        <>
          {cursor && (
            <div className="flex justify-center">
              <Button variant="outline" size="sm" onClick={() => void load(cursor)} disabled={busy}>
                {busy ? "Loading…" : "Load earlier messages"}
              </Button>
            </div>
          )}
          <div className="space-y-2">
            {messages.map((m) => {
              const inbound = m.direction === "inbound";
              return (
                <div key={m.id} className={`flex ${inbound ? "justify-start" : "justify-end"}`}>
                  <div
                    className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${
                      inbound
                        ? "rounded-tl-sm bg-muted"
                        : "rounded-tr-sm bg-primary text-primary-foreground"
                    }`}
                  >
                    <p className="whitespace-pre-wrap break-words">{m.content}</p>
                    <p
                      className={`mt-1 text-[10px] ${
                        inbound ? "text-muted-foreground" : "text-primary-foreground/70"
                      }`}
                    >
                      {inbound ? "Client" : "Assistant"} · {new Date(m.createdAt).toLocaleString()}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
