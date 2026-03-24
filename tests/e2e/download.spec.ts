import { test, expect } from '@playwright/test';

test.use({ userAgent: 'Mozilla/5.0 (Linux; Kobo Touch 4.39) AppleWebKit/537.36' });

test('shows download page for e-reader user-agent', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#key-display')).toBeVisible();
});

test('generates and displays a 4-character key', async ({ page }) => {
  await page.goto('/');
  const key = page.locator('#key-display');
  await expect(key).not.toHaveText('\u2013\u2013\u2013\u2013', { timeout: 5000 });
  const text = await key.textContent();
  expect(text?.trim()).toMatch(/^[2-9A-HJ-NP-Z]{4}$/);
});

test('theme toggle works on download page', async ({ page }) => {
  await page.goto('/');
  const html = page.locator('html');
  const btn = page.locator('#theme-toggle');
  const initial = await html.getAttribute('data-theme');
  await btn.click();
  expect(await html.getAttribute('data-theme')).not.toBe(initial);
});
