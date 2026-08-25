import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The dashboard talks to the backend through this proxy in development, so
    // the browser only ever sees same-origin requests and CORS never becomes a
    // debugging distraction. In production VITE_API_BASE_URL is used instead.
    proxy: {
      '/api': { target: 'http://localhost:4001', changeOrigin: true },
      '/health': { target: 'http://localhost:4001', changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.js'],
    css: false,
  },
});
