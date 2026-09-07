import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

// The guide is a static SPA: `vite build` writes dist/ and nothing serves it
// from this repository — a hub hosts the output the way it hosts any static
// file. No server adapter, no Hono, nothing listening.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
