import { randomBytes } from 'node:crypto';

/**
 * The runtime epoch (#236, F4; ADR-0006 §3 `SessionRef`): a fresh random
 * public value per control-plane lifetime. The epoch is the first half of
 * every {@link SessionRef} — a generation number is only fresh within its
 * epoch, so a restarted control plane can never be confused with the old
 * one even before any generation is reserved.
 *
 * The epoch is correlation and freshness data, **not authentication**
 * (CONTEXT.md: SessionRef) — public by design, carried by every
 * session-scoped artifact, and never a secret to compare against.
 */

/** Epoch entropy: 128 random bits — a public identity, not a capability. */
const RUNTIME_EPOCH_BYTES = 16;

/** Mints one fresh runtime epoch — once per control-plane lifetime, at supervisor construction. */
export function mintRuntimeEpoch(): string {
  return randomBytes(RUNTIME_EPOCH_BYTES).toString('hex');
}
