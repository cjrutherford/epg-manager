/**
 * Read the API surface out of `server.ts`.
 *
 * The README's endpoint table was written by hand and had drifted: it listed
 * `/api/job-cancel`, which does not exist (the route is `/api/sync/cancel`),
 * and omitted 66 routes that do. A table nobody can check is documentation only
 * in the sense that it is prose near some code.
 *
 * Parsing the source is deliberately simple — it looks for `app.<verb>('<path>'`
 * and whether `requireAuth` appears in the same call. That is enough to keep the
 * table honest, and a test asserts the README matches.
 */

export interface RouteInfo {
    method: string;
    path: string;
    requiresAuth: boolean;
    /** The `//` comment immediately above the route, when there is one. */
    description: string;
}

const ROUTE_PATTERN = /app\.(get|post|put|delete)\(\s*'([^']+)'\s*,?\s*([^\n]*)/g;

/** Comment lines directly above a line, joined into one description. */
function descriptionAbove(lines: string[], index: number): string {
    const collected: string[] = [];
    for (let i = index - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line === '') break;
        if (line.startsWith('//')) {
            collected.unshift(line.replace(/^\/\/\s?/, '').trim());
            continue;
        }
        break;
    }

    const text = collected.join(' ').trim();
    // Route comments are often written as "GET /api/thing - what it does".
    const afterDash = text.match(/^[A-Z/][^-]*-\s*(.+)$/);
    return (afterDash ? afterDash[1] : text).trim();
}

export function extractRoutes(source: string): RouteInfo[] {
    const lines = source.split('\n');
    const routes: RouteInfo[] = [];

    lines.forEach((line, index) => {
        ROUTE_PATTERN.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = ROUTE_PATTERN.exec(line)) !== null) {
            routes.push({
                method: match[1].toUpperCase(),
                path: match[2],
                requiresAuth: match[3].includes('requireAuth'),
                description: descriptionAbove(lines, index)
            });
        }
    });

    return routes;
}

/** Only the JSON API, excluding the file and page routes. */
export function apiRoutes(source: string): RouteInfo[] {
    return extractRoutes(source)
        .filter(route => route.path.startsWith('/api/'))
        .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

/** Render the markdown table the README carries. */
export function renderRouteTable(routes: RouteInfo[]): string {
    const rows = routes.map(route => {
        const auth = route.requiresAuth ? 'Yes' : 'No';
        const description = route.description || '—';
        return `| \`${route.path}\` | ${route.method} | ${auth} | ${description} |`;
    });

    return [
        '| Endpoint | Method | Auth | Description |',
        '| --- | --- | --- | --- |',
        ...rows
    ].join('\n');
}

/** Endpoints named in a markdown table, as `METHOD path` pairs. */
export function parseDocumentedRoutes(markdown: string): { method: string; path: string }[] {
    const found: { method: string; path: string }[] = [];
    for (const line of markdown.split('\n')) {
        const match = line.trim().match(/^\|\s*`([^`]+)`\s*\|\s*(GET|POST|PUT|DELETE)\s*\|/);
        if (match) found.push({ method: match[2], path: match[1] });
    }
    return found;
}

/** Route paths compare equal regardless of what the parameters are called. */
export function normalisePath(path: string): string {
    return path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':param');
}
