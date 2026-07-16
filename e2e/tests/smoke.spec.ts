import { expect, test } from '@playwright/test';
import { API_URL } from '../playwright.config';

/**
 * Milestone 1 smoke: the two apps are up, talk to each other, and the API's
 * deep health check proves a real database round-trip.
 */

test('API deep health check reports db up', async ({ request }) => {
  const res = await request.get(`${API_URL}/health`);
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { status: string; db: string; timestamp: string };
  expect(body.status).toBe('ok');
  expect(body.db).toBe('up');
  expect(new Date(body.timestamp).getTime()).not.toBeNaN();
});

test('dashboard loads and shows a healthy API + database', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Assistant Admin' })).toBeVisible();
  // The status line must reflect a real, live health round-trip.
  await expect(page.getByTestId('health-status')).toContainText('API & database up');
});
