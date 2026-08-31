/// <reference types="vite/client" />

declare module '*.css?inline' {
  const css: string;
  export default css;
}

/** Wire payload of the `astroix:file-changed` push (watch-sync.ts, the sender). */
interface AstroixFileChangedPayload {
  file: string;
}

/**
 * Wire payload of the `astroix:content-synced` push: which watcher leg fired
 * (the sender's half is `ContentSyncLeg` in `src/node/content-signal.ts`).
 */
interface AstroixContentSyncedPayload {
  leg: 'srcdir' | 'loader';
}

declare module 'vite/types/customEvent' {
  interface CustomEventMap {
    'astroix:file-changed': AstroixFileChangedPayload;
    'astroix:routes-changed': Record<string, never>;
    'astroix:content-synced': AstroixContentSyncedPayload;
  }
}

/**
 * The window half of the hot→window bridge (#166): the chrome subscribes to
 * the node-side pushes as window CustomEvents because `import.meta.hot`
 * usage inside the chrome is dead-code-eliminated from the lib bundle — the
 * bridge text prepended to the virtual chrome module
 * (`HOT_TO_WINDOW_BRIDGE` in src/node/vite-plugin.ts) forwards every entry
 * below from the hot channel, `detail` = the wire payload (`undefined` when
 * a push carries none — consumers guard, never throw). Identical in both
 * delivery arms (ADR-0001); the payloads share their types with the wire
 * map above, one source.
 */
interface WindowEventMap {
  'astroix:file-changed': CustomEvent<AstroixFileChangedPayload | undefined>;
  'astroix:content-synced': CustomEvent<AstroixContentSyncedPayload | undefined>;
  'astroix:routes-changed': CustomEvent<Record<string, never> | undefined>;
  'astro:content-changed': CustomEvent<unknown>;
}
