import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = Number(process.env.COZYPAD_API_PORT || 5674);
export default defineConfig({
  plugins: [react()],
  server: {
    host: process.env.COZYPAD_HOST || '127.0.0.1',
    port: Number(process.env.COZYPAD_WEB_PORT || 5673),
    strictPort: true,
    allowedHosts: process.env.COZYPAD_PUBLIC_ORIGIN ? [new URL(process.env.COZYPAD_PUBLIC_ORIGIN).hostname] : [],
    proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, ws: true } }
  }
});
