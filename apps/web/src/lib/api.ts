import type { HealthReport } from "@assistant/shared";

/**
 * Base URL of the NestJS API.
 * Server components read API_URL (docker-internal); the browser would use
 * NEXT_PUBLIC_API_URL. Defaults cover local dev.
 */
export function apiBaseUrl(): string {
  return (
    process.env.API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:3001"
  );
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
