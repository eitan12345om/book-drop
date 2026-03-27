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

test('theme toggle hidden on e-reader user-agent', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#theme-toggle')).not.toBeVisible();
});

test('theme toggle visible on desktop /receive', async ({ browser }) => {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 TestBrowser',
    baseURL: 'http://localhost:3001',
  });
  const page = await context.newPage();
  await page.goto('/receive');
  await expect(page.locator('#theme-toggle')).toBeVisible();
  await context.close();
});

test('shows QR code after key is generated', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#key-display')).not.toHaveText('\u2013\u2013\u2013\u2013', {
    timeout: 5000,
  });
  await expect(page.locator('#qr-code')).toBeVisible();
  const src = await page.locator('#qr-code').getAttribute('src');
  expect(src).toMatch(/^\/qr\/[2-9A-Z]{4}$/);
});

test('QR code updates when refresh button is clicked', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#key-display')).not.toHaveText('\u2013\u2013\u2013\u2013', {
    timeout: 5000,
  });
  const firstSrc = await page.locator('#qr-code').getAttribute('src');

  await page.locator('#refresh-btn').click();
  await expect(page.locator('#key-display')).not.toHaveText('\u2013\u2013\u2013\u2013', {
    timeout: 5000,
  });

  const secondSrc = await page.locator('#qr-code').getAttribute('src');
  expect(secondSrc).toMatch(/^\/qr\/[2-9A-Z]{4}$/);
  expect(secondSrc).not.toBe(firstSrc);
});
