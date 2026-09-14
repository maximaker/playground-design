import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = process.env.CANVAS_API ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/assets': { target: API, changeOrigin: true },
      '/ws': { target: API.replace('http', 'ws'), ws: true },
    },
  },
  build: { outDir: 'dist', assetsDir: 'assets/app', sourcemap: true },
});
