import { fetchHealth } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const health = await fetchHealth();

  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <div className="w-full max-w-md rounded-xl border border-black/10 dark:border-white/15 p-8 shadow-sm">
        <h1 className="text-xl font-semibold tracking-tight">
          Assistant Admin
        </h1>
        <p className="mt-1 text-sm text-black/60 dark:text-white/60">
          Multi-tenant Telegram AI executive assistant
        </p>

        <div className="mt-6 flex items-center gap-3" data-testid="health-status">
          <span
            className={`inline-block h-2.5 w-2.5 rounded-full ${
              health.ok ? "bg-emerald-500" : "bg-red-500"
            }`}
            aria-hidden
          />
          {health.ok ? (
            <span className="text-sm">
              API &amp; database up
              <span className="ml-2 font-mono text-xs text-black/50 dark:text-white/50">
                {health.report.timestamp}
              </span>
            </span>
          ) : (
            <span className="text-sm text-red-600 dark:text-red-400">
              API unreachable: {health.error}
            </span>
          )}
        </div>

        <p className="mt-6 text-xs text-black/40 dark:text-white/40">
          Milestone 1 scaffold — client management arrives in Milestone 6.
        </p>
      </div>
    </main>
  );
}
