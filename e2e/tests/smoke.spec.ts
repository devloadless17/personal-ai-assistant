import { expect, test } from '@playwright/test';
import { API_URL } from '../playwright.config';

/**
 * Smoke: the two apps are up, talk to each other, and the API's deep health
 * check proves a real database round-trip.
 */

test('API deep health check reports db up', async ({ request }) => {
  const res = await request.get(`${API_URL}/health`);
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { status: string; db: string; timestamp: string };
  expect(body.status).toBe('ok');
  expect(body.db).toBe('up');
  expect(new Date(body.timestamp).getTime()).not.toBeNaN();
});

test('unauthenticated visit lands on login with a live health indicator', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Assistant Admin' })).toBeVisible();
  await expect(page.getByTestId('health-status')).toContainText('API & database up');
});

test('admin API rejects unauthenticated requests', async ({ request }) => {
  const res = await request.get(`${API_URL}/admin/clients`);
  expect(res.status()).toBe(401);
});
