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

test('autoselects kindlegen when key belongs to a Kindle device', async ({ page }) => {
  const apiRes = await page.request.post('/generate', {
    headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux armv7l) Kindle/3.0' },
  });
  const key = (await apiRes.text()).trim();

  await page.goto('/');
  await page.locator('#keyinput').fill(key);

  await expect(page.locator('#kindlegen')).toBeChecked({ timeout: 3_000 });
  await expect(page.locator('#kepubify')).not.toBeChecked();
});

test('autoselects kepubify when key belongs to a Kobo device', async ({ page }) => {
  const apiRes = await page.request.post('/generate', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Kobo Touch 4.39) AppleWebKit/537.36' },
  });
  const key = (await apiRes.text()).trim();

  await page.goto('/');
  // kepubify is checked by default; fill a non-Kobo key first to clear it, then fill the Kobo key
  await page.locator('#kindlegen').check();
  await expect(page.locator('#kepubify')).not.toBeChecked();
  await page.locator('#keyinput').fill(key);

  await expect(page.locator('#kepubify')).toBeChecked({ timeout: 3_000 });
  await expect(page.locator('#kindlegen')).not.toBeChecked();
});

test('clears format converters when key belongs to a Tolino device', async ({ page }) => {
  const apiRes = await page.request.post('/generate', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 4.4; Tolino)' },
  });
  const key = (await apiRes.text()).trim();

  await page.goto('/');
  await page.locator('#keyinput').fill(key);

  await expect(page.locator('#kepubify')).not.toBeChecked({ timeout: 3_000 });
  await expect(page.locator('#kindlegen')).not.toBeChecked();
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

test('update metadata option is disabled when no file is selected', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#fetchmetadata')).toBeDisabled();
});

test('update metadata option is disabled for non-EPUB files', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file-input').setInputFiles({
    name: 'test.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('fake pdf'),
  });
  await expect(page.locator('#fetchmetadata')).toBeDisabled();
});

test('update metadata option is enabled for EPUB files', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file-input').setInputFiles({
    name: 'test.epub',
    mimeType: 'application/epub+zip',
    buffer: Buffer.from('fake epub'),
  });
  await expect(page.locator('#fetchmetadata')).toBeEnabled();
});
