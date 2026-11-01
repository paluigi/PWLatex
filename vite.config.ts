import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// NOTE: `public/core/busytex` (~686 MB of WASM + TeX Live data) is served
// as-is by Vite from the public folder. It is git-ignored — restore it with
// `npm run download-assets` after a fresh clone.
export default defineConfig({
  plugins: [svelte()],
  build: {
    target: 'es2023',
  },
});
