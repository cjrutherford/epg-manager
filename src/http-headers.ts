import type { Request, Response } from 'express';

const DEFAULT_ALLOWED_HEADERS = [
    'Authorization',
    'Content-Type',
    'Accept',
    'Origin',
    'Range',
    'Cache-Control',
    'Last-Event-ID',
    'If-None-Match',
    'If-Modified-Since',
    'X-Requested-With'
].join(', ');

const EXPOSED_HEADERS = [
    'Accept-Ranges',
    'Content-Length',
    'Content-Range',
    'Content-Type',
    'ETag',
    'Last-Modified',
    'Location'
].join(', ');

export function setOpenCorsHeaders(req: Request, res: Response): void {
    const requestedHeaders = req.headers['access-control-request-headers'];

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader(
        'Access-Control-Allow-Headers',
        typeof requestedHeaders === 'string' && requestedHeaders.trim()
            ? requestedHeaders
            : DEFAULT_ALLOWED_HEADERS
    );
    res.setHeader('Access-Control-Expose-Headers', EXPOSED_HEADERS);
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

