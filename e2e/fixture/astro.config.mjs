import { defineConfig } from 'astro/config';

// The canonical fixture is plain Astro (#213, ADR-0010): no Astroix import,
// no registration, no dependency — the retired integration runs only
// through disposable oracle copies the prepare scripts generate (see
// e2e/oracle.mjs). Content, routes, scoped styles and global CSS live in
// src/ and are the byte-stable contract surface.
export default defineConfig({});
