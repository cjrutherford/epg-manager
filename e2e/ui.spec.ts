import { test, expect } from '@playwright/test';
import { FIXTURE } from './fixture/seed';
import { goToSection, revealPlayerChrome, signIn } from './fixture/helpers';

test.beforeEach(async ({ page }) => {
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
});

test.describe('Angular Client Auth Flow', () => {

  test('unauthenticated user is redirected or shown login overlay', async ({ page }) => {
    await page.goto('/admin/dashboard');
    await page.waitForLoadState('networkidle');
    // Verify login overlay is visible
    const overlay = page.locator('.login-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay.locator('h2')).toContainText('Tuner Daemon');
    await expect(overlay.locator('p')).toContainText('Automated EPG & Live TV Engine');
  });

  test('login with invalid password shows error', async ({ page }) => {
    await page.goto('/admin');
    const input = page.locator('.login-form input[type="password"].ng-pristine');
    await expect(input).toBeVisible({ timeout: 10000 });
    await input.fill('wrongpassword');
    
    const [response] = await Promise.all([
      page.waitForResponse('**/api/auth'),
      page.locator('.login-form button[type="submit"]').click()
    ]);
    console.log('INVALID LOGIN RESP:', response.status(), await response.json());
    
    const errorMsg = page.locator('.login-error');
    await expect(errorMsg).toBeVisible();
    await expect(errorMsg).toContainText('Invalid password');
  });

  test('login with default admin password succeeds', async ({ page }) => {
    await page.goto('/admin');
    const input = page.locator('.login-form input[type="password"].ng-pristine');
    await expect(input).toBeVisible({ timeout: 10000 });
    await input.fill(FIXTURE.adminPassword);
    
    const [response] = await Promise.all([
      page.waitForResponse('**/api/auth'),
      page.locator('.login-form button[type="submit"]').click()
    ]);
    console.log('LOGIN RESP:', response.status(), await response.json());
    
    // Login overlay should disappear and Dashboard should be visible
    await expect(page.locator('.login-overlay')).not.toBeVisible();
    await expect(page.locator('.page-header h1')).toHaveText('Dashboard');
  });
});

test.describe('Admin Console Features', () => {
  // Log in before each test in this suite
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  // Nav label and page title agree on every screen since S26d, so this asserts
  // they are the same string rather than two strings that happen to relate.
  test('every nav link leads to the page it names', async ({ page }) => {
    for (const [label, title] of [
      ['Channels', 'Channels'],
      ['Sources', 'Sources'],
      ['DVR', 'DVR'],
      ['EPG & Matches', 'EPG & Matches'],
      ['Settings', 'Settings'],
      ['Dashboard', 'Dashboard'],
    ]) {
      await goToSection(page, label, title);
    }
  });

  test('dashboard reports the seeded counts', async ({ page }) => {
    await page.goto('/admin/dashboard');

    // `.stat` is the shared statistic component introduced in S26b; the
    // per-screen `.stat-card` this used to target no longer exists.
    const stats = page.locator('.stat');
    await expect(stats).toHaveCount(3);

    // The numbers come from the fixture, so they can be asserted exactly.
    await expect(stats.nth(0).locator('.stat__value'))
      .toHaveText(String(FIXTURE.channelCount - FIXTURE.disabledCount));
    await expect(stats.nth(1).locator('.stat__value'))
      .toHaveText(String(FIXTURE.programmeCount));

    await expect(page.locator('.action-card')).toHaveCount(4);
    await expect(page.locator('.action-card:has-text("Run full sync")')).toBeVisible();
  });

  test('settings page loads config and allows saving', async ({ page }) => {
    await page.goto('/admin/settings');
    await expect(page.locator('.page-header h1')).toHaveText('Settings');

    // Verify inputs are present
    const customUrlInput = page.locator('input.custom-url-input');
    await expect(customUrlInput).toBeVisible();

    const durationInput = page.locator('input[type="number"]');
    await expect(durationInput).toBeVisible();

    // Verify metadata enrichment section exists
    const metadataCheckbox = page.locator('input[type="checkbox"]');
    await expect(metadataCheckbox).toBeVisible();

    // Click Save Configuration button
    const saveBtn = page.locator('button:has-text("Save Configuration")');
    await expect(saveBtn).toBeVisible();
    await saveBtn.click();

    // Verify success toast appears
    const toast = page.locator('.toast.success');
    await expect(toast).toBeVisible();
  });

  test('settings workflow adds playlists, loads iptv-org data, saves, and survives reload', async ({ page }) => {
    // A full save, reload and restore round trip; the default 30s is tight.
    test.setTimeout(90_000);
    const token = await page.evaluate(() => localStorage.getItem('epg_admin_token'));
    const authHeaders = { Authorization: `Bearer ${token}` };
    const originalConfigResponse = await page.request.get('/api/config', { headers: authHeaders });
    const originalConfig = await originalConfigResponse.json();
    const customPlaylistUrl = `https://example.test/e2e-workflow-${Date.now()}`;
    const customPlaylistLabel = /e2e-workflow/i;
    const iptvOrgPlaylist = {
      name: 'US (countries)',
      label: 'US',
      category: 'countries',
      host: 'iptv-org',
      pathSummary: 'countries/us.m3u',
      url: '/files/iptv-org-playlists/countries/us.m3u',
      importedCount: 0,
      channelCountEstimate: 42
    };

    await page.route('**/api/iptv-org/playlists', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([iptvOrgPlaylist])
      });
    });

    try {
      await page.request.post('/api/config', {
        headers: authHeaders,
        data: {
          playlist_urls: [],
          playlist_url: '',
          epg_days: 2,
          channel_numbering_mode: 'list',
          custom_channel_ranges: '{}'
        }
      });

      await page.goto('/admin/settings');
      await expect(page.locator('.page-header h1')).toHaveText('Settings');

      const customUrlInput = page.locator('input.custom-url-input');
      const saveBtn = page.locator('button:has-text("Save Configuration")');
      const browseBtn = page.getByRole('button', { name: /Browse iptv-org & FAST Playlists|Refresh List/ });

      await expect(customUrlInput).toBeVisible();
      await customUrlInput.fill(customPlaylistUrl);

      // "Add" is scoped to the custom-URL row: S26d renamed "+ Add Playlist"
      // to "Add playlist", so an unscoped role lookup now matches seven buttons.
      const addCustomBtn = page.locator('.custom-url-row button:has-text("Add")');
      await expect(addCustomBtn).toBeEnabled();
      await addCustomBtn.click();
      await expect(page.locator('.playlist-chip', { hasText: customPlaylistLabel })).toBeVisible();

      await saveBtn.click();
      await expect(page.locator('.toast.success', { hasText: 'Configuration saved' }).first()).toBeVisible();
      await expect(saveBtn).toBeEnabled();

      await browseBtn.click();
      await expect(page.locator('.iptv-org-item', { hasText: 'US' })).toBeVisible();
      await expect(page.locator('.iptv-org-item', { hasText: '42 est.' })).toBeVisible();

      await page.locator('.iptv-org-item', { hasText: 'US' }).click();
      await expect(page.locator('.playlist-chip', { hasText: 'countries' })).toBeVisible();

      await saveBtn.click();
      await expect(page.locator('.toast.success', { hasText: 'Configuration saved' }).first()).toBeVisible();
      await expect(saveBtn).toBeEnabled();

      await page.reload();
      await expect(page.locator('.page-header h1')).toHaveText('Settings');
      await expect(customUrlInput).toBeVisible();
      await expect(saveBtn).toBeEnabled();
      await expect(page.locator('.playlist-chip', { hasText: customPlaylistLabel })).toBeVisible();
      await expect(page.locator('.playlist-chip', { hasText: 'countries' })).toBeVisible();
    } finally {
      // Restoring must never mask the failure it is cleaning up after. Without
      // the catch, a body failure was reported as a timeout in this line, which
      // sent me looking at the wrong code entirely.
      try {
        await page.request.post('/api/config', {
          timeout: 10_000,
          headers: authHeaders,
          data: {
            playlist_urls: originalConfig.playlist_urls || [],
            playlist_url: originalConfig.playlist_url || '',
            epg_days: originalConfig.epg_days || 2,
            channel_numbering_mode: originalConfig.channel_numbering_mode || 'list',
            custom_channel_ranges: originalConfig.custom_channel_ranges || '{}'
          }
        });
      } catch (error) {
        console.warn("[cleanup] could not restore config:", error);
      }
    }
  });

  test('channel manager loads channels list', async ({ page }) => {
    await page.goto('/admin/channels');
    await expect(page.locator('.page-header h1')).toHaveText('Channels');
    
    // Verify filter input
    const filterInput = page.locator('input[placeholder="Filter name or category..."]');
    await expect(filterInput).toBeVisible();
    
    // Verify status and category selects are present
    const selects = page.locator('select.themed-select');
    await expect(selects).toHaveCount(2);

    // Verify matching filter pills
    const pills = page.locator('.filter-pills button.pill');
    await expect(pills).toHaveCount(5);
  });

  test('channel manager auto-number bulk action', async ({ page }) => {
    await page.goto('/admin/channels');
    await expect(page.locator('.page-header h1')).toHaveText('Channels');

    // Wait for the table to load
    const rows = page.locator('tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 10000 });

    // Select the first 3 checkboxes
    const checkboxes = page.locator('tbody tr input[type="checkbox"]');
    await expect(checkboxes.first()).toBeVisible();
    await checkboxes.nth(1).check();
    await checkboxes.nth(2).check();
    await checkboxes.nth(3).check();

    // Verify selected count chip and Auto-# button appear
    const autoBtn = page.locator('button:has-text("Auto-number")');
    await expect(autoBtn).toBeVisible();

    // Click Auto-# button
    await autoBtn.click();

    // Verify modal is open
    const modal = page.locator('.modal-backdrop');
    await expect(modal).toBeVisible();
    await expect(modal.locator('h2')).toContainText('Auto-number channels');

    // Fill start number input with '800'
    const startNumInput = modal.locator('input[type="number"]');
    await expect(startNumInput).toBeVisible();
    await startNumInput.fill('800');

    // Click Auto-Number submit button in modal
    await modal.locator('button.btn-primary:has-text("Auto-Number")').click();

    // Verify modal disappears
    await expect(modal).not.toBeVisible();

    // Verify success toast appears
    const toast = page.locator('.toast.success');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('Auto-assigned numbers');

    // Verify the channels are numbered 800, 801, 802
    const numCells = page.locator('tbody tr td.channel-num');
    await expect(numCells.nth(1)).toContainText('800');
    await expect(numCells.nth(2)).toContainText('801');
    await expect(numCells.nth(3)).toContainText('802');
  });

  test('dvr manager displays gauge and opens schedule modal', async ({ page }) => {
    await page.goto('/admin/dvr');
    await expect(page.locator('.page-header h1')).toHaveText('DVR');

    // Storage ring is visible
    await expect(page.locator('.storage-ring')).toBeVisible();

    // Open schedule modal
    const scheduleBtn = page.locator('button:has-text("Schedule Recording")');
    await expect(scheduleBtn).toBeVisible();
    await scheduleBtn.click();

    // Verify modal is shown
    const modal = page.locator('.modal-backdrop');
    await expect(modal).toBeVisible();
    await expect(modal.locator('h2')).toContainText('Schedule a recording');

    // Cancel modal
    await modal.locator('button:has-text("Cancel")').click();
    await expect(modal).not.toBeVisible();
  });

  test('dvr manager schedules manual recording and cancels it', async ({ page }) => {
    const showTitle = `Manual Test Show ${Date.now()}`;
    await page.goto('/admin/dvr');
    await expect(page.locator('.page-header h1')).toHaveText('DVR');

    // Open schedule modal
    await page.locator('button:has-text("Schedule Recording")').click();
    const modal = page.locator('.modal-backdrop');
    await expect(modal).toBeVisible();

    // Select first channel in the select
    const select = modal.locator('select.themed-select');
    await expect(select).toBeVisible();
    await select.selectOption({ index: 1 });

    // Fill title
    const titleInput = modal.locator('input[placeholder="Recording name..."]');
    await titleInput.fill(showTitle);

    // Click Schedule
    await modal.locator('button.btn-primary:has-text("Schedule")').click();
    await expect(modal).not.toBeVisible();

    // Verify toast & table row
    const toast = page.locator('.toast.success').first();
    await expect(toast).toBeVisible();
    // DvrService names the destination now: "Recording 'X' on the server".
    await expect(toast).toContainText('Recording');

    // Table should contain the recording with a Cancel button
    const row = page.locator('.recording-card', { hasText: showTitle });
    await expect(row).toBeVisible();
    // Capitalised since S20 gave both recorders one status vocabulary.
    await expect(row.locator('span.badge')).toContainText('Scheduled');

    // Click Cancel
    const cancelBtn = row.locator('button:has-text("Cancel")');
    await expect(cancelBtn).toBeVisible();

    await cancelBtn.click();

    // S23 replaced the native confirm with an in-app dialog, so there is no
    // browser dialog event to listen for — the confirmation is in the page.
    const confirmDialog = page.locator('.confirm-modal');
    await expect(confirmDialog).toBeVisible();
    await expect(confirmDialog.locator('#confirm-title')).toHaveText('Cancel this scheduled recording?');
    await confirmDialog.getByRole('button', { name: 'Cancel recording' }).click();

    // Verify toast for cancellation
    const cancelToast = page.locator('.toast.success').first();
    await expect(cancelToast).toBeVisible();
    await expect(cancelToast).toContainText('Scheduled recording cancelled');

    // Table should not contain it anymore
    await expect(row).not.toBeVisible();
  });

  test('diagnostics page loads tabs and opens manual rematch modal', async ({ page }) => {
    await page.goto('/admin/diagnostics');
    await expect(page.locator('.page-header h1')).toHaveText('EPG & Matches');

    // Verify stats / summary cards are present
    const summaryCards = page.locator('.stat-grid .stat');
    await expect(summaryCards.first()).toBeVisible({ timeout: 10000 });
    await expect(summaryCards).toHaveCount(4);

    // Verify Match Analyzer tab content by default
    const searchInput = page.locator('input[placeholder="Search channels, matched IDs, score tags..."]');
    await expect(searchInput).toBeVisible();

    // Verify EPG Source Reliability tab navigation
    const reliabilityTab = page.locator('.tab-nav button:has-text("EPG Source Reliability")');
    await expect(reliabilityTab).toBeVisible();
    await reliabilityTab.click();

    // Verify source metrics table or elements appear
    const tableHeader = page.locator('th:has-text("EPG Scraper Site")');
    await expect(tableHeader).toBeVisible();

    // Switch back to Match Analyzer
    const matcherTab = page.locator('.tab-nav button:has-text("Match analyser")');
    await expect(matcherTab).toBeVisible();
    await matcherTab.click();

    // Find and click the Rematch/Edit button for the first row to open modal
    const editBtn = page.locator('button:has-text("Rematch")').first();
    if (await editBtn.isVisible()) {
      await editBtn.click();

      // Verify the manual rematch modal is open
      const modal = page.locator('.modal-backdrop');
      await expect(modal).toBeVisible();
      await expect(modal.locator('h2')).toContainText('Rematch this channel');

      // Close modal
      await modal.locator('button:has-text("Cancel")').click();
      await expect(modal).not.toBeVisible();
    }
  });
});

test.describe('Watch TV Interface', () => {
  test('loads Watch TV view and shows appropriate UI elements', async ({ page }) => {
    await page.goto('/watch');
    // The player chrome hides itself until the pointer moves, so a spec that
    // never moves it is asserting against a deliberately empty screen.
    await revealPlayerChrome(page);
    
    // Header check
    await expect(page.locator('header.topbar')).toBeVisible();
    await expect(page.locator('header.topbar .logo')).toContainText('Tuner Daemon');

    // The guide toggle lives on the lower-third controls, not the topbar — the
    // topbar copies were commented out of the template. This spec had been
    // asserting on buttons that no longer exist.
    await expect(page.locator('button[title="Toggle Guide"]')).toBeVisible();

    // Since we have no channels or database sync at first, check empty state or player
    const emptyState = page.locator('.watch-empty-state');
    const playerArea = page.locator('.player-area');
    
    if (await emptyState.isVisible()) {
      await expect(emptyState.locator('h2')).toContainText('No channels configured');
      await expect(emptyState.locator('#btn-go-to-admin')).toBeVisible();
    } else {
      await expect(playerArea).toBeVisible();
      await expect(playerArea.locator('video')).toBeVisible();
    }
  });

  test('server connection modal opens and contains inputs', async ({ page }) => {
    await page.goto('/watch');
    
    // Click connection settings button
    const connBtn = page.locator('header.topbar button[title="Server Connection"]');
    await connBtn.click();

    // Modal should be visible
    const modal = page.locator('.modal-backdrop');
    await expect(modal).toBeVisible();
    await expect(modal.locator('h3')).toContainText('Server Connection');
    await expect(modal.locator('#serverUrlInput')).toBeVisible();

    // Close modal
    await modal.locator('button.close-btn').click();
    await expect(modal).not.toBeVisible();
  });

  test('loads channels and shows in the guide, with no console error for icons', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error' || msg.text().includes('icon has not been provided')) {
        errors.push(msg.text());
      }
    });

    await page.goto('/watch');

    // Toggle Guide
    const guideBtn = page.locator('button[title="Toggle Guide"]');
    await expect(guideBtn).toBeVisible({ timeout: 10000 });
    await guideBtn.click();

    // Verify the guide panel is open
    const guidePanel = page.locator('.guide-panel');
    await expect(guidePanel).toBeVisible();

    // Verify channels list is loaded
    const guideRows = page.locator('.guide-row');
    await expect(guideRows.first()).toBeVisible({ timeout: 10000 });

    // Verify shows/programs are loaded
    const programs = page.locator('.guide-program');
    await expect(programs.first()).toBeVisible();

    // Verify there are no icon provider errors
    const iconErrors = errors.filter(err => err.includes('icon has not been provided'));
    expect(iconErrors).toHaveLength(0);
  });

  test('guide sidebar layout is resizable horizontally via drag handle', async ({ page }) => {
    await page.goto('/watch');

    // Ensure guide is open
    const guideBtn = page.locator('button[title="Toggle Guide"]');
    await expect(guideBtn).toBeVisible({ timeout: 10000 });
    const guidePanel = page.locator('.guide-panel');
    if (!(await guidePanel.isVisible())) {
      await guideBtn.click();
    }
    await expect(guidePanel).toBeVisible();

    // Layout is chosen from a popout, not by cycling the guide toggle — the
    // cycle button this used to click was commented out of the template.
    const layoutBtn = page.locator('button[title="Change Guide Layout"]');
    await expect(layoutBtn).toBeVisible();
    await layoutBtn.click();

    await page.getByRole('button', { name: /Side-by-Side/i }).click();
    await expect(page.locator('.content-area')).toHaveClass(/layout-side/);

    // Debugging logs
    const contentAreaClasses = await page.locator('.content-area').getAttribute('class');
    const guidePanelClasses = await guidePanel.getAttribute('class');
    const guidePanelStyle = await guidePanel.getAttribute('style');
    console.log('DEBUG - Content Area Classes:', contentAreaClasses);
    console.log('DEBUG - Guide Panel Classes:', guidePanelClasses);
    console.log('DEBUG - Guide Panel Style:', guidePanelStyle);

    // Get the bounding box of the guide panel before dragging
    const initialBox = await guidePanel.boundingBox();
    expect(initialBox).not.toBeNull();
    const initialWidth = initialBox!.width;

    // Locate the drag handle
    const dragHandle = page.locator('.guide-drag-handle');
    await expect(dragHandle).toBeVisible();

    const handleBox = await dragHandle.boundingBox();
    expect(handleBox).not.toBeNull();

    const startX = handleBox!.x + handleBox!.width / 2;
    const startY = handleBox!.y + handleBox!.height / 2;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 150, startY, { steps: 5 });
    await page.mouse.up();

    // Get the bounding box of the guide panel after dragging
    const finalBox = await guidePanel.boundingBox();
    expect(finalBox).not.toBeNull();
    const finalWidth = finalBox!.width;

    console.log(`Resized sidebar guide from width ${initialWidth} to ${finalWidth}`);
    expect(finalWidth).toBeGreaterThan(initialWidth + 100);
  });
});
