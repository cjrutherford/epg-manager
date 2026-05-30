import axios from 'axios';
import { buildStorage } from 'axios-cache-interceptor';
import * as fs from 'fs';
import * as path from 'path';
import * as v8 from 'v8';
import { DB_DIR } from '../db';

const CACHE_DIR = path.join(DB_DIR, 'http-cache');

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

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

  return instance;
};

// 2. Monkeypatch ESM axios.js on disk (which is loaded by ESM packages like epg-grabber)
try {
  // Find node_modules/axios/index.js relative to this script
  const esmIndexPath = path.resolve(__dirname, '../../node_modules/axios/index.js');
  if (fs.existsSync(esmIndexPath)) {
    const content = fs.readFileSync(esmIndexPath, 'utf8');
    if (!content.includes('__diskStorage')) {
      console.log(`[DiskCache] Patching ESM axios entrypoint on disk: ${esmIndexPath}`);
      const patch = `
// --- AXIOS CACHE PATCH ---
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
    console.log('[DiskCache ESM] Axios Request - URL: ' + reqConfig.url + ', cache option: ' + JSON.stringify(reqConfig.cache));
    return reqConfig;
  });
  
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

console.log('[DiskCache] Axios disk cache patch initialized.');
