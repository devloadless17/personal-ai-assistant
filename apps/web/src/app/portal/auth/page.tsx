"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { setClientToken } from "@/lib/portal-client";

/**
 * Landing page for the Google login redirect. The session token arrives in
 * the URL fragment (#token=…) — never sent to any server — so we read it
 * client-side, store it, and move on to the portal.
 */
export default function PortalAuthPage() {
  const router = useRouter();

  useEffect(() => {
    const hash = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : "";
    const token = new URLSearchParams(hash).get("token");
    if (token) {
      setClientToken(token);
      router.replace("/portal");
    } else {
      router.replace("/portal/login?error=missing_token");
    }
  }, [router]);

  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <p className="text-sm text-muted-foreground">Signing you in…</p>
    </main>
  );
}
