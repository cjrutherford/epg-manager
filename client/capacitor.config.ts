import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'net.christopherrutherford.tunerdaemon',
  appName: 'Tuner Daemon',
  webDir: 'dist/client/browser',
  server: {
    androidScheme: 'https',
    cleartext: true
  }
};

export default config;
