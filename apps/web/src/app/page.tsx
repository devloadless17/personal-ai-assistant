"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ClientSummary } from "@assistant/shared";
import { api, clearToken, getToken } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { NewClientDialog } from "@/components/new-client-dialog";

export default function ClientsPage() {
  const router = useRouter();
  const [clients, setClients] = useState<ClientSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setClients(await api<ClientSummary[]>("/admin/clients"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load clients");
    }
  }, []);

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

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 p-8">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Clients</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Each client has an isolated assistant on their own Telegram bot.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <NewClientDialog onCreated={load} />
          <Button
            variant="ghost"
            onClick={() => {
              clearToken();
              router.replace("/login");
            }}
          >
            Sign out
          </Button>
        </div>
      </div>

      {error && (
        <p className="mb-4 text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      {clients === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : clients.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center">
          <p className="text-sm text-muted-foreground">
            No clients yet. Create your first client, then connect their
            Telegram bot and Google Calendar from the client page.
          </p>
        </div>
      ) : (
        <Table data-testid="clients-table">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Assistant</TableHead>
              <TableHead>Timezone</TableHead>
              <TableHead>Connections</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {clients.map((c) => (
              <TableRow key={c.id}>
                <TableCell>
                  <Link href={`/clients/${c.id}`} className="font-medium underline-offset-4 hover:underline">
                    {c.name}
                  </Link>
                </TableCell>
                <TableCell>{c.assistantName}</TableCell>
                <TableCell className="text-muted-foreground">{c.timezone}</TableCell>
                <TableCell>
                  <div className="flex gap-1.5">
                    <Badge variant={c.telegramConnected ? "default" : "outline"}>
                      Telegram{c.telegramConnected ? " ✓" : ""}
                    </Badge>
                    <Badge
                      variant={
                        c.googleNeedsReauth
                          ? "destructive"
                          : c.googleConnected
                            ? "default"
                            : "outline"
                      }
                    >
                      {c.googleNeedsReauth ? "Google — re-auth!" : `Google${c.googleConnected ? " ✓" : ""}`}
                    </Badge>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={c.status === "active" ? "secondary" : "destructive"}>
                    {c.status}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </main>
  );
}
