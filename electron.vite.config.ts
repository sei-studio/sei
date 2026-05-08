import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: { index: path.resolve('src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: { index: path.resolve('src/preload/index.ts') },
        output: {
          format: 'cjs',
          entryFileNames: '[name].js',
          chunkFileNames: '[name]-[hash].js',
        },
      },
    },
  },
  renderer: {
    root: path.resolve('src/renderer'),
    build: {
      outDir: path.resolve('dist/renderer'),
      emptyOutDir: true,
      rollupOptions: {
        input: { index: path.resolve('src/renderer/index.html') },
      },
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve('src/renderer/src'),
        '@shared': path.resolve('src/shared'),
      },
    },
  },
});
