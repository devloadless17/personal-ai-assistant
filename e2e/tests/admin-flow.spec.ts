import { expect, test } from '@playwright/test';
import { env } from '../env';

/**
 * Full admin UX flow against the running stack: login → create a client →
 * see it listed → open its detail page (setup + audit tabs).
 * Uses the same bootstrap credentials the API was started with.
 */

const EMAIL = env('ADMIN_EMAIL');
const PASSWORD = env('ADMIN_PASSWORD');

test.describe('admin dashboard flow', () => {
  test.skip(!EMAIL || !PASSWORD, 'ADMIN_EMAIL/ADMIN_PASSWORD not configured');

  test('login → create client → detail page shows setup and audit', async ({ page }) => {
    const clientName = `E2E Client ${Date.now()}`;

    // ── Login
    await page.goto('/login');
    await page.getByLabel('Email').fill(EMAIL as string);
    await page.getByLabel('Password').fill(PASSWORD as string);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible();

    // ── Create a client
    await page.getByTestId('new-client-button').click();
    await page.getByLabel('Client name').fill(clientName);
    await page.getByLabel('Timezone (IANA)').fill('Asia/Riyadh');
    await page.getByLabel('Assistant name').fill('Aya');
    await page.getByRole('button', { name: 'Create client' }).click();

    // ── Appears in the list
    await expect(page.getByRole('link', { name: clientName })).toBeVisible();

    // ── Detail page
    await page.getByRole('link', { name: clientName }).click();
    await expect(page.getByRole('heading', { name: clientName })).toBeVisible();
    await expect(page.getByTestId('usage-strip')).toBeVisible();
    await expect(page.getByText('Telegram bot')).toBeVisible();
    await expect(page.getByText('Google Calendar')).toBeVisible();

    // ── Audit tab: empty state with the reliability promise
    await page.getByRole('tab', { name: 'Audit log' }).click();
    await expect(page.getByTestId('audit-tab')).toContainText('No tool calls yet');

    // ── Wrong login is rejected (honest error, no fake session)
    await page.getByRole('link', { name: '← All clients' }).click();
    await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel('Email').fill(EMAIL as string);
    await page.getByLabel('Password').fill('definitely-wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByTestId('login-form').getByRole('alert')).toContainText(
      'Invalid email or password',
    );
  });
});
