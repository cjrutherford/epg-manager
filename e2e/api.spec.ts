import { test, expect } from '@playwright/test';

test.describe('API Endpoints', () => {
  test('health check returns healthy status', async ({ request }) => {
    const response = await request.get('/api/health');
    expect(response.ok()).toBeTruthy();
    
    const body = await response.json();
    expect(body.status).toBe('healthy');
    expect(body).toHaveProperty('channels');
    expect(body).toHaveProperty('programs');
    expect(body).toHaveProperty('uptime');
    expect(typeof body.channels).toBe('number');
    expect(typeof body.programs).toBe('number');
    expect(typeof body.uptime).toBe('number');
  });

  test('stats endpoint returns statistics', async ({ request }) => {
    const response = await request.get('/api/stats');
    expect(response.ok()).toBeTruthy();
    
    const body = await response.json();
    expect(body).toHaveProperty('channels');
    expect(body).toHaveProperty('programs');
    expect(body).toHaveProperty('metadata');
    
    expect(body.channels).toHaveProperty('total');
    expect(body.channels).toHaveProperty('enabled');
    expect(body.channels).toHaveProperty('matched');
    expect(body.channels).toHaveProperty('autoDisabled');
    
    expect(body.programs).toHaveProperty('total');
    expect(body.programs).toHaveProperty('channels');
    expect(body.programs).toHaveProperty('enriched');
    
    expect(body.metadata).toHaveProperty('cachedShows');
  });

  test('auto-disabled endpoint returns array', async ({ request }) => {
    const response = await request.get('/api/channels/auto-disabled');
    expect(response.ok()).toBeTruthy();
    
    const body = await response.json();
    expect(Array.isArray(body)).toBeTruthy();
  });

  test('playlists endpoint returns available playlists', async ({ request }) => {
    const response = await request.get('/api/playlists');
    expect(response.ok()).toBeTruthy();
    
    const body = await response.json();
    expect(Array.isArray(body)).toBeTruthy();
    // Should have at least some playlist options
    expect(body.length).toBeGreaterThan(0);
  });

  test('config endpoint returns configuration', async ({ request }) => {
    const response = await request.get('/api/config');
    expect(response.ok()).toBeTruthy();
    
    const body = await response.json();
    // Config may or may not have these set, but should be an object
    expect(typeof body).toBe('object');
  });

  test('mapping endpoint returns channel list', async ({ request }) => {
    const response = await request.get('/api/mapping');
    expect(response.ok()).toBeTruthy();
    
    const body = await response.json();
    expect(Array.isArray(body)).toBeTruthy();
  });

  test('metadata config endpoint returns configuration', async ({ request }) => {
    const response = await request.get('/api/metadata/config');
    expect(response.ok()).toBeTruthy();
    
    const body = await response.json();
    expect(body).toHaveProperty('enabled');
    expect(typeof body.enabled).toBe('boolean');
  });

  test('metadata stats endpoint returns statistics', async ({ request }) => {
    const response = await request.get('/api/metadata/stats');
    expect(response.ok()).toBeTruthy();
    
    const body = await response.json();
    expect(body).toHaveProperty('cachedShows');
    expect(body).toHaveProperty('enrichedPrograms');
    expect(body).toHaveProperty('pendingPrograms');
  });

  test('job-status endpoint returns status', async ({ request }) => {
    const response = await request.get('/api/job-status');
    expect(response.ok()).toBeTruthy();
    
    const body = await response.json();
    expect(body).toHaveProperty('running');
    expect(typeof body.running).toBe('boolean');
  });

  test('re-enable endpoint validates input', async ({ request }) => {
    // Test without proper body
    const response = await request.post('/api/channels/re-enable', {
      data: {}
    });
    
    // Should fail with 500 due to missing xmltv_ids
    expect(response.status()).toBe(500);
    
    const body = await response.json();
    expect(body).toHaveProperty('error');
  });

  test('re-enable endpoint accepts valid input', async ({ request }) => {
    const response = await request.post('/api/channels/re-enable', {
      data: { xmltv_ids: [] }
    });
    
    expect(response.ok()).toBeTruthy();
    
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.count).toBe(0);
  });
});
