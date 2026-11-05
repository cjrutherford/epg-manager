#!/usr/bin/env node
/**
 * First-sync benchmark.
 *
 * Gate 2 is "first sync under two minutes on a clean install". This script
 * measures the wall-clock time from POST /api/sync until the server emits its
 * `report` event, against an empty database.
 *
 * Modes:
 *   synthetic   local M3U + XMLTV fixture, no external network
 *   builtin     built-in Pluto TV + Plex TV + the first built-in guide source
 *   user        BENCH_PLAYLIST_URL and optional BENCH_GUIDE_URL
 *
 * Usage:
 *   node scripts/benchmark-first-sync.mjs synthetic
 *   node scripts/benchmark-first-sync.mjs builtin
 *   BENCH_PLAYLIST_URL=... BENCH_GUIDE_URL=... \
 *     node scripts/benchmark-first-sync.mjs user
 *
 * Every run starts its own API on a temporary database and kills it on exit.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const MODE = process.argv[2] || 'synthetic';
const API_PORT = 45350;
const FIXTURE_PORT = 45351;
const BASE = `http://127.0.0.1:${API_PORT}`;
const PASSWORD = 'benchmark-password';

function log(message) {
    console.log(`[benchmark] ${message}`);
}

function startFixtureServer() {
    const channels = 60;
    const playlist = ['#EXTM3U'];
    const guide = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv>'];
    const now = new Date();
    now.setUTCMinutes(0, 0, 0);
    for (let i = 1; i <= channels; i++) {
        const id = `bench.ch${i}`;
        playlist.push(`#EXTINF:-1 tvg-id="${id}" tvg-name="Bench Channel ${i}" group-title="Bench",Bench Channel ${i}`);
        playlist.push(`http://127.0.0.1:${FIXTURE_PORT}/stream/${i}.m3u8`);
        guide.push(`  <channel id="${id}"><display-name>Bench Channel ${i}</display-name></channel>`);
        for (let h = 0; h < 6; h++) {
            const start = new Date(now.getTime() + h * 3600_000);
            const stop = new Date(start.getTime() + 3600_000);
            const stamp = date => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, ' +0000');
            guide.push(`  <programme start="${stamp(start)}" stop="${stamp(stop)}" channel="${id}"><title>Bench Show ${h + 1}</title><desc>Benchmark programme.</desc></programme>`);
        }
    }
    guide.push('</tv>');
    const files = {
        '/playlist.m3u': playlist.join('\n'),
        '/guide.xml': guide.join('\n')
    };
    return new Promise(resolve => {
        const server = http.createServer((req, res) => {
            const body = files[req.url];
            if (!body) { res.writeHead(404); res.end(); return; }
            res.writeHead(200, { 'Content-Type': req.url.endsWith('.xml') ? 'application/xml' : 'audio/x-mpegurl' });
            res.end(body);
        });
        server.listen(FIXTURE_PORT, '127.0.0.1', () => resolve(server));
    });
}

async function waitForHealth(timeoutMs = 60_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        try {
            const response = await fetch(`${BASE}/api/health`);
            if (response.ok) return;
        } catch { /* not up yet */ }
        await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('API did not become healthy');
}

async function login() {
    const response = await fetch(`${BASE}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD })
    });
    const body = await response.json();
    if (!body.token) throw new Error(`login failed: ${JSON.stringify(body)}`);
    return body.token;
}

async function api(token, method, url, data) {
    const response = await fetch(`${BASE}${url}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(data ? { 'Content-Type': 'application/json' } : {}) },
        body: data ? JSON.stringify(data) : undefined
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${method} ${url}: ${response.status} ${JSON.stringify(body)}`);
    return body;
}

async function addSource(token, descriptor) {
    log(`adding ${descriptor.label}`);
    const result = await api(token, 'POST', '/api/sources', { descriptor });
    if (result.ok === false) throw new Error(`source rejected: ${result.error || JSON.stringify(result)}`);
}

async function builtinDescriptors(token) {
    const catalog = await api(token, 'GET', '/api/sources/catalog');
    const pick = (id) => {
        const entry = catalog.find(item => item.id === id);
        if (!entry) throw new Error(`catalog entry ${id} missing`);
        return {
            ...entry,
            enabled: true,
            category: undefined,
            host: undefined,
            channelCountEstimate: undefined
        };
    };
    const guide = catalog.find(item => item.category === 'guide');
    if (!guide) throw new Error('no built-in guide source');
    return [
        pick('fast-plutotv'),
        pick('fast-plex'),
        { ...guide, enabled: true, category: undefined, host: undefined, channelCountEstimate: undefined }
    ];
}

async function waitForReport(timeoutMs = 180_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(`${BASE}/api/progress`, { signal: controller.signal });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let split;
            while ((split = buffer.indexOf('\n\n')) >= 0) {
                const chunk = buffer.slice(0, split);
                buffer = buffer.slice(split + 2);
                if (chunk.includes('event: report')) {
                    const data = chunk.split('\n').find(line => line.startsWith('data: '));
                    return data ? JSON.parse(data.slice(6)) : {};
                }
            }
        }
        throw new Error('progress stream closed before report');
    } finally {
        clearTimeout(timer);
    }
}

async function main() {
    if (!['synthetic', 'builtin', 'user'].includes(MODE)) {
        throw new Error(`unknown mode "${MODE}" (expected synthetic, builtin or user)`);
    }
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), `tuner-bench-${MODE}-`));
    log(`database ${dbDir}`);
    const fixture = MODE === 'synthetic' ? await startFixtureServer() : null;
    const server = spawn(process.execPath, ['--require', 'ts-node/register', 'src/server.ts'], {
        cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
        env: {
            ...process.env,
            DB_DIR: dbDir,
            API_PORT: String(API_PORT),
            ADMIN_PASSWORD: PASSWORD,
            MAX_ACTIVE_STREAMS: '2',
            LOG_LEVEL: 'warning'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', data => process.stderr.write(`[api] ${data}`));
    server.stderr.on('data', data => process.stderr.write(`[api] ${data}`));

    try {
        await waitForHealth();
        const token = await login();
        await api(token, 'POST', '/api/config', { metadata_enrichment_enabled: false, epg_days: 1 });

        let playlistUrls = [];
        if (MODE === 'synthetic') {
            playlistUrls = [`http://127.0.0.1:${FIXTURE_PORT}/playlist.m3u`];
            await addSource(token, {
                id: 'bench-guide', kind: 'xmltv', label: 'Synthetic Guide',
                provides: ['guide'], enabled: true, priority: 0,
                fetch: { url: `http://127.0.0.1:${FIXTURE_PORT}/guide.xml`, refresh: '12h', conditional: false }
            });
        } else if (MODE === 'builtin') {
            const descriptors = await builtinDescriptors(token);
            for (const descriptor of descriptors.filter(item => item.provides.includes('guide'))) {
                await addSource(token, descriptor);
            }
            playlistUrls = descriptors
                .filter(item => item.provides.includes('channels'))
                .map(item => item.fetch.url);
        } else {
            const playlist = process.env.BENCH_PLAYLIST_URL;
            if (!playlist) throw new Error('BENCH_PLAYLIST_URL is required for user mode');
            playlistUrls = [playlist];
            if (process.env.BENCH_GUIDE_URL) {
                await addSource(token, {
                    id: 'bench-guide', kind: 'xmltv', label: 'User Guide',
                    provides: ['guide'], enabled: true, priority: 0,
                    fetch: { url: process.env.BENCH_GUIDE_URL, refresh: '12h', conditional: false }
                });
            }
        }
        // The full-sync pipeline still reads the configured playlist list (the
        // registry save reconciles sources from it), so set both paths here.
        await api(token, 'POST', '/api/config', { playlist_urls: playlistUrls });

        const reportPromise = waitForReport();
        const started = Date.now();
        await api(token, 'POST', '/api/sync');
        const report = await reportPromise;
        const seconds = (Date.now() - started) / 1000;
        const data = await api(token, 'GET', '/api/has-data');
        console.log(JSON.stringify({
            mode: MODE,
            seconds: Number(seconds.toFixed(1)),
            underTwoMinutes: seconds < 120,
            hasData: data,
            report
        }, null, 2));
    } finally {
        server.kill('SIGTERM');
        fixture?.close();
        fs.rmSync(dbDir, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(`[benchmark] ${error.stack || error.message}`);
    process.exit(1);
});
