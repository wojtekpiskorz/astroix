import { defineConfig } from 'astro/config';

// The canonical fixture is plain Astro (#213, ADR-0010): no Astroix import,
// no registration, no dependency — and since the retirement gate (#215)
// nothing of Astroix exists anywhere to inject. Content, routes, scoped
// styles and global CSS live in src/ and are the byte-stable contract
// surface.
export default defineConfig({});
