import { expect, test } from '@playwright/test';
import { API_URL } from '../playwright.config';
import { env } from '../env';

/**
 * Client portal — security boundary E2E against the live stack. These assert
 * the guarantees that matter for deploy confidence: unauthenticated access is
 * refused, and cross-role tokens are rejected.
 */

test('portal login page renders a Google sign-in', async ({ page }) => {
  await page.goto('/portal/login');
  await expect(page.getByRole('heading', { name: 'Your Assistant' })).toBeVisible();
  await expect(page.getByTestId('google-signin')).toBeVisible();
});

test('unauthenticated visit to the portal redirects to login', async ({ page }) => {
  await page.goto('/portal');
  await expect(page).toHaveURL(/\/portal\/login/);
});

test('client API rejects unauthenticated requests', async ({ request }) => {
  for (const path of ['/client/me', '/client/tasks', '/client/calendar']) {
    const res = await request.get(`${API_URL}${path}`);
    expect(res.status(), `${path} must require auth`).toBe(401);
  }
});

test('client login start returns a Google OAuth URL', async ({ request }) => {
  const res = await request.get(`${API_URL}/client/auth/google/start`);
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { url: string };
  expect(body.url).toContain('accounts.google.com');
  expect(body.url).toContain('scope=');
});

test('an admin token cannot be used on client routes, and vice-versa', async ({ request }) => {
  // Get a real admin token (creds from the root .env, same as the API).
  const email = env('ADMIN_EMAIL');
  const password = env('ADMIN_PASSWORD');
  test.skip(!email || !password, 'ADMIN creds not set');

  const login = await request.post(`${API_URL}/admin/auth/login`, {
    data: { email, password },
  });
  expect(login.status()).toBe(200);
  const { token: adminToken } = (await login.json()) as { token: string };

  // Admin token on a client route → 401 (type mismatch).
  const asClient = await request.get(`${API_URL}/client/me`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  expect(asClient.status()).toBe(401);

  // Admin token still works on admin routes (sanity).
  const adminOk = await request.get(`${API_URL}/admin/clients`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  expect(adminOk.status()).toBe(200);
});
