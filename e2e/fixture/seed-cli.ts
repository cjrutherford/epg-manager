/**
 * Seeds the fixture from a separate process.
 *
 * `src/db.ts` reads DB_DIR when the module loads and imports hoist, so the
 * variable has to be set before this process starts — the caller passes it in
 * the environment. Doing it in a dedicated process makes that ordering explicit
 * rather than fragile.
 *
 * The import is static and extensionless on purpose. `e2e/` sits outside the
 * tsconfig program, so ts-node compiles it as CommonJS — where a `.js`
 * specifier has to name a file that really exists. A dynamic import does not
 * resolve here either, which is the same trap that took the server down during
 * a sync (X8).
 */
import path from 'path';
import { seedFixture } from './seed';

const target = process.argv[2];
if (!target) {
    console.error('usage: seed-cli <fixture-dir>');
    process.exit(1);
}

if (path.resolve(process.env.DB_DIR || '') !== path.resolve(target)) {
    console.error(`[fixture] DB_DIR must be set to ${target} before starting this process`);
    process.exit(1);
}

seedFixture(target)
    .then(() => {
        console.log(`[fixture] seeded ${target}`);
        process.exit(0);
    })
    .catch(error => {
        console.error('[fixture] seeding failed:', error.message);
        process.exit(1);
    });
