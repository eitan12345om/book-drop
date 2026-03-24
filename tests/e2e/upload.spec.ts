import { test, expect } from '@playwright/test';

test('shows upload page for desktop user-agent', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#upload-form')).toBeVisible();
});

test('theme toggle switches between dark and light', async ({ page }) => {
  await page.goto('/');
  const html = page.locator('html');
  const btn = page.locator('#theme-toggle');

  const initial = await html.getAttribute('data-theme');
  await btn.click();
  const toggled = await html.getAttribute('data-theme');
  expect(toggled).not.toBe(initial);
  expect(['dark', 'light']).toContain(toggled);
});

test('upload form submit button is disabled without a key', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#submit-btn')).toBeDisabled();
});

test('upload a text file and see success message', async ({ page }) => {
  const apiRes = await page.request.post('/generate', {
    headers: { 'User-Agent': 'Kobo/4.0 Test' },
  });
  const key = (await apiRes.text()).trim();

  await page.goto('/');
  await page.locator('#keyinput').fill(key);
  await page.locator('#file-input').setInputFiles({
    name: 'test.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello ebook'),
  });
  await page.locator('#submit-btn').click();

  await expect(page.locator('#status-msg')).toContainText('Sent to', { timeout: 10_000 });
});

test('key input is preserved after a successful upload', async ({ page }) => {
  const apiRes = await page.request.post('/generate', {
    headers: { 'User-Agent': 'Kobo/4.0 Test' },
  });
  const key = (await apiRes.text()).trim();

  await page.goto('/');
  await page.locator('#keyinput').fill(key);
  await page.locator('#file-input').setInputFiles({
    name: 'test.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello ebook'),
  });
  await page.locator('#submit-btn').click();
  await expect(page.locator('#status-msg')).toContainText('Sent to', { timeout: 10_000 });

  await expect(page.locator('#keyinput')).toHaveValue(key);
});
