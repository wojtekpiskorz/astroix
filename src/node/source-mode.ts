import { existsSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';

/**
 * Dev-checkout detection for the ADR-0001 mode switch: the chrome client
 * sources exist next to the integration only when the package runs from this
 * repo (an installed package ships no `src/`). Two candidate depths because
 * this module executes from `src/node/` during development and from the
 * bundled `dist/index.js` at runtime. `URL` comes from `node:url` because
 * happy-dom (unit tests) patches the global `URL` with its own class, which
 * `fileURLToPath` rejects.
 */
const candidates = [
  fileURLToPath(new NodeURL('../../src/client/entry.tsx', import.meta.url)),
  fileURLToPath(new NodeURL('../src/client/entry.tsx', import.meta.url)),
];

export const clientEntryPath: string | null = candidates.find((path) => existsSync(path)) ?? null;

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
