import type { AstroIntegration } from 'astro';

/**
 * Astroix — dev-only visual builder integration (scaffold stage).
 *
 * Registers no hooks yet; the Vite plugin, `?builder=1` middleware, virtual
 * chrome module and watcher land with the integration tasks — see docs/spec.md
 * and docs/core-reuse.md for the agreed mechanics.
 */
function astroix(): AstroIntegration {
  return {
    name: 'astroix',
    hooks: {},
  };
}

export default astroix;
