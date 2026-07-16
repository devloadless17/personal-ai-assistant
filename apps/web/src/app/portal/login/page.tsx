"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { portalApi } from "@/lib/portal-client";
import { Button } from "@/components/ui/button";

function LoginInner() {
  const params = useSearchParams();
  const error = params.get("error");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setFailed(null);
    try {
      const { url } = await portalApi<{ url: string }>("/client/auth/google/start", {
        auth: false,
      });
      window.location.href = url;
    } catch (err) {
      setFailed(err instanceof Error ? err.message : "Could not start sign-in");
      setBusy(false);
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <div className="w-full max-w-sm space-y-6 text-center">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Your Assistant</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Sign in with the Google account your administrator set up for you.
          </p>
        </div>

        <Button className="w-full" onClick={signIn} disabled={busy} data-testid="google-signin">
          {busy ? "Redirecting…" : "Sign in with Google"}
        </Button>

        {(error || failed) && (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">
            {failed ?? error}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Signing in also lets your assistant manage your Google Calendar.
        </p>
      </div>
    </main>
  );
}

export default function PortalLoginPage() {
  return (
    <Suspense>
      <LoginInner />
    </Suspense>
  );
}
