import fs from 'fs';
import path from 'path';
import {
    apiRoutes,
    extractRoutes,
    normalisePath,
    parseDocumentedRoutes,
    renderRouteTable
} from '../api-routes';

const repoRoot = path.resolve(__dirname, '../../..');
const serverSource = fs.readFileSync(path.join(repoRoot, 'src/server.ts'), 'utf8');
const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

describe('extractRoutes', () => {
    it('reads method, path and auth from a registration', () => {
        const routes = extractRoutes(`
app.get('/api/thing', requireAuth, async (req, res) => {});
app.post('/api/other', async (req, res) => {});
        `);
        expect(routes).toEqual([
            expect.objectContaining({ method: 'GET', path: '/api/thing', requiresAuth: true }),
            expect.objectContaining({ method: 'POST', path: '/api/other', requiresAuth: false })
        ]);
    });

    it('picks up the comment above a route as its description', () => {
        const routes = extractRoutes(`
// GET /api/thing - Does the thing
app.get('/api/thing', async (req, res) => {});
        `);
        expect(routes[0].description).toBe('Does the thing');
    });

    it('uses a plain comment verbatim', () => {
        const routes = extractRoutes(`
// Lists everything worth listing
app.get('/api/thing', async (req, res) => {});
        `);
        expect(routes[0].description).toBe('Lists everything worth listing');
    });

    it('tolerates a route with no comment', () => {
        const routes = extractRoutes(`app.get('/api/thing', async (req, res) => {});`);
        expect(routes[0].description).toBe('');
    });

    it('finds every route in the real server', () => {
        expect(apiRoutes(serverSource).length).toBeGreaterThan(50);
    });
});

describe('normalisePath', () => {
    it('ignores what a parameter is called', () => {
        expect(normalisePath('/api/dvr/:id')).toBe(normalisePath('/api/dvr/:recordingId'));
    });

    it('leaves static paths alone', () => {
        expect(normalisePath('/api/health')).toBe('/api/health');
    });
});

describe('the README API table', () => {
    const documented = parseDocumentedRoutes(readme);
    const registered = apiRoutes(serverSource);
    const registeredKeys = new Set(registered.map(r => `${r.method} ${normalisePath(r.path)}`));

    it('documents something', () => {
        expect(documented.length).toBeGreaterThan(10);
    });

    // The criterion this slice exists for: every endpoint in the README must
    // actually resolve. It used to list /api/job-cancel, which never existed.
    it('names only endpoints that exist', () => {
        const phantom = documented
            .filter(d => d.path.startsWith('/api/'))
            .filter(d => !registeredKeys.has(`${d.method} ${normalisePath(d.path)}`))
            .map(d => `${d.method} ${d.path}`);

        expect(phantom).toEqual([]);
    });

    it('documents every endpoint the server registers', () => {
        const documentedKeys = new Set(
            documented.map(d => `${d.method} ${normalisePath(d.path)}`)
        );
        const undocumented = registered
            .filter(r => !documentedKeys.has(`${r.method} ${normalisePath(r.path)}`))
            .map(r => `${r.method} ${r.path}`);

        expect(undocumented).toEqual([]);
    });

    it('agrees with the server about which endpoints need authentication', () => {
        const authByKey = new Map(
            registered.map(r => [`${r.method} ${normalisePath(r.path)}`, r.requiresAuth])
        );

        const wrong: string[] = [];
        for (const line of readme.split('\n')) {
            const match = line.trim().match(/^\|\s*`(\/api\/[^`]+)`\s*\|\s*(GET|POST|PUT|DELETE)\s*\|\s*(Yes|No)\s*\|/);
            if (!match) continue;
            const key = `${match[2]} ${normalisePath(match[1])}`;
            const expected = authByKey.get(key);
            if (expected === undefined) continue;
            if (expected !== (match[3] === 'Yes')) {
                wrong.push(`${key} documented as auth=${match[3]}, server says ${expected}`);
            }
        }
        expect(wrong).toEqual([]);
    });
});

describe('renderRouteTable', () => {
    it('produces a markdown table', () => {
        const table = renderRouteTable([
            { method: 'GET', path: '/api/health', requiresAuth: false, description: 'Health' }
        ]);
        expect(table).toContain('| Endpoint | Method | Auth | Description |');
        expect(table).toContain('| `/api/health` | GET | No | Health |');
    });

    it('marks an undescribed route rather than leaving a blank cell', () => {
        const table = renderRouteTable([
            { method: 'GET', path: '/api/x', requiresAuth: true, description: '' }
        ]);
        expect(table).toContain('| `/api/x` | GET | Yes | — |');
    });
});
