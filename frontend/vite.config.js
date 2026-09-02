import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // "@/..." import alias — used by the new IncidentSearch/ProfileMenu
    // components, which follow the common shadcn-ui convention of
    // importing from "@/components/..." and "@/lib/utils" rather than
    // relative paths.
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:4000', '/socket.io': { target: 'http://localhost:4000', ws: true } },
  },
});