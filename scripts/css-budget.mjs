#!/usr/bin/env node
/**
 * CSS budget and duplicate audit.
 *
 * Gate 1 is measured on what the browser actually loads:
 *   - the CSS inlined into each prerendered route, plus its linked stylesheet;
 *   - summed across the public and admin routes (the "initial CSS" total).
 *
 * Raw and minified source bytes are reported as a trend, not as the gate: raw
 * whitespace is not a user cost, and moving CSS into a lazy chunk should not
 * count as a regression. The baseline below was measured from the build that
 * preceded the Phase 1 work.
 *
 * Run with --check to fail when initial CSS is not 20% down or when an exact
 * duplicate rule reappears.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_SRC = path.join(ROOT, 'client/src');
const CLIENT_DIST = path.join(ROOT, 'client/dist/client/browser');

const BASELINE = { raw: 170_831, min: 124_560 };
const REDUCTION = 0.2;
const TARGET = {
    raw: Math.round(BASELINE.raw * (1 - REDUCTION)),
    min: Math.round(BASELINE.min * (1 - REDUCTION)),
};

// Initial CSS measured before the Phase 1 work: linked styles.css + inline
// critical styles. Every admin route shared the same critical bundle.
const ROUTE_BASELINE = {
    'index.html': 44_424,
    'watch/index.html': 104_502,
    'admin/dashboard/index.html': 55_323,
    'admin/channels/index.html': 55_323,
    'admin/sources/index.html': 55_323,
    'admin/dvr/index.html': 55_323,
    'admin/diagnostics/index.html': 55_323,
    'admin/settings/index.html': 55_323,
};

const check = process.argv.includes('--check');
const json = process.argv.includes('--json');

function walk(dir, extension = '.css') {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full, extension));
        else if (entry.name.endsWith(extension)) out.push(full);
    }
    return out;
}

/** Whitespace/comments only: deliberately conservative, like a CSS minifier. */
function minify(text) {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\s+/g, ' ')
        .replace(/\s*([{}:;,>])\s*/g, '$1')
        .replace(/;}/g, '}')
        .trim();
}

function stripKeyframes(text) {
    return text.replace(/@(?:-webkit-)?keyframes\s+[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
}

const seenRules = new Map();

function duplicateRules(text, file) {
    const clean = stripKeyframes(text.replace(/\/\*[\s\S]*?\*\//g, ''));
    const out = [];
    for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = match[1].replace(/\s+/g, ' ').trim();
        const body = match[2].replace(/\s+/g, ' ').trim();
        if (!selector || selector.startsWith('@') || body.split(';').filter(Boolean).length < 2) continue;
        const key = `${selector}|${body}`;
        const existing = seenRules.get(key);
        if (existing && existing !== file) out.push({ selector, file, otherFile: existing });
        else if (!existing) seenRules.set(key, file);
    }
    return out;
}

function routeCss() {
    if (!fs.existsSync(CLIENT_DIST)) return [];
    const pagesByRoute = new Map();
    const addPage = (file) => {
        const relativePage = path.relative(CLIENT_DIST, file).replace(/index\.csr\.html$/, 'index.html');
        const html = fs.readFileSync(file, 'utf8');
        let cssBytes = 0;
        for (const style of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
            cssBytes += Buffer.byteLength(style[1]);
        }
        const linked = new Set();
        for (const link of html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/g)) {
            const href = /href=["']([^"']+)["']/.exec(link[0])?.[1];
            if (!href) continue;
            const asset = path.join(CLIENT_DIST, href.replace(/^\//, '').split('?')[0]);
            if (fs.existsSync(asset)) linked.add(asset);
        }
        for (const asset of linked) cssBytes += fs.statSync(asset).size;
        // A server-output build may emit only index.csr.html. Count it as the
        // root route instead of silently dropping a route and its baseline.
        if (!pagesByRoute.has(relativePage)) {
            pagesByRoute.set(relativePage, {
                page: relativePage,
                initialCss: cssBytes,
                linked: [...linked].map(item => path.relative(CLIENT_DIST, item)),
            });
        }
    };
    for (const entry of walk(CLIENT_DIST, '.html')) {
        if (path.basename(entry) === 'index.html' || path.basename(entry) === 'index.csr.html') addPage(entry);
    }
    return [...pagesByRoute.values()].sort((a, b) => b.initialCss - a.initialCss);
}

const files = walk(CLIENT_SRC).sort();
let raw = 0;
let min = 0;
const perFile = [];
const duplicates = [];

for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const minified = minify(text);
    const row = {
        file: path.relative(ROOT, file),
        raw: Buffer.byteLength(text),
        min: Buffer.byteLength(minified),
        gzip: zlib.gzipSync(minified, { level: 9 }).length,
    };
    raw += row.raw;
    min += row.min;
    perFile.push(row);
    duplicates.push(...duplicateRules(text, row.file));
}

const pages = routeCss();
const matchedPages = pages.filter(page => ROUTE_BASELINE[page.page]);
const initialBaseline = matchedPages.reduce((sum, page) => sum + ROUTE_BASELINE[page.page], 0);
const initialCurrent = matchedPages.reduce((sum, page) => sum + page.initialCss, 0);
const result = {
    baseline: BASELINE,
    target: TARGET,
    current: { raw, min, rawReduction: 1 - raw / BASELINE.raw, minReduction: 1 - min / BASELINE.min },
    initial: {
        baseline: initialBaseline,
        current: initialCurrent,
        reduction: initialBaseline ? 1 - initialCurrent / initialBaseline : 0,
        routes: matchedPages.length,
    },
    duplicates: duplicates.map(d => ({ selector: d.selector, file: d.file, otherFile: d.otherFile })),
    pages,
    perFile: perFile.sort((a, b) => b.min - a.min),
};

if (json) {
    console.log(JSON.stringify(result, null, 2));
} else {
    const pct = (n) => `${(n * 100).toFixed(1)}%`;
    console.log('\nCSS budget\n');
    console.log(`  initial  ${initialCurrent.toLocaleString().padStart(8)} / ${initialBaseline.toLocaleString().padStart(8)}   ${pct(result.initial.reduction)} down (gate 20%)  ${matchedPages.length} routes`);
    console.log(`  minified ${min.toLocaleString().padStart(8)} / ${TARGET.min.toLocaleString().padStart(8)}   ${pct(result.current.minReduction)} down (trend)`);
    console.log(`  raw      ${raw.toLocaleString().padStart(8)} / ${TARGET.raw.toLocaleString().padStart(8)}   ${pct(result.current.rawReduction)} down (trend)`);
    console.log(`  duplicate blocks: ${duplicates.length}`);
    if (pages.length) {
        console.log('\nInitial CSS per route\n');
        for (const page of pages.slice(0, 12)) console.log(`  ${String(page.initialCss).padStart(7)}  ${page.page}`);
    }
    console.log('\nLargest sources\n');
    for (const row of result.perFile.slice(0, 10)) {
        console.log(`  ${String(row.min).padStart(7)} min  ${String(row.raw).padStart(7)} raw  ${row.file}`);
    }
    if (duplicates.length) {
        console.log('\nDuplicate rules\n');
        for (const dup of duplicates) console.log(`  ${dup.selector}  ${dup.file}  <-> ${dup.otherFile}`);
    }
    console.log();
}

if (check && matchedPages.length === 0) {
    console.error('No built routes found. Run `npm run build:client` before `npm run css:check`.');
    process.exit(2);
}

const overBudget = result.initial.reduction < REDUCTION || duplicates.length > 0;
if (check && overBudget) process.exit(1);
