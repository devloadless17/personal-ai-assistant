"use client";

/**
 * Browser-side API client for the CLIENT portal — separate token storage from
 * the admin dashboard, so the two sessions never mix. Same-origin `/api/*`.
 */

const TOKEN_KEY = "assistant_client_token";

export function getClientToken(): string | null {
  return typeof window === "undefined" ? null : localStorage.getItem(TOKEN_KEY);
}

export function setClientToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearClientToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class PortalError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function portalApi<T>(
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const { method = "GET", body, auth = true } = options;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) {
    const token = getClientToken();
    if (!token) {
      window.location.href = "/portal/login";
      throw new PortalError("Not logged in", 401);
    }
    headers.authorization = `Bearer ${token}`;
  }

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401 && auth) {
    clearClientToken();
    window.location.href = "/portal/login";
    throw new PortalError("Session expired", 401);
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = (await res.json()) as { message?: string | string[] };
      if (data.message) {
        message = Array.isArray(data.message) ? data.message.join(", ") : data.message;
      }
    } catch {
      // keep default
    }
    throw new PortalError(message, res.status);
  }
  return (await res.json()) as T;
}
