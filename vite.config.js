import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Electron loads the built files via file://, so a relative base is required.
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
