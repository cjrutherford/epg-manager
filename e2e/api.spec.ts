import { test, expect } from '@playwright/test';

test.describe('API Endpoints', () => {
  let authToken = '';

  test.beforeAll(async ({ request }) => {
    // Authenticate to get a token
    const authResponse = await request.post('/api/auth', {
      data: { password: 'admin' }
    });
    expect(authResponse.ok()).toBeTruthy();
    const body = await authResponse.json();
    expect(body.success).toBe(true);
    expect(body.token).toBeDefined();
    authToken = body.token;
  });

  function getHeaders() {
    return {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json'
    };
  }

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
    const response = await request.get('/api/channels/auto-disabled', {
      headers: getHeaders()
    });
    expect(response.ok()).toBeTruthy();
    
    const body = await response.json();
    expect(Array.isArray(body)).toBeTruthy();
  });

  test('playlists endpoint returns available playlists', async ({ request }) => {
    const response = await request.get('/api/playlists', {
      headers: getHeaders()
    });
    expect(response.ok()).toBeTruthy();
    
    const body = await response.json();
    expect(body).toHaveProperty('items');
    expect(Array.isArray(body.items)).toBeTruthy();
  });

  test('config endpoint returns configuration', async ({ request }) => {
    const response = await request.get('/api/config', {
      headers: getHeaders()
    });
    expect(response.ok()).toBeTruthy();
    
    const body = await response.json();
    expect(typeof body).toBe('object');
  });

  test('mapping endpoint returns channel list', async ({ request }) => {
    const response = await request.get('/api/mapping', {
      headers: getHeaders()
    });
    expect(response.ok()).toBeTruthy();
    
    const body = await response.json();
    expect(Array.isArray(body)).toBeTruthy();
  });

  test('metadata config endpoint returns configuration', async ({ request }) => {
    const response = await request.get('/api/metadata/config', {
      headers: getHeaders()
    });
    expect(response.ok()).toBeTruthy();
    
    const body = await response.json();
    expect(body).toHaveProperty('enabled');
    expect(typeof body.enabled).toBe('boolean');
  });

  test('metadata stats endpoint returns statistics', async ({ request }) => {
    const response = await request.get('/api/metadata/stats', {
      headers: getHeaders()
    });
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
    const response = await request.post('/api/channels/re-enable', {
      headers: getHeaders(),
      data: {}
    });
    
    expect(response.status()).toBe(500);
    
    const body = await response.json();
    expect(body).toHaveProperty('error');
  });

  test('re-enable endpoint accepts valid input', async ({ request }) => {
    const response = await request.post('/api/channels/re-enable', {
      headers: getHeaders(),
      data: { xmltv_ids: [] }
    });
    
    expect(response.ok()).toBeTruthy();
    
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.count).toBe(0);
  });
});
