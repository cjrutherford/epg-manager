import axios from 'axios';
import { buildStorage } from 'axios-cache-interceptor';
import * as fs from 'fs';
import * as path from 'path';
import * as v8 from 'v8';
import { DB_DIR } from '../db';

const CACHE_DIR = path.join(DB_DIR, 'http-cache');

// Ensure cache directory exists
try {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
} catch (err) {}

// Build a custom disk storage using buildStorage from axios-cache-interceptor
export const diskStorage = buildStorage({
  find: async (key) => {
    console.log(`[DiskCache] find called for key: ${key}`);
    const filePath = path.join(CACHE_DIR, `${key}.bin`);
    if (!fs.existsSync(filePath)) return undefined;
    try {
      const buffer = fs.readFileSync(filePath);
      const entry = v8.deserialize(buffer);
      
      // If the cached response data contains a serialized Buffer structure,
      // convert it back to a native Node.js Buffer instance.
      if (entry && entry.data && entry.data.data) {
        if (entry.data.data.type === 'Buffer' && Array.isArray(entry.data.data.data)) {
          entry.data.data = Buffer.from(entry.data.data.data);
        } else if (entry.data.data instanceof Uint8Array) {
          entry.data.data = Buffer.from(entry.data.data);
        }
      }
      return entry;
    } catch (err) {
      return undefined;
    }
  },
  set: async (key, value) => {
    console.log(`[DiskCache] set called for key: ${key}`);
    const filePath = path.join(CACHE_DIR, `${key}.bin`);
    try {
      const serialized = v8.serialize(value);
      fs.writeFileSync(filePath, serialized);
    } catch (err) {
      console.error(`[DiskCache] Failed to write cache for ${key}:`, err);
    }
  },
  remove: async (key) => {
    const filePath = path.join(CACHE_DIR, `${key}.bin`);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {}
    }
  },
  clear: async () => {
    if (fs.existsSync(CACHE_DIR)) {
      const files = fs.readdirSync(CACHE_DIR);
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(CACHE_DIR, file));
        } catch (err) {}
      }
    }
  }
});

// Helper function to identify transient network / rate-limit HTTP errors
export function isTransientError(error: any): boolean {
  if (!error) return false;
  const status = error.response?.status;
  if (status === 429 || (status >= 500 && status <= 509)) {
    return true;
  }
  const code = error.code;
  if (code && ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_NETWORK'].includes(code)) {
    return true;
  }
  if (error.message && (error.message.includes('timeout') || error.message.includes('network error'))) {
    return true;
  }
  return false;
}

// Attach retry interceptor with exponential backoff and jitter
export function attachRetryInterceptor(instance: any) {
  if (!instance?.interceptors?.response) return;
  instance.interceptors.response.use(
    (response: any) => response,
    async (error: any) => {
      const config = error?.config;
      if (!config) return Promise.reject(error);

      const maxRetries = config.maxRetries ?? 3;
      config._retryCount = config._retryCount ?? 0;

      if (config._retryCount < maxRetries && isTransientError(error)) {
        config._retryCount++;
        const backoffMs = Math.pow(2, config._retryCount) * 500 + Math.floor(Math.random() * 250);
        console.warn(`[AxiosRetry] Transient error (${error.response?.status || error.code || error.message}) requesting ${config.url}. Retrying in ${backoffMs}ms (attempt ${config._retryCount}/${maxRetries})...`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        return instance(config);
      }
      return Promise.reject(error);
    }
  );
}

// Set global storage for ESM version to access
(globalThis as any).__diskStorage = diskStorage;

// 1. Monkeypatch CJS axios.create (which is loaded in our app's CJS context)
const originalCreate = axios.create;
axios.create = function(config?: any) {
  const instance = originalCreate.call(this, config);
  
  let currentStorage: any = diskStorage;
  Object.defineProperty(instance, 'storage', {
    get() {
      return currentStorage;
    },
    set(val) {
      currentStorage = diskStorage;
    },
    configurable: true,
    enumerable: true
  });
  
  instance.interceptors.request.use((reqConfig: any) => {
    console.log(`[DiskCache CJS] Axios Request - URL: ${reqConfig.url}, cache option: ${JSON.stringify(reqConfig.cache)}`);
    return reqConfig;
  });

  attachRetryInterceptor(instance);

  return instance;
};

// Also attach retry interceptor to global axios instance
attachRetryInterceptor(axios);

// 2. Monkeypatch ESM axios.js on disk (which is loaded by ESM packages like epg-grabber)
try {
  // Find node_modules/axios/index.js relative to this script
  const esmIndexPath = path.resolve(__dirname, '../../node_modules/axios/index.js');
  if (fs.existsSync(esmIndexPath)) {
    const content = fs.readFileSync(esmIndexPath, 'utf8');
    if (!content.includes('__diskStorage')) {
      console.log(`[DiskCache] Patching ESM axios entrypoint on disk: ${esmIndexPath}`);
      const patch = `
// --- AXIOS CACHE & RETRY PATCH ---
const originalCreate = axios.create;
axios.create = function(config) {
  const instance = originalCreate.call(this, config);
  let currentStorage = globalThis.__diskStorage;
  Object.defineProperty(instance, 'storage', {
    get() {
      return globalThis.__diskStorage || currentStorage;
    },
    set(val) {
      if (globalThis.__diskStorage) {
        currentStorage = globalThis.__diskStorage;
      } else {
        currentStorage = val;
      }
    },
    configurable: true,
    enumerable: true
  });
  
  instance.interceptors.request.use((reqConfig) => {
    reqConfig.headers = reqConfig.headers || {};
    if (!reqConfig.headers['User-Agent'] && !reqConfig.headers['user-agent']) {
      reqConfig.headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
    }
    if (!reqConfig.headers['Accept'] && !reqConfig.headers['accept']) {
      reqConfig.headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
    }
    return reqConfig;
  });

  instance.interceptors.response.use(
    (res) => res,
    async (err) => {
      const cfg = err?.config;
      if (!cfg) return Promise.reject(err);
      const maxRetries = cfg.maxRetries ?? 3;
      cfg._retryCount = cfg._retryCount ?? 0;
      const status = err.response?.status;
      const isTransient = status === 429 || (status >= 500 && status <= 509) || (err.code && ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND'].includes(err.code));
      if (cfg._retryCount < maxRetries && isTransient) {
        cfg._retryCount++;
        const backoffMs = Math.pow(2, cfg._retryCount) * 500 + Math.floor(Math.random() * 250);
        console.warn('[AxiosRetry ESM] Transient error retrying ' + cfg.url + ' in ' + backoffMs + 'ms');
        await new Promise(r => setTimeout(r, backoffMs));
        return instance(cfg);
      }
      return Promise.reject(err);
    }
  );
  
  return instance;
};
// -------------------------
`;
      const target = "import axios from './lib/axios.js';";
      const patchedContent = content.replace(target, `${target}\n${patch}`);
      fs.writeFileSync(esmIndexPath, patchedContent, 'utf8');
      console.log('[DiskCache] ESM axios entrypoint successfully patched.');
    }
  } else {
    console.warn(`[DiskCache] ESM axios entrypoint not found at ${esmIndexPath}`);
  }
} catch (err: any) {
  console.error('[DiskCache] Failed to patch ESM axios entrypoint:', err);
}

console.log('[DiskCache] Axios disk cache and retry patch initialized.');

