import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const SERVER_TARGET = process.env['UH_OH_SERVER_URL'] ?? 'http://127.0.0.1:3300';

// Shared by both `vite dev` and `vite preview` — the app only ever fetches relative paths
// (see api.ts), so both need the same reverse proxy to reach a real server. The e2e suite
// (e2e/global-setup.ts) runs `vite build` + `vite preview` against a throwaway server instance
// and points this at it via UH_OH_SERVER_URL, exactly like `vite dev` already does — no new
// VITE_ env needed.
const proxy = {
  '/api': { target: SERVER_TARGET, changeOrigin: true },
  '/ingest': { target: SERVER_TARGET, changeOrigin: true },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    proxy,
  },
});
