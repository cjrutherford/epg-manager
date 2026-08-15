/**
 * Builds the fixture database before any spec runs.
 *
 * Playwright starts the servers itself (see `webServer` in the config); this
 * only has to guarantee the database they open is the known one.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export const FIXTURE_DIR = path.resolve(process.cwd(), '.e2e-fixture');

export default async function globalSetup(): Promise<void> {
    // Removed here rather than in the seeder: that process opens the database
    // on import, so it cannot delete the directory it is about to write to.
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    process.stdout.write(`[e2e] seeding fixture at ${FIXTURE_DIR}\n`);
    execFileSync(
        'npx',
        ['ts-node', path.join(__dirname, 'seed-cli.ts'), FIXTURE_DIR],
        // DB_DIR goes in the environment, not set inside the child: src/db.ts
        // reads it at module load and imports hoist above any assignment.
        { stdio: 'inherit', cwd: process.cwd(), env: { ...process.env, DB_DIR: FIXTURE_DIR } }
    );
}
