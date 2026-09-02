import { z } from 'zod';

/**
 * SessionRef (ADR-0006 §3): the public session identity pair.
 *
 * ```ts
 * type SessionRef = { runtimeEpoch: string; generation: number };
 * ```
 *
 * `runtimeEpoch` is a fresh random public value per control-plane lifetime;
 * `generation` increases for every activation attempt (failed and cancelled
 * ones included) and is not persisted across epochs — the first attempt of
 * an epoch is generation 1. The pair is correlation and freshness data,
 * **not authentication** (authority is the separate 256-bit capability,
 * which never appears on the wire); every session-scoped command, response,
 * error, query key, and event carries the exact pair (CONTEXT.md:
 * SessionRef).
 */
export const runtimeEpochSchema = z.string().min(1);

/** Monotonic per-epoch activation counter; 1 is the first attempt. */
export const sessionGenerationSchema = z.number().int().positive();

export const sessionRefSchema = z.strictObject({
  runtimeEpoch: runtimeEpochSchema,
  generation: sessionGenerationSchema,
});

export type SessionRef = z.infer<typeof sessionRefSchema>;
