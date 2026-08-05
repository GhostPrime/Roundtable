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
    // Monaco's editor API lands in its own ~2.6 MB lazy chunk (loaded only
    // when the editor panel is first opened, never at chat startup). That is
    // the intended shape, so raise the warning threshold rather than
    // restructuring the bundle.
    chunkSizeWarningLimit: 3000,
  },
});
