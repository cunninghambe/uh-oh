import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const SERVER_TARGET = process.env['UH_OH_SERVER_URL'] ?? 'http://127.0.0.1:3300';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': { target: SERVER_TARGET, changeOrigin: true },
      '/ingest': { target: SERVER_TARGET, changeOrigin: true },
    },
  },
});
