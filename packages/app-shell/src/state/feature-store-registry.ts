/**
 * The feature-store reset registry (#372, ruled 2026-09-04 — option a):
 * the commit-time reset's feature-store wing. Feature-local zustand
 * stores register their reset here — at module scope, beside the
 * store's own creation — and the reset sequencer's `clear-stores`
 * action walks every registration after the shell stores clear and
 * before the state belt closes: inside the pinned step, before
 * navigation. The store's reset semantics (what "cleared" means) stay
 * feature-owned; the TIMING joins the ordered commit-time reset, so a
 * same-document session switch can no more leave stale feature state
 * than stale shell state (K2 #255 proves that invariant structurally
 * over this registry).
 *
 * The registration law (the checklist's amendment): every feature-local
 * zustand store registers. "Dies with the document" is a HOST
 * property, never an exemption — document replacement is the only
 * session-switch path today, and this registry is what makes that fact
 * irrelevant to safety.
 *
 * Store-singleton state by doctrine (ADR-0002: the same doctrine that
 * makes the shell stores module singletons), so the registry is
 * module-level state, not an instance — one shell per document, one
 * registry per document, exactly like the stores it clears.
 */

/** One registered store's reset — feature-owned semantics, sequencer-owned timing. */
export type FeatureStoreReset = () => void;

/** What a registration hands back — the one-use unregister. */
export interface FeatureStoreResetHandle {
  unregister(): void;
}

/** The registered resets, keyed by stable store key — insertion order is the walk order. */
const registrations = new Map<string, FeatureStoreReset>();

/**
 * Registers one feature store's reset under a stable key
 * (`'<vertical>:<store>'`, e.g. `content:discovery`). A same-key
 * registration REPLACES the earlier one — module-scope registration
 * stays idempotent under repeated module evaluation — and the returned
 * handle unregisters exactly this registration: a superseded handle
 * can never unregister its successor.
 *
 * The only way in: the registry is private module state whose only
 * walk is `clearRegisteredFeatureStores` — the sequencer's
 * `clear-stores` wing — so a store cannot register without the ordered
 * reset learning it.
 */
export function registerFeatureStoreReset(
  key: string,
  reset: FeatureStoreReset,
): FeatureStoreResetHandle {
  registrations.set(key, reset);
  return {
    unregister: () => {
      if (registrations.get(key) === reset) registrations.delete(key);
    },
  };
}

/**
 * Clears every registered feature store — the reset sequencer's
 * `clear-stores` wing. The registrations themselves are kept: one per
 * store, walked at every commit for as long as the document lives.
 */
export function clearRegisteredFeatureStores(): void {
  for (const reset of registrations.values()) reset();
}

/** The registered keys, sorted — the registry's census for tests and structural proofs. */
export function registeredFeatureStoreKeys(): readonly string[] {
  return [...registrations.keys()].sort();
}
