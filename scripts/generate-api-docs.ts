/**
 * Regenerate the README's API table from src/server.ts.
 *
 * Run with:  npx ts-node scripts/generate-api-docs.ts
 *
 * A test asserts the README matches the server, so this is how you fix it when
 * it fails rather than editing the table by hand.
 */
import fs from 'fs';
import path from 'path';
import { apiRoutes, renderRouteTable } from '../src/services/api-routes';

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'src/server.ts'), 'utf8');
const readmePath = path.join(root, 'README.md');
const readme = fs.readFileSync(readmePath, 'utf8');

const START = '<!-- BEGIN API TABLE -->';
const END = '<!-- END API TABLE -->';

const table = renderRouteTable(apiRoutes(server));
const block = `${START}\n${table}\n${END}`;

if (!readme.includes(START) || !readme.includes(END)) {
    console.error(`README.md is missing the ${START} / ${END} markers.`);
    process.exit(1);
}

const updated = readme.replace(
    new RegExp(`${START}[\\s\\S]*?${END}`),
    () => block
);

fs.writeFileSync(readmePath, updated);
console.log(`Wrote ${apiRoutes(server).length} endpoints into README.md`);
