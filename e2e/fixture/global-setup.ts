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
    // Seeding is handled before webServer starts src/server.ts in playwright.config.ts.
}
