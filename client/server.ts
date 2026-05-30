import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as http from 'node:http';
import { 
  AngularNodeAppEngine, 
  writeResponseToNodeResponse, 
  isMainModule 
} from '@angular/ssr/node';

const serverDistFolder = dirname(fileURLToPath(import.meta.url));
const browserDistFolder = resolve(serverDistFolder, '../browser');

const angularNodeAppEngine = new AngularNodeAppEngine({
  allowedHosts: ['*']
});

export function app(): express.Express {
  const server = express();

  // Proxy /api and /files requests to the backend API
  const apiHost = process.env['API_HOST'] || '127.0.0.1';
  const apiPort = parseInt(process.env['API_PORT'] || '4000', 10);

  server.use(['/api', '/files'], (req, res) => {
    const proxyReq = http.request({
      hostname: apiHost,
      port: apiPort,
      path: req.originalUrl,
      method: req.method,
      headers: { ...req.headers, host: `${apiHost}:${apiPort}` }
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.status(503).json({ error: 'Backend API unavailable', details: err.message });
      }
    });
    res.on('close', () => {
      if (!res.writableEnded) {
        proxyReq.destroy();
      }
    });
    req.pipe(proxyReq);
  });

  // Serve static files from /browser
  server.get('*.*', express.static(browserDistFolder, {
    maxAge: '1y'
  }));

  // All regular routes use the Angular engine
  server.get('*', (req, res, next) => {
    angularNodeAppEngine
      .handle(req, { server: 'express' })
      .then((response) => (response ? writeResponseToNodeResponse(response, res) : next()))
      .catch(next);
  });

  return server;
}

function run(): void {
  const port = process.env['PORT'] || 4000;

  // Start up the Node server
  const server = app();
  server.listen(port, () => {
    console.log(`Node Express server listening on http://localhost:${port}`);
  });
}

if (isMainModule(import.meta.url)) {
  run();
}
export default app;
