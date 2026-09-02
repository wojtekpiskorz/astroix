import { describe, expect, it } from 'vitest';
import { errorEnvelopeSchema, requestEnvelopeSchema, responseEnvelopeSchema } from './envelopes';
import { envelopeBytes, LIMITS, withinByteLimit } from './limits';

/**
 * The three envelopes (#220 AC: unknown fields, unsupported protocol
 * versions, and malformed discriminants are rejected; every
 * session-scoped success response carries SessionRef; idle registry reads
 * do not invent one; oversized envelopes fail their byte limits).
 */
const session = { runtimeEpoch: 'epoch-7f', generation: 4 };
const projectKey = 'abcdefghijklmnopqrstuvwxyz';
const sha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const grant = {
  token: 'g1',
  kind: 'css',
  operations: ['splice'],
  displayPath: 'src/a.css',
  baseline: { type: 'sha256', sha256: sha },
};

describe('requestEnvelopeSchema', () => {
  it('parses a session-scoped command with its exact pair', () => {
    const request = {
      protocolVersion: 1,
      requestId: 'req-1',
      session,
      command: { kind: 'inspect', request: { kind: 'content' } },
    };
    expect(requestEnvelopeSchema.safeParse(request)).toEqual({ success: true, data: request });
  });

  it('accepts the launcher reads: list-projects without a session, activate with or without one', () => {
    expect(
      requestEnvelopeSchema.safeParse({
        protocolVersion: 1,
        requestId: 'req-2',
        command: { kind: 'list-projects' },
      }).success,
    ).toBe(true);
    expect(
      requestEnvelopeSchema.safeParse({
        protocolVersion: 1,
        requestId: 'req-3',
        command: { kind: 'activate', projectKey },
      }).success,
    ).toBe(true);
    expect(
      requestEnvelopeSchema.safeParse({
        protocolVersion: 1,
        requestId: 'req-4',
        session,
        command: { kind: 'activate', projectKey },
      }).success,
    ).toBe(true);
  });

  it('rejects a session-scoped command without its SessionRef', () => {
    expect(
      requestEnvelopeSchema.safeParse({
        protocolVersion: 1,
        requestId: 'req-5',
        command: { kind: 'inspect', request: { kind: 'content' } },
      }).success,
    ).toBe(false);
    expect(
      requestEnvelopeSchema.safeParse({
        protocolVersion: 1,
        requestId: 'req-6',
        command: {
          kind: 'apply-edit',
          plan: { operation: 'splice', grant, range: { start: 0, end: 2 }, replacement: 'x' },
        },
      }).success,
    ).toBe(false);
  });

  it('rejects an idle registry read that invents a SessionRef (ADR-0006 §7)', () => {
    expect(
      requestEnvelopeSchema.safeParse({
        protocolVersion: 1,
        requestId: 'req-7',
        session,
        command: { kind: 'list-projects' },
      }).success,
    ).toBe(false);
  });

  it('rejects unsupported protocol versions, unknown fields, and malformed discriminants', () => {
    const base = { requestId: 'req-8', command: { kind: 'list-projects' } };
    expect(requestEnvelopeSchema.safeParse({ ...base, protocolVersion: 2 }).success).toBe(false);
    expect(requestEnvelopeSchema.safeParse({ ...base, protocolVersion: '1' }).success).toBe(false);
    expect(requestEnvelopeSchema.safeParse(base).success).toBe(false);
    expect(
      requestEnvelopeSchema.safeParse({
        protocolVersion: 1,
        ...base,
        xAstroixRequest: '1', // the mutation marker is an HTTP header, never a JSON field
      }).success,
    ).toBe(false);
    expect(
      requestEnvelopeSchema.safeParse({ protocolVersion: 1, ...base, command: { kind: 1 } })
        .success,
    ).toBe(false);
    expect(
      requestEnvelopeSchema.safeParse({ protocolVersion: 1, ...base, requestId: '' }).success,
    ).toBe(false);
  });
});

describe('responseEnvelopeSchema', () => {
  it('parses a session-scoped success carrying its SessionRef', () => {
    const response = {
      protocolVersion: 1,
      requestId: 'req-1',
      session,
      result: {
        kind: 'inspection',
        result: { kind: 'content', revision: 5, payload: { collections: [] } },
      },
    };
    expect(responseEnvelopeSchema.safeParse(response)).toEqual({ success: true, data: response });
  });

  it('parses the idle registry read — and rejects it inventing a session', () => {
    const idle = {
      protocolVersion: 1,
      requestId: 'req-2',
      result: {
        kind: 'project-list',
        projects: [{ projectKey, displayName: 'site', availability: 'available' }],
      },
    };
    expect(responseEnvelopeSchema.safeParse(idle)).toEqual({ success: true, data: idle });
    expect(responseEnvelopeSchema.safeParse({ ...idle, session }).success).toBe(false);
  });

  it('rejects a session-scoped success without its SessionRef', () => {
    expect(
      responseEnvelopeSchema.safeParse({
        protocolVersion: 1,
        requestId: 'req-3',
        result: { kind: 'edit', result: { revision: 6 } },
      }).success,
    ).toBe(false);
    expect(
      responseEnvelopeSchema.safeParse({
        protocolVersion: 1,
        requestId: 'req-4',
        result: {
          kind: 'activation',
          target: { session, projectKey },
          snapshot: {},
        },
      }).success,
    ).toBe(false);
  });

  it('rejects unknown envelope fields and bad versions on responses too', () => {
    expect(
      responseEnvelopeSchema.safeParse({
        protocolVersion: 1,
        requestId: 'r',
        session,
        result: { kind: 'edit', result: { revision: 1 } },
        cache: 'hit',
      }).success,
    ).toBe(false);
    expect(
      responseEnvelopeSchema.safeParse({
        protocolVersion: 3,
        requestId: 'r',
        session,
        result: { kind: 'edit', result: { revision: 1 } },
      }).success,
    ).toBe(false);
  });
});

describe('errorEnvelopeSchema', () => {
  it('parses the stable shape, with or without the optional session', () => {
    const bare = {
      protocolVersion: 1,
      requestId: 'req-9',
      error: {
        code: 'concurrent-activation',
        message: 'an activation is in flight',
        retryable: true,
      },
    };
    expect(errorEnvelopeSchema.safeParse(bare)).toEqual({ success: true, data: bare });
    expect(
      errorEnvelopeSchema.safeParse({
        ...bare,
        session,
        error: { code: 'stale-session', message: 'the session moved on', retryable: false },
      }).success,
    ).toBe(true);
  });

  it('rejects unknown envelope fields, bad versions, and malformed error bodies', () => {
    expect(
      errorEnvelopeSchema.safeParse({
        protocolVersion: 1,
        requestId: 'r',
        error: { code: 'teapot', message: 'x', retryable: false },
      }).success,
    ).toBe(false);
    expect(
      errorEnvelopeSchema.safeParse({
        protocolVersion: 0,
        requestId: 'r',
        error: { code: 'internal-error', message: 'x', retryable: false },
      }).success,
    ).toBe(false);
    expect(
      errorEnvelopeSchema.safeParse({
        protocolVersion: 1,
        requestId: 'r',
        stack: 'at x',
        error: { code: 'internal-error', message: 'x', retryable: false },
      }).success,
    ).toBe(false);
  });
});

describe('envelope size against the ADR-0006 §7 caps', () => {
  it('fits a real lifecycle envelope under its 64 KiB limit and flags an oversized one', () => {
    const small = {
      protocolVersion: 1,
      requestId: 'r',
      command: { kind: 'list-projects' },
    };
    expect(envelopeBytes(small)).toBeLessThan(LIMITS.lifecycleJsonBytes);
    expect(withinByteLimit(JSON.stringify(small), 'lifecycleJsonBytes')).toBe(true);

    // A lifecycle envelope padded past the cap is rejected by its limit —
    // the transport's check, composed from this package's constants.
    const oversized = { ...small, pad: 'x'.repeat(LIMITS.lifecycleJsonBytes) };
    expect(envelopeBytes(oversized)).toBeGreaterThan(LIMITS.lifecycleJsonBytes);
    expect(withinByteLimit(JSON.stringify(oversized), 'lifecycleJsonBytes')).toBe(false);
  });
});
