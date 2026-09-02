/**
 * The workspace barrel for `@wojciechpiskorz/astroix-protocol` — protocol
 * v1 (#220, ADR-0006 §7): the closed, versioned wire contract shared by
 * the app shell and the runtime. Version and wire constants, limits,
 * session identity and query keys, registry/session/inspection/edit
 * schemas, the closed command/result unions, the three envelopes, the
 * SSE event frames, and the sanitized public-error union. Pure schemas
 * and pure helpers only — no IO, no fetch, no node-only imports (the
 * package is browser-safe by contract).
 */

export * from './commands';
export * from './edits';
export * from './envelopes';
export * from './errors';
export * from './events';
export * from './inspection';
export * from './limits';
export * from './query-keys';
export * from './registry';
export * from './sanitization';
export * from './session';
export * from './session-state';
export * from './version';
export * from './wire';
