import { fetchHealth } from "@/lib/api";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const health = await fetchHealth();

  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <div className="w-full max-w-sm space-y-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Assistant Admin</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Multi-tenant Telegram AI executive assistant
          </p>
        </div>

        <LoginForm />

        <div className="flex items-center gap-2 text-xs" data-testid="health-status">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              health.ok ? "bg-emerald-500" : "bg-red-500"
            }`}
            aria-hidden
          />
          {health.ok ? (
            <span className="text-muted-foreground">API &amp; database up</span>
          ) : (
            <span className="text-red-600 dark:text-red-400">
              API unreachable: {health.error}
            </span>
          )}
        </div>
      </div>
    </main>
  );
}
