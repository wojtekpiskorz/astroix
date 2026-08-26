---
'@wojciechpiskorz/astroix': patch
---

Prebuilt chrome bundle + package shape (ADR-0001): `vite build` compiles the chrome (`src/client/chrome.tsx`) into a single self-contained ESM at `dist/chrome.js` — react/react-dom, the Tailwind-compiled CSS and CodeMirror bundled inside, zero bare react imports. The virtual chrome module's prebuilt mode serves the real artifact (still failing loudly when a build omitted it); react/react-dom move to devDependencies. `bun run build` produces both outputs; a new `check:artifact` gate (run in CI) verifies the artifact's self-containment and the `npm pack` tarball (dist only, no chrome source).
