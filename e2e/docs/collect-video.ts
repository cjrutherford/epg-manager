/**
 * Copies the recorded walkthrough to a stable path for the documentation.
 *
 * Playwright names its output directory after the test, which changes whenever
 * the test title does — not something a README should link to.
 */
import fs from 'fs';
import path from 'path';

const RESULTS = path.resolve(process.cwd(), 'test-results');
const TARGET_DIR = path.resolve(process.cwd(), 'docs/media');
const TARGET = path.join(TARGET_DIR, 'admin-walkthrough.webm');

function findVideo(dir: string): string | null {
    if (!fs.existsSync(dir)) return null;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const found = findVideo(full);
            if (found) return found;
        } else if (entry.name.endsWith('.webm')) {
            return full;
        }
    }
    return null;
}

const source = findVideo(RESULTS);
if (!source) {
    console.error('No walkthrough video found. Run: npx playwright test --project=docs');
    process.exit(1);
}

fs.mkdirSync(TARGET_DIR, { recursive: true });
fs.copyFileSync(source, TARGET);
const size = (fs.statSync(TARGET).size / 1024 / 1024).toFixed(1);
console.log(`Walkthrough written to ${path.relative(process.cwd(), TARGET)} (${size} MB)`);
