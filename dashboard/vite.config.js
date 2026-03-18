import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
    proxy: {
      // Proxy /api to backend; set VITE_API_PROXY if backend uses a different port (e.g. http://127.0.0.1:3001)
      // Use longer timeouts so heavy local SQLite queries do not fail fast in dev.
      '/api': {
        target: process.env.VITE_API_PROXY || 'http://127.0.0.1:3000',
        proxyTimeout: 300000, // 5 minutes upstream timeout
        timeout: 300000, // 5 minutes socket timeout
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
