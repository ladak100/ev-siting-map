import { defineConfig } from 'vite';

// base must match the GitHub Pages repo name so built asset URLs resolve correctly.
// Update this if the repo is renamed.
export default defineConfig({
  base: '/ev-siting-map/',
  build: {
    outDir: 'dist',
  },
});
