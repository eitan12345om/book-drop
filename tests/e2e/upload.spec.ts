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
  const key = (await apiRes.json()).key as string;

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
  const key = (await apiRes.json()).key as string;

  await page.goto('/');
  await page.locator('#keyinput').fill(key);

  await expect(page.locator('#kindlegen')).toBeChecked({ timeout: 3_000 });
  await expect(page.locator('#kepubify')).not.toBeChecked();
});

test('autoselects kepubify when key belongs to a Kobo device', async ({ page }) => {
  const apiRes = await page.request.post('/generate', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Kobo Touch 4.39) AppleWebKit/537.36' },
  });
  const key = (await apiRes.json()).key as string;

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
  const key = (await apiRes.json()).key as string;

  await page.goto('/');
  await page.locator('#keyinput').fill(key);

  await expect(page.locator('#kepubify')).not.toBeChecked({ timeout: 3_000 });
  await expect(page.locator('#kindlegen')).not.toBeChecked();
});

test('key input is preserved after a successful upload', async ({ page }) => {
  const apiRes = await page.request.post('/generate', {
    headers: { 'User-Agent': 'Kobo/4.0 Test' },
  });
  const key = (await apiRes.json()).key as string;

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

test('pre-fills key from URL parameter and auto-selects device', async ({ page }) => {
  const apiRes = await page.request.post('/generate', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Kobo Touch 4.39) AppleWebKit/537.36' },
  });
  const key = (await apiRes.json()).key as string;

  await page.goto(`/?key=${key}`);
  await expect(page.locator('#keyinput')).toHaveValue(key);
  await expect(page.locator('#kepubify')).toBeChecked({ timeout: 5_000 });
});

test('update metadata option is enabled when no file is selected', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#fetchmetadata')).toBeEnabled();
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

test('uploads multiple files sequentially and both appear on download page', async ({
  browser,
}) => {
  const koboUA = 'Mozilla/5.0 (Linux; Kobo Touch 4.39) AppleWebKit/537.36';

  // Open Kobo download page first so it generates its own key
  const koboCtx = await browser.newContext({
    userAgent: koboUA,
    baseURL: 'http://localhost:3001',
  });
  const koboPage = await koboCtx.newPage();
  await koboPage.goto('/');
  await expect(koboPage.locator('#key-display')).not.toHaveText('\u2013\u2013\u2013\u2013', {
    timeout: 5_000,
  });
  const key = (await koboPage.locator('#key-display').textContent())?.trim() as string;

  // Upload two files to that key from the upload page
  const uploadCtx = await browser.newContext({ baseURL: 'http://localhost:3001' });
  const uploadPage = await uploadCtx.newPage();
  await uploadPage.goto('/');
  await uploadPage.locator('#keyinput').fill(key);
  await uploadPage.locator('#file-input').setInputFiles([
    { name: 'first.txt', mimeType: 'text/plain', buffer: Buffer.from('first file') },
    { name: 'second.txt', mimeType: 'text/plain', buffer: Buffer.from('second file') },
  ]);
  await uploadPage.locator('#submit-btn').click();
  await expect(uploadPage.locator('#status-msg')).toContainText('sent', {
    timeout: 15_000,
    ignoreCase: true,
  });
  await uploadCtx.close();

  // Both download links should appear on the Kobo page (via SSE/polling)
  await expect(koboPage.locator('#download-list a')).toHaveCount(2, { timeout: 10_000 });
  const names = await koboPage
    .locator('#download-list a')
    .evaluateAll((links) => (links as HTMLAnchorElement[]).map((a) => a.textContent?.trim() ?? ''));
  expect(names).toContain('first.txt');
  expect(names).toContain('second.txt');
  await koboCtx.close();
});

test('disables conversion options when multiple files are selected', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file-input').setInputFiles([
    { name: 'first.epub', mimeType: 'application/epub+zip', buffer: Buffer.from('fake epub 1') },
    { name: 'second.epub', mimeType: 'application/epub+zip', buffer: Buffer.from('fake epub 2') },
  ]);
  await expect(page.locator('#kepubify')).toBeDisabled();
  await expect(page.locator('#kindlegen')).toBeDisabled();
  await expect(page.locator('#options-note')).toBeVisible();
});

test('re-enables submit button and shows actionable hint after a network-level upload failure', async ({
  page,
}) => {
  const apiRes = await page.request.post('/generate', {
    headers: { 'User-Agent': 'Kobo/4.0 Test' },
  });
  const key = (await apiRes.json()).key as string;

  await page.goto('/');
  await page.locator('#keyinput').fill(key);
  await page.locator('#file-input').setInputFiles({
    name: 'test.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello ebook'),
  });

  // Abort the upload at the network level to trigger the XHR error handler.
  await page.route('/upload', (route) => route.abort());
  await page.locator('#submit-btn').click();

  // Allow extra time: the handler retries once (arrayBuffer + second XHR) before giving up
  await expect(page.locator('#status-msg')).toHaveClass(/status-error/, { timeout: 10_000 });
  await expect(page.locator('#submit-btn')).toBeEnabled();
});
