"use client";

/**
 * Browser-side API client for the admin dashboard.
 * - Always same-origin `/api/*` (Next rewrite in dev, reverse proxy in prod).
 * - Bearer token from localStorage; any 401 clears it and redirects to login.
 * - Non-2xx responses throw with the API's message — callers surface it,
 *   never swallow it.
 */

const TOKEN_KEY = "assistant_admin_token";

export function getToken(): string | null {
  return typeof window === "undefined" ? null : localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const { method = "GET", body, auth = true } = options;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) {
    const token = getToken();
    if (!token) {
      window.location.href = "/login";
      throw new ApiError("Not logged in", 401);
    }
    headers.authorization = `Bearer ${token}`;
  }

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401 && auth) {
    clearToken();
    window.location.href = "/login";
    throw new ApiError("Session expired", 401);
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = (await res.json()) as { message?: string | string[] };
      if (data.message) {
        message = Array.isArray(data.message) ? data.message.join(", ") : data.message;
      }
    } catch {
      // keep default message
    }
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as T;
}
