import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    target: 'es2017',
    assetsInlineLimit: 100000000,
    cssCodeSplit: false
  }
});
