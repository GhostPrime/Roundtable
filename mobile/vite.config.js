import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative asset paths — the app is served from the WebView's local scheme.
  base: './',
  build: { outDir: 'dist' },
});
