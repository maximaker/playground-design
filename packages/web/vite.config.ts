import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = process.env.PLAYGROUND_API ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/assets': { target: API, changeOrigin: true },
      // Published pages and the MCP endpoint are served by the API server; the
      // links it hands out point here in dev, so they must pass through too.
      '^/p/': { target: API, changeOrigin: true },
      '^/mcp/': { target: API, changeOrigin: true },
      '/ws': { target: API.replace('http', 'ws'), ws: true },
    },
  },
  build: { outDir: 'dist', assetsDir: 'assets/app', sourcemap: true },
});
