"use client";

import { useCallback, useEffect, useState } from "react";
import type { AuditLogEntry, Paginated } from "@assistant/shared";
import { api } from "@/lib/api-client";
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

type Filter = "all" | "success" | "failure";

export function AuditTab({ clientId }: { clientId: string }) {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Starts true: the mount effect immediately loads, so no synchronous
  // setState is needed inside the effect (react-hooks/set-state-in-effect).
  const [busy, setBusy] = useState(true);

  const load = useCallback(
    async (reset: boolean, cur: string | null, f: Filter) => {
      try {
        const params = new URLSearchParams({ limit: "25" });
        if (cur && !reset) params.set("cursor", cur);
        if (f !== "all") params.set("success", f === "success" ? "true" : "false");
        const page = await api<Paginated<AuditLogEntry>>(
          `/admin/clients/${clientId}/audit?${params.toString()}`,
        );
        setEntries((prev) => (reset ? page.items : [...prev, ...page.items]));
        setCursor(page.nextCursor);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load audit log");
      } finally {
        setBusy(false);
      }
    },
    [clientId],
  );

  useEffect(() => {
    // Canonical fetch-on-mount/filter-change: busy starts true (mount) or is
    // set in the click handler (filter); load() only sets state post-await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(true, null, filter);
  }, [load, filter]);

  return (
    <div className="space-y-3" data-testid="audit-tab">
      <div className="flex gap-2">
        {(["all", "success", "failure"] as const).map((f) => (
          <Button
            key={f}
            size="sm"
            variant={filter === f ? "default" : "outline"}
            onClick={() => {
              setBusy(true);
              setError(null);
              setFilter(f);
            }}
          >
            {f === "all" ? "All" : f === "success" ? "Succeeded" : "Failed"}
          </Button>
        ))}
      </div>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      {entries.length === 0 && !busy ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm text-muted-foreground">
            No tool calls yet. Every action the assistant takes will appear
            here with its exact input and result.
          </p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Tool</TableHead>
              <TableHead>Outcome</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((e) => (
              <>
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {new Date(e.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{e.toolName}</TableCell>
                  <TableCell>
                    <Badge variant={e.success ? "secondary" : "destructive"}>
                      {e.success ? "success" : "failed"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                    >
                      {expanded === e.id ? "Hide" : "Details"}
                    </Button>
                  </TableCell>
                </TableRow>
                {expanded === e.id && (
                  <TableRow key={`${e.id}-detail`}>
                    <TableCell colSpan={4}>
                      <div className="grid gap-2 py-1 sm:grid-cols-2">
                        <JsonBlock label="Input" value={e.input} />
                        <JsonBlock label="Result" value={e.result} />
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </>
            ))}
          </TableBody>
        </Table>
      )}

      {cursor && (
        <Button
          variant="outline"
          onClick={() => {
            setBusy(true);
            void load(false, cursor, filter);
          }}
          disabled={busy}
        >
          {busy ? "Loading…" : "Load more"}
        </Button>
      )}
    </div>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
      <pre className="max-h-56 overflow-auto rounded-md bg-muted p-2 text-xs">
        {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
