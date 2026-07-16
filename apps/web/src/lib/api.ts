import type { HealthReport } from "@assistant/shared";

/**
 * Base URL of the NestJS API, for SERVER-SIDE fetches only (server
 * components / route handlers). In Docker this is the internal network URL
 * (http://api:3001); locally it defaults to the dev API port.
 *
 * Browser-side calls (Milestone 6+) must NOT use this — they go to the
 * same-origin `/api/*` path that Caddy routes to the API, so no runtime
 * env var is needed in the client bundle.
 */
export function apiBaseUrl(): string {
  return process.env.API_URL ?? "http://localhost:3001";
}

/** Deep health check against the API (never cached — always the truth). */
export async function fetchHealth(): Promise<
  { ok: true; report: HealthReport } | { ok: false; error: string }
> {
  try {
    const res = await fetch(`${apiBaseUrl()}/health`, { cache: "no-store" });
    if (!res.ok) {
      return { ok: false, error: `API responded ${res.status}` };
    }
    const report = (await res.json()) as HealthReport;
    return { ok: true, report };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unreachable",
    };
  }
}
