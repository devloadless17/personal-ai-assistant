"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ClientSummary } from "@assistant/shared";
import { api, getToken } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SetupTab } from "@/components/client-setup-tab";
import { AuditTab } from "@/components/client-audit-tab";
import { ConversationTab } from "@/components/client-conversation-tab";

interface Usage {
  messagesIn: number;
  messagesOut: number;
  toolCalls: number;
  toolFailures: number;
  lastActivity: string | null;
}

export default function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [client, setClient] = useState<ClientSummary | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [c, u] = await Promise.all([
        api<ClientSummary>(`/admin/clients/${id}`),
        api<Usage>(`/admin/clients/${id}/usage`),
      ]);
      setClient(c);
      setUsage(u);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load client");
    }
  }, [id]);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    // Canonical fetch-on-mount: every setState inside load() happens after an
    // await, so no synchronous state update occurs during the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, router]);

  if (error) {
    return (
      <main className="mx-auto w-full max-w-4xl flex-1 p-8">
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>
      </main>
    );
  }
  if (!client) {
    return (
      <main className="mx-auto w-full max-w-4xl flex-1 p-8">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 p-8">
      <div className="mb-2">
        <Link href="/" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          ← All clients
        </Link>
      </div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{client.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Assistant “{client.assistantName}” · {client.timezone}
          </p>
        </div>
        <Badge variant={client.status === "active" ? "secondary" : "destructive"}>
          {client.status}
        </Badge>
      </div>

      {usage && (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="usage-strip">
          <Stat label="Messages in" value={usage.messagesIn} />
          <Stat label="Messages out" value={usage.messagesOut} />
          <Stat label="Tool calls" value={usage.toolCalls} />
          <Stat
            label="Tool failures"
            value={usage.toolFailures}
            tone={usage.toolFailures > 0 ? "bad" : "good"}
          />
        </div>
      )}

      <Tabs defaultValue="setup">
        <TabsList>
          <TabsTrigger value="setup">Setup</TabsTrigger>
          <TabsTrigger value="conversation">Conversation</TabsTrigger>
          <TabsTrigger value="audit">Audit log</TabsTrigger>
        </TabsList>
        <TabsContent value="setup" className="pt-4">
          <SetupTab client={client} onChanged={load} />
        </TabsContent>
        <TabsContent value="conversation" className="pt-4">
          <ConversationTab clientId={client.id} />
        </TabsContent>
        <TabsContent value="audit" className="pt-4">
          <AuditTab clientId={client.id} />
        </TabsContent>
      </Tabs>
    </main>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "good" | "bad";
}) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={`mt-1 text-lg font-semibold ${
          tone === "bad" ? "text-red-600 dark:text-red-400" : ""
        }`}
      >
        {value}
      </p>
    </div>
  );
}
