import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from '../package.json';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    // App version (from the root package.json) — surfaced as the live
    // "UPLINK_OS_vX.Y.Z" readout in the call HUD.
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});