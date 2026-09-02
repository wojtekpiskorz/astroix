import { z } from 'zod';

/**
 * Protocol version 1 (ADR-0006 §7 "Protocol version 1"): control traffic
 * lives below `/__astroix/api/v1/` and **every envelope carries
 * `protocolVersion: 1`** — requests, responses, errors, and SSE event
 * frames alike. The literal schema is what enforces the ADR's "reject
 * unsupported protocol versions" rule at parse time: any other value
 * (including a stringified `"1"` or a future `2`) fails the envelope.
 */
export const PROTOCOL_VERSION = 1;

/** The `protocolVersion` field of every v1 envelope — a literal, not a range. */
export const protocolVersionSchema = z.literal(PROTOCOL_VERSION);

export type ProtocolVersion = z.infer<typeof protocolVersionSchema>;
