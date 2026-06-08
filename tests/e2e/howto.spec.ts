import { test, expect } from '@playwright/test';

// Override the global storageState so each test starts as a first-time visitor.
test.use({ storageState: { cookies: [], origins: [] } });

test('first visit auto-opens the how-it-works modal', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#howto-dialog')).toHaveAttribute('open', '');
  await expect(page.locator('#howto-title')).toBeVisible();
});

test('does not auto-open on subsequent visits', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#howto-dialog')).toHaveAttribute('open', '');
  // Close via Escape
  await page.keyboard.press('Escape');
  await expect(page.locator('#howto-dialog')).not.toHaveAttribute('open', '');

  await page.reload();
  await expect(page.locator('#howto-dialog')).not.toHaveAttribute('open', '');
});

test('clicking the help button re-opens the modal after dismissal', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Escape');
  await expect(page.locator('#howto-dialog')).not.toHaveAttribute('open', '');

  await page.locator('#howto-toggle').click();
  await expect(page.locator('#howto-dialog')).toHaveAttribute('open', '');
});

test('closing the modal persists bookdrop-howto-seen in localStorage', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Escape');
  await expect(page.locator('#howto-dialog')).not.toHaveAttribute('open', '');
  const value = await page.evaluate(() => localStorage.getItem('bookdrop-howto-seen'));
  expect(value).toBe('1');
});

test('"Got it" button closes the modal', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#howto-dialog')).toHaveAttribute('open', '');
  await page.locator('.howto-got-it').click();
  await expect(page.locator('#howto-dialog')).not.toHaveAttribute('open', '');
});

test('close (x) button closes the modal', async ({ page }) => {
  await page.goto('/');
  await page.locator('.howto-close').click();
  await expect(page.locator('#howto-dialog')).not.toHaveAttribute('open', '');
});

test('does not auto-open when ?key= is in the URL', async ({ page }) => {
  await page.goto('/?key=ABCD');
  // Give the script time to evaluate
  await expect(page.locator('#keyinput')).toHaveValue('ABCD');
  await expect(page.locator('#howto-dialog')).not.toHaveAttribute('open', '');
});
