#!/usr/bin/env node
/**
 * Derive the next release from conventional commits since the last tag.
 *
 * The release-on-merge workflow runs after CI succeeds on main, so this is the
 * only place that decides patch/minor/major. It avoids the release-please PR
 * loop: the bot commits the version directly and dispatches the release
 * workflow, which verifies the tag before publishing.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

const lastTag = (() => {
    try { return git(['describe', '--tags', '--abbrev=0']); } catch { return ''; }
})();
const range = lastTag ? `${lastTag}..HEAD` : 'HEAD';
const messages = git(['log', range, '--pretty=format:%s%n%b']);

const write = (key, value) => {
    if (process.argv.includes('--github-output') && process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    } else {
        console.log(`${key}=${value}`);
    }
};

if (!messages || /^\s*$/.test(messages)) {
    write('version', '');
    write('kind', 'none');
    console.error(`No commits since ${lastTag || 'the start of history'}; nothing to release.`);
    process.exit(0);
}

const breaking = /(^|\n)BREAKING[ -]CHANGE:/.test(messages) || /^[a-z]+(\([^)]*\))?!:/m.test(messages);
const feature = /^feat(\([^)]*\))?:/m.test(messages);
const kind = breaking ? 'major' : feature ? 'minor' : 'patch';

const pkg = JSON.parse(fs.readFileSync(`${root}package.json`, 'utf8'));
const [major, minor, patch] = String(pkg.version).split('.').map(Number);
const next = kind === 'major' ? `${major + 1}.0.0`
    : kind === 'minor' ? `${major}.${minor + 1}.0`
    : `${major}.${minor}.${patch + 1}`;

write('version', next);
write('kind', kind);
console.error(`Last tag: ${lastTag || '(none)'}; commits: ${messages.split('\n').length}; ${kind} -> ${next}`);
