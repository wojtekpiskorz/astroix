import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';

/**
 * Dev-checkout detection for the ADR-0001 mode switch: the chrome client
 * sources sit as a sibling of the running `dist/` — true for this repo's
 * checkout and for the src-ful staging (`.astroix-local-src`, whose `src` is
 * a symlink to the repo's), false for the publish-shaped staging
 * (`.astroix-local`, dist-only) and for every consumer install (no `src/`
 * ships). This module executes from the bundled `dist/index.js` at runtime.
 * `URL` comes from `node:url` because happy-dom (unit tests) patches the
 * global `URL` with its own class, which `fileURLToPath` rejects.
 *
 * The sibling depth is load-bearing (#150): an earlier two-depth candidate
 * (`../../src/client/entry.tsx`) leaked source mode into the dist-only
 * staging — node realpath-resolves the module through the per-file symlink
 * install to `.astroix-local/dist/index.js`, and the reach-through then hit
 * the repo's own `src/`, so the main lane silently kept serving chrome
 * source instead of exercising the publish-shaped artifact it links.
 */
const candidate = fileURLToPath(new NodeURL('../src/client/entry.tsx', import.meta.url));

/**
 * The served entry, resolved to its real path: the src-staging's `src` is a
 * symlink, and every downstream consumer (the `/@fs` URL, `server.fs.allow`,
 * the `plugin-react` include regex) must operate on the repo path it points
 * at — the class of symlink-vs-realpath edge this detection sits on.
 */
export const clientEntryPath: string | null = existsSync(candidate)
  ? realpathSync(candidate)
  : null;

/**
 * The prebuilt chrome bundle (ADR-0001): a self-contained ESM shipped inside
 * `dist/`. Served by the virtual chrome module when the dev-checkout sources
 * are absent — the consumer-facing delivery mode.
 */
export const chromeArtifactPath: string = fileURLToPath(
  new NodeURL('./chrome.js', import.meta.url),
);

export function isSourceMode(): boolean {
  return clientEntryPath !== null;
}
