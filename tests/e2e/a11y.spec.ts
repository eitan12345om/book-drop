import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const epub = (name: string) => ({
  name,
  mimeType: 'application/epub+zip',
  buffer: Buffer.from('PK\x03\x04fake'),
});

const uploadPageStates: [string, (page: Page) => Promise<void>][] = [
  ['with nothing selected', async () => {}],
  [
    'with one file selected',
    async (page) => {
      await page.locator('#file-input').setInputFiles(epub('test.epub'));
      await expect(page.locator('#zone-selected')).toBeVisible();
    },
  ],
  [
    'with several files selected',
    async (page) => {
      await page.locator('#file-input').setInputFiles([epub('a.epub'), epub('b.epub')]);
      await expect(page.locator('#zone-file-name')).toHaveText('2 files selected');
    },
  ],
  [
    'after sending several files',
    async (page) => {
      await page.route('/upload', (route) =>
        route.fulfill({
          json: {
            device: 'Kobo',
            filename: 'a.epub',
            conversionTool: null,
            url: null,
            metadataFailed: false,
          },
        })
      );
      await page.locator('#keyinput').fill('ABCD');
      await page.locator('#file-input').setInputFiles([epub('a.epub'), epub('b.epub')]);
      await page.locator('#submit-btn').click();
      await expect(page.locator('.toast')).toContainText('2 files sent to Kobo');
      await expect(page.locator('#zone-empty')).toBeVisible();
    },
  ],
];

test.describe('Upload page (desktop)', () => {
  for (const colorScheme of ['light', 'dark'] as const) {
    for (const [state, setUp] of uploadPageStates) {
      test(`passes axe accessibility scan ${state} (${colorScheme})`, async ({ page }) => {
        await page.emulateMedia({ colorScheme });
        await page.goto('/');
        await setUp(page);
        const results = await new AxeBuilder({ page }).analyze();
        expect(results.violations).toEqual([]);
      });
    }
  }

  for (const key of ['Enter', 'Space']) {
    test(`${key} on the file picker button opens the file chooser`, async ({ page }) => {
      await page.goto('/');
      const chooserPromise = page.waitForEvent('filechooser');
      await page.locator('#zone-pick').focus();
      await page.keyboard.press(key);
      expect((await chooserPromise).isMultiple()).toBe(true);
    });
  }

  test('clicking anywhere in the drop zone opens the file chooser', async ({ page }) => {
    await page.goto('/');
    const chooserPromise = page.waitForEvent('filechooser');
    await page.locator('#zone-limit').click();
    await chooserPromise;
  });

  test('Clear empties the selection without opening the file chooser', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles(epub('test.epub'));
    let choosers = 0;
    page.on('filechooser', () => choosers++);
    await page.locator('#zone-clear-btn').click();
    await expect(page.locator('#zone-empty')).toBeVisible();
    await expect(page.locator('#zone-pick')).toBeFocused();
    expect(choosers).toBe(0);
  });

  test('dropping a file onto the drop zone selects it', async ({ page }) => {
    await page.goto('/');
    const dataTransfer = await page.evaluateHandle(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['PK\x03\x04fake'], 'dropped.epub', { type: 'application/epub+zip' }));
      return dt;
    });
    await page.dispatchEvent('#drop-zone', 'drop', { dataTransfer });
    await expect(page.locator('#zone-file-name')).toHaveText('dropped.epub');
  });

  test('focuses status message after validation error', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles({
      name: 'test.epub',
      mimeType: 'application/epub+zip',
      buffer: Buffer.from('PK\x03\x04fake'),
    });
    await page.locator('#keyinput').fill('AB'); // invalid — not 4 chars
    await page.locator('#submit-btn').click();
    await expect(page.locator('#status-msg')).toBeFocused();
    await expect(page.locator('#status-msg')).toContainText('4-character key');
  });

  test('heading hierarchy: one h1 and h2 for each card section', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toHaveCount(1);
    // Device key, Ebook files, URL, Conversion options + "How it works" inside #howto-dialog
    await expect(page.locator('h2')).toHaveCount(5);
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
