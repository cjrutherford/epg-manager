import { test, expect } from '@playwright/test';

test.describe('Web UI', () => {
  test('loads the main page', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/IPTV EPG Manager/);
    await expect(page.locator('h1')).toContainText('IPTV EPG Manager');
  });

  test('shows configuration card', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#page-config')).toBeVisible();
    await expect(page.locator('#page-config h2')).toContainText('Configuration');
  });

  test('playlist selector is present', async ({ page }) => {
    await page.goto('/');
    const select = page.locator('#playlistSelect');
    await expect(select).toBeVisible();
  });

  test('playlist selector has options', async ({ page }) => {
    await page.goto('/');
    const select = page.locator('#playlistSelect');
    
    // Wait for options to load (initial "Loading..." will be replaced)
    await page.waitForFunction(() => {
      const sel = document.querySelector('#playlistSelect') as HTMLSelectElement;
      return sel && sel.options.length > 1;
    }, { timeout: 10000 });
    
    const options = await select.locator('option').count();
    expect(options).toBeGreaterThan(1);
  });

  test('EPG days input is present and has default', async ({ page }) => {
    await page.goto('/');
    const input = page.locator('#epgDaysInput');
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('2');
  });

  test('metadata enrichment checkbox is present', async ({ page }) => {
    await page.goto('/');
    const checkbox = page.locator('#metadataEnabled');
    await expect(checkbox).toBeVisible();
  });

  test('save configuration button is present', async ({ page }) => {
    await page.goto('/');
    const button = page.locator('button:has-text("Save Configuration")');
    await expect(button).toBeVisible();
  });

  test('header has navigation buttons (hidden initially)', async ({ page }) => {
    await page.goto('/');
    const navButtons = page.locator('#navButtons');
    // Initially hidden until config is set
    await expect(navButtons).toHaveClass(/hidden/);
  });

  test('channel mapping page is hidden initially', async ({ page }) => {
    await page.goto('/');
    const mappingPage = page.locator('#page-mapping');
    await expect(mappingPage).toHaveClass(/hidden/);
  });

  test('status panel is hidden initially', async ({ page }) => {
    await page.goto('/');
    const statusPanel = page.locator('#statusPanel');
    await expect(statusPanel).toHaveClass(/hidden/);
  });

  test('can select a playlist', async ({ page }) => {
    await page.goto('/');
    
    // Wait for options to load
    await page.waitForFunction(() => {
      const sel = document.querySelector('#playlistSelect') as HTMLSelectElement;
      return sel && sel.options.length > 1;
    }, { timeout: 10000 });
    
    const select = page.locator('#playlistSelect');
    
    // Get the second option (first real option after "Loading...")
    const options = await select.locator('option').all();
    if (options.length > 1) {
      const value = await options[1].getAttribute('value');
      if (value) {
        await select.selectOption(value);
        expect(await select.inputValue()).toBe(value);
      }
    }
  });

  test('can change EPG days', async ({ page }) => {
    await page.goto('/');
    const input = page.locator('#epgDaysInput');
    
    await input.fill('5');
    await expect(input).toHaveValue('5');
  });

  test('can toggle metadata enrichment', async ({ page }) => {
    await page.goto('/');
    const checkbox = page.locator('#metadataEnabled');
    
    // Initially unchecked in most cases
    const initialState = await checkbox.isChecked();
    
    // Toggle it
    await checkbox.click();
    
    // Should be opposite now
    expect(await checkbox.isChecked()).toBe(!initialState);
  });

  test('metadata config section visibility toggles', async ({ page }) => {
    await page.goto('/');
    const checkbox = page.locator('#metadataEnabled');
    const configSection = page.locator('#metadataConfigSection');
    
    // Initially hidden
    await expect(configSection).toHaveCSS('display', 'none');
    
    // Enable metadata
    if (!(await checkbox.isChecked())) {
      await checkbox.click();
    }
    
    // Should now be visible
    await expect(configSection).not.toHaveCSS('display', 'none');
  });
});
