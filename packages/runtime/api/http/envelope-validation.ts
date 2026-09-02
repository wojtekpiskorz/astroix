import {
  type ByteLimitName,
  COMMAND_SESSION_PRESENCE,
  type CommandKind,
  type PublicErrorCode,
  type RequestEnvelope,
  requestEnvelopeSchema,
  type SessionRef,
  sessionRefSchema,
  withinByteLimit,
} from '@wojciechpiskorz/astroix-protocol';
import type { ErrorDetails } from '../errors/error-responses.ts';

/**
 * Bounded request-envelope parsing for the command endpoint (#234, F2;
 * ADR-0006 §7 "Reject unknown JSON fields … and unsupported protocol
 * versions", "Initial hard limits"; D1's reviewer note: byte-caps
 * enforcement is the transport's job — this is that transport). Pure:
 * body text in, parsed envelope or a typed sanitized rejection out.
 *
 * The caps are wired, not decorative: every request envelope is bounded
 * by its command class's byte cap (`lifecycleJsonBytes` for the
 * lifecycle/inspection control JSON, `editRequestBytes` for an
 * `apply-edit` envelope), counted in UTF-8 bytes via the protocol's own
 * `withinByteLimit`. The zod failures map onto the protocol's closed
 * `malformed-request` detail union — unknown fields, invalid
 * discriminants, invalid shapes — and onto `unsupported-protocol-version`
 * for a wrong `protocolVersion`, with the rejected numeric value
 * echoed only when it is a number.
 */

/** The outcome of validating one request body. */
export type EnvelopeValidation =
  | { readonly kind: 'envelope'; readonly envelope: RequestEnvelope }
  | { readonly kind: 'rejected'; readonly rejection: EnvelopeRejection };

/** The sanitized rejection parts: the public error plus the echoable identity. */
export interface EnvelopeRejection {
  readonly code: PublicErrorCode;
  readonly details?: ErrorDetails;
  /**
   * The requester's id, carried out only when the parsed JSON held a
   * non-empty string `requestId` — malformed traffic echoes nothing it
   * was not given.
   */
  readonly requestId?: string;
  /** The pair, carried out only when the parsed envelope was session-scoped. */
  readonly session?: SessionRef;
}

/** The byte cap of one command class — `editRequestBytes` for edits, `lifecycleJsonBytes` for all other control JSON. */
export function requestByteCap(command: CommandKind): ByteLimitName {
  return command === 'apply-edit' ? 'editRequestBytes' : 'lifecycleJsonBytes';
}

/** Safely reads the echoable request id out of an arbitrary parsed body — never trusts the shape. */
function echoableRequestId(parsed: unknown): string | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const id = (parsed as { requestId?: unknown }).requestId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** The JSON-pointer-style location of one zod issue path — `command`, `plan.grant`, or absent for the root. */
function pointerOf(path: readonly PropertyKey[]): string | undefined {
  const joined = path.map((segment) => String(segment)).join('.');
  return joined.length > 0 ? joined : undefined;
}

/** Maps one failed envelope parse onto the closed rejection vocabulary — the only zod-failure mapping there is. */
function rejectEnvelope(
  parsed: unknown,
  issues: ReadonlyArray<{ code: string; path: readonly PropertyKey[]; keys?: string[] }>,
): EnvelopeRejection {
  const first = issues[0];
  if (first === undefined) {
    return { code: 'malformed-request', details: { malformed: { issue: 'invalid-shape' } } };
  }
  if (first.code === 'unrecognized_keys') {
    const key = first.keys?.[0];
    const base = pointerOf(first.path);
    return {
      code: 'malformed-request',
      details: {
        malformed: {
          issue: 'unknown-field',
          ...(key !== undefined ? { pointer: base === undefined ? key : `${base}.${key}` } : {}),
        },
      },
      requestId: echoableRequestId(parsed),
    };
  }
  if (
    first.code === 'invalid_union' &&
    first.path.length === 2 &&
    first.path[0] === 'command' &&
    first.path[1] === 'kind'
  ) {
    // exactly the envelope's command discriminant — a nested union's
    // discriminant (e.g. `command.request.kind`) is an invalid SHAPE at
    // its own location, not an unknown command
    return {
      code: 'malformed-request',
      details: { malformed: { issue: 'invalid-discriminant', pointer: 'command' } },
      requestId: echoableRequestId(parsed),
    };
  }
  if (first.code === 'invalid_value' && first.path[0] === 'protocolVersion') {
    const received = (parsed as { protocolVersion?: unknown })?.protocolVersion;
    return {
      code: 'unsupported-protocol-version',
      ...(typeof received === 'number' ? { details: { unsupportedVersion: { received } } } : {}),
      requestId: echoableRequestId(parsed),
    };
  }
  return {
    code: 'malformed-request',
    details: {
      malformed: {
        issue: 'invalid-shape',
        ...(pointerOf(first.path) !== undefined ? { pointer: pointerOf(first.path) } : {}),
      },
    },
    requestId: echoableRequestId(parsed),
  };
}

/** Carries the session out of a rejected parse when the traffic was session-scoped — the echo rule (ADR-0006 §7). */
function withSession(rejection: EnvelopeRejection, parsed: unknown): EnvelopeRejection {
  const kind = (parsed as { command?: { kind?: unknown } })?.command?.kind;
  if (typeof kind !== 'string' || !(kind in COMMAND_SESSION_PRESENCE)) return rejection;
  if (COMMAND_SESSION_PRESENCE[kind as CommandKind] !== 'required') return rejection;
  const session = parseSessionRef((parsed as { session?: unknown }).session);
  return session === null ? rejection : { ...rejection, session };
}

function parseSessionRef(value: unknown): SessionRef | null {
  const parsed = sessionRefSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Validates one request body end to end: JSON parse, strict envelope
 * schema (unknown fields rejected, session presence bound to the
 * command), and the command class's byte cap over the body's UTF-8
 * bytes. Malformed JSON is an `invalid-shape` rejection carrying no
 * pointer — there is no envelope to point into.
 */
export function validateRequestEnvelope(body: string): EnvelopeValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      kind: 'rejected',
      rejection: { code: 'malformed-request', details: { malformed: { issue: 'invalid-shape' } } },
    };
  }
  const result = requestEnvelopeSchema.safeParse(parsed);
  if (!result.success) {
    return {
      kind: 'rejected',
      rejection: withSession(rejectEnvelope(parsed, result.error.issues), parsed),
    };
  }
  const cap = requestByteCap(result.data.command.kind);
  if (!withinByteLimit(body, cap)) {
    return {
      kind: 'rejected',
      rejection: withSession(
        {
          code: 'payload-too-large',
          details: {
            tooLarge: { limit: cap, receivedBytes: Buffer.byteLength(body, 'utf8') },
          },
          requestId: echoableRequestId(parsed),
        },
        parsed,
      ),
    };
  }
  return { kind: 'envelope', envelope: result.data };
}

/** True when one response envelope fits the protocol's response byte cap (ADR-0006 §7: 32 MiB per inspection response). */
export function responseWithinCap(serialized: string): boolean {
  return withinByteLimit(serialized, 'inspectionResponseBytes');
}
