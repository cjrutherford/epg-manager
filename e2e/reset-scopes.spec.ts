import { test, expect, type Page } from '@playwright/test';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

async function login(page: Page) {
  await page.goto('/admin');
  const input = page.locator('.login-form input[type="password"]');
  await expect(input).toBeVisible({ timeout: 15000 });
  await input.fill(ADMIN_PASSWORD);
  await Promise.all([
    page.waitForResponse('**/api/auth'),
    page.locator('.login-form button[type="submit"]').click()
  ]);
  await expect(page.locator('.login-overlay')).not.toBeVisible({ timeout: 15000 });
}

async function openResetModal(page: Page) {
  const card = page.locator('.action-card.danger-card');
  await expect(card).toBeVisible({ timeout: 15000 });
  await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/reset/preview')),
    card.click()
  ]);
  await expect(page.locator('.reset-modal')).toBeVisible();
}

test.describe('Scoped reset', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('offers four scopes and defaults to the narrowest', async ({ page }) => {
    await openResetModal(page);

    const scopes = page.locator('.reset-scope-btn');
    await expect(scopes).toHaveCount(4);
    await expect(scopes.nth(0)).toContainText('Clear guide data');
    await expect(scopes.nth(1)).toContainText('Reset my data');
    await expect(scopes.nth(2)).toContainText('Rebuild collection cache');
    await expect(scopes.nth(3)).toContainText('Erase everything');

    // Narrowest scope is preselected — the destructive options require a choice
    await expect(scopes.nth(0)).toHaveAttribute('aria-pressed', 'true');
    await expect(scopes.nth(3)).toHaveAttribute('aria-pressed', 'false');
  });

  test('shows a pre-flight count before anything is destroyed', async ({ page }) => {
    await openResetModal(page);

    const preview = page.locator('.reset-preview');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('This removes');

    // Nothing has been sent yet — the modal is a preview until confirmed
    await expect(page.locator('.reset-modal')).toBeVisible();
  });

  test('preview changes with the selected scope', async ({ page }) => {
    await openResetModal(page);

    const responses: string[] = [];
    page.on('response', r => {
      if (r.url().includes('/api/reset/preview')) responses.push(r.url());
    });

    await page.locator('.reset-scope-btn').nth(2).click();
    await expect.poll(() => responses.some(u => u.includes('scope=collection'))).toBe(true);
    await expect(page.locator('.reset-scope-btn').nth(2)).toHaveAttribute('aria-pressed', 'true');
  });

  test('cancel closes without issuing a reset', async ({ page }) => {
    await openResetModal(page);

    let resetCalled = false;
    page.on('request', r => {
      if (r.method() === 'POST' && r.url().endsWith('/api/reset')) resetCalled = true;
    });

    await page.locator('.modal-actions .btn-secondary').click();
    await expect(page.locator('.reset-modal')).not.toBeVisible();
    expect(resetCalled).toBe(false);
  });

  test('confirming a guide reset leaves the server serving', async ({ page }) => {
    await openResetModal(page);

    const [response] = await Promise.all([
      page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/reset')),
      page.locator('.modal-actions .btn-danger').click()
    ]);

    expect(response.status()).toBe(200);
    expect((await response.json()).scope).toBe('guide');

    // The database was truncated in place, not unlinked — the API keeps answering
    const health = await page.request.get('/api/health');
    expect(health.status()).toBe(200);
  });
});
