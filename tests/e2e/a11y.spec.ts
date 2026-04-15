import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.describe('Upload page (desktop)', () => {
  test('passes axe accessibility scan', async ({ page }) => {
    await page.goto('/');
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('drop zone is keyboard focusable', async ({ page }) => {
    await page.goto('/');
    await page.locator('#drop-zone').focus();
    await expect(page.locator('#drop-zone')).toBeFocused();
  });

  test('focuses status message after validation error', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles({
      name: 'test.epub',
      mimeType: 'application/epub+zip',
      buffer: Buffer.from('fake'),
    });
    await page.locator('#keyinput').fill('AB'); // invalid — not 4 chars
    await page.locator('#submit-btn').click();
    await expect(page.locator('#status-msg')).toBeFocused();
    await expect(page.locator('#status-msg')).toContainText('4-character key');
  });

  test('heading hierarchy: one h1 and h2 for each card section', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('h2')).toHaveCount(5); // Device key, Ebook file, URL, Conversion options, How it works
  });
});

test.describe('Download page (e-reader UA)', () => {
  test.use({ userAgent: 'Mozilla/5.0 (Linux; Kobo Touch 4.39) AppleWebKit/537.36' });

  test('passes axe accessibility scan', async ({ page }) => {
    await page.goto('/');
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('heading hierarchy: one h1', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toHaveCount(1);
  });
});
