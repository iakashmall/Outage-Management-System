import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Mobile crew PWA — runs on 5174, proxies API to the OMS backend on 4000.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: { '/api': 'http://localhost:4000' },
  },
});
