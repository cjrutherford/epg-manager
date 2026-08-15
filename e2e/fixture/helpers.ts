/**
 * Shared helpers so specs describe intent rather than repeating mechanics.
 *
 * Every spec used to inline its own login, with the password written out four
 * times — so changing it meant changing four places and finding out which one
 * was missed by watching tests fail.
 */
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { FIXTURE } from './seed';

/** Sign in through the UI and wait until the console is actually usable. */
export async function signIn(page: Page): Promise<void> {
    await page.goto('/admin');

    const password = page.locator('.login-form input[type="password"]').first();
    await expect(password).toBeVisible({ timeout: 15000 });
    await password.fill(FIXTURE.adminPassword);

    await Promise.all([
        page.waitForResponse(response => response.url().includes('/api/auth')),
        page.locator('.login-form button[type="submit"]').click()
    ]);

    await expect(page.locator('.login-overlay')).not.toBeVisible({ timeout: 15000 });
}

/** A bearer token for direct API calls. */
export async function apiToken(request: APIRequestContext): Promise<string> {
    const response = await request.post('/api/auth', {
        data: { password: FIXTURE.adminPassword }
    });
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.token).toBeTruthy();
    return body.token;
}

export function authHeaders(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

/** Navigate by nav label and wait for the page header to confirm arrival. */
export async function goToSection(page: Page, label: string, expectedTitle: string): Promise<void> {
    await page.getByRole('link', { name: label, exact: true }).click();
    await expect(page.locator('.page-header h1')).toHaveText(expectedTitle, { timeout: 15000 });
}

/**
 * Wake the Watch player's controls.
 *
 * They hide themselves after a period of stillness and return on pointer
 * movement, so a spec that never moves the mouse is asserting against a
 * deliberately empty screen rather than a broken one.
 */
export async function revealPlayerChrome(page: Page): Promise<void> {
    await page.mouse.move(640, 700);
    await page.mouse.move(640, 400);
    await page.waitForTimeout(300);
}
