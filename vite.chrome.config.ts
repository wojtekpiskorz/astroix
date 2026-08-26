import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Chrome prebuilt bundle (ADR-0001): ONE self-contained ESM — react/react-dom,
// the Tailwind-compiled CSS (`chrome.css` rides in through the `?inline`
// import in styles.ts) and CodeMirror all bundled. The consumer's Vite never
// resolves our React.
//
// Bundler choice: `vite build` — the same toolchain that serves the chrome in
// source mode already handles the TSX and the `?inline` css import, so no
// additional bundler enters the repo for one artifact. The Tailwind plugin
// compiles `@import "tailwindcss"` HERE (package build time) — without it the
// raw TW import syntax reaches vite's lightningcss minifier, which rejects it.
export default defineConfig({
  plugins: [tailwindcss()],
  build: {
    lib: {
      entry: 'src/client/chrome.tsx',
      formats: ['es'],
      fileName: () => 'chrome.js',
    },
    outDir: 'dist',
    // tsup owns dist/ (and cleans it) — both outputs coexist per build order
    emptyOutDir: false,
    minify: true,
    cssCodeSplit: false,
  },
});
