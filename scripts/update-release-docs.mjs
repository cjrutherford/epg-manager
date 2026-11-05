#!/usr/bin/env node
/**
 * Keep the install docs pinned to the version that is being released.
 *
 * release-on-merge runs this after set-version.ts, before it commits the
 * release. That makes the README quick start and the quality evidence match the
 * new tag without a human remembering to edit them.
 */
import fs from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const version = JSON.parse(fs.readFileSync(`${root}package.json`, 'utf8')).version;

const readmePath = `${root}README.md`;
let readme = fs.readFileSync(readmePath, 'utf8');
readme = readme.replace(/TAG=\d+\.\d+\.\d+/g, `TAG=${version}`);
readme = readme.replace(/TAG is pinned in docker-compose\.yml \(e\.g\. \d+\.\d+\.\d+\)/,
    `TAG is pinned in docker-compose.yml (e.g. ${version})`);
fs.writeFileSync(readmePath, readme);

const evidencePath = `${root}docs/quality-evidence.json`;
const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
evidence.release = version;
evidence.updated = new Date().toISOString().slice(0, 10);
fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

console.log(`Release docs now point at ${version}.`);
