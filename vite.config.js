import { defineConfig } from 'vite';

// Static SPA. Base '' so it works from any sub-path when deployed.
export default defineConfig({
  base: '',
  // allowedHosts: true lets tunnel hostnames (*.trycloudflare.com, etc.) reach the server.
  server: { port: 5173, host: true, allowedHosts: true },
  preview: { port: 5173, host: true, allowedHosts: true },
  build: { outDir: 'dist', emptyOutDir: true },
});
