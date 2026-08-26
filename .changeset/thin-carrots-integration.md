---
'@wojciechpiskorz/astroix': patch
---

Node integration: default-on builder chrome over every top-level dev URL with the `?builder=0` escape hatch (pre-internal Vite middleware, `server.transformIndexHtml`), the `virtual:astroix/chrome` module with the ADR-0001 mode switch (source mode in the dev checkout; prebuilt fails loudly until shipped), source-mode injections (`@vitejs/plugin-react` include-scoped, `@tailwindcss/vite` with a host double-registration guard), the canvas script hiding Astro's dev toolbar inside the iframe, and a warn-only React-19 guard in the chrome. Non-dev commands register nothing (dev-only guarantee).
