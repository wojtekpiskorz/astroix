import { describe, expect, it } from 'vitest';
import {
  ERROR_HTTP_STATUS,
  malformedRequestDetailsSchema,
  PUBLIC_ERROR_CODES,
  publicErrorSchema,
} from './errors';

/**
 * Public errors (#220 AC: a closed sanitized union that cannot expose
 * roots, ports, PIDs, environment, capabilities, or stacks; 409/421
 * semantics per ADR-0006 §4/§5).
 */
const base = { message: 'rejected', retryable: false };

describe('the closed code set', () => {
  it('parses every code with the stable body shape', () => {
    for (const code of PUBLIC_ERROR_CODES) {
      const parsed = publicErrorSchema.safeParse({ code, ...base });
      expect(parsed.success, code).toBe(true);
    }
  });

  it('rejects unknown codes, malformed discriminants, and missing required fields', () => {
    expect(publicErrorSchema.safeParse({ code: 'teapot', ...base }).success).toBe(false);
    expect(publicErrorSchema.safeParse({ ...base }).success).toBe(false);
    expect(publicErrorSchema.safeParse({ code: 'stale-session', message: 'x' }).success).toBe(
      false,
    );
    expect(
      publicErrorSchema.safeParse({ code: 'stale-session', message: 'x', retryable: 'no' }).success,
    ).toBe(false);
  });

  it('rejects unknown fields on the body itself', () => {
    expect(
      publicErrorSchema.safeParse({ code: 'internal-error', ...base, stack: 'at x' }).success,
    ).toBe(false);
    expect(publicErrorSchema.safeParse({ code: 'internal-error', ...base, pid: 17 }).success).toBe(
      false,
    );
  });
});

describe('per-code details — the approved sanitized schemas', () => {
  it('accepts each approved details shape and rejects its unknown fields', () => {
    const approved: Record<string, Record<string, unknown>> = {
      'malformed-request': { issue: 'unknown-field', pointer: 'command' },
      'unsupported-protocol-version': { received: 2 },
      'payload-too-large': { limit: 'lifecycleJsonBytes', receivedBytes: 70_000 },
      'resource-not-found': { what: 'project' },
      'grant-rejected': { reason: 'hard-link' },
      'revision-conflict': {
        currentSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      },
    };
    for (const [code, details] of Object.entries(approved)) {
      expect(publicErrorSchema.safeParse({ code, ...base, details }).success, code).toBe(true);
      expect(
        publicErrorSchema.safeParse({ code, ...base, details: { ...details, extra: 1 } }).success,
        code,
      ).toBe(false);
    }
  });

  it('omits details entirely for codes without an approved schema', () => {
    const noSchema = [
      'unauthorized',
      'misdirected-request',
      'stale-session',
      'concurrent-activation',
      'internal-error',
    ];
    for (const code of noSchema) {
      expect(publicErrorSchema.safeParse({ code, ...base, details: {} }).success, code).toBe(false);
      expect(
        publicErrorSchema.safeParse({
          code,
          ...base,
          details: { reason: 'revoked' },
        }).success,
        code,
      ).toBe(false);
    }
  });

  it('sanitizes detail values: pointers are field paths, sizes are integers, hashes are hex', () => {
    expect(
      malformedRequestDetailsSchema.safeParse({ issue: 'unknown-field', pointer: '/Users/x' })
        .success,
    ).toBe(false);
    expect(malformedRequestDetailsSchema.safeParse({ issue: 'ambiguous-encoding' }).success).toBe(
      true,
    );
    expect(
      publicErrorSchema.safeParse({
        code: 'payload-too-large',
        ...base,
        details: { limit: 'infinite', receivedBytes: 1 },
      }).success,
    ).toBe(false);
    expect(
      publicErrorSchema.safeParse({
        code: 'revision-conflict',
        ...base,
        details: { currentSha256: 'zz' },
      }).success,
    ).toBe(false);
  });
});

describe('sanitization of the message', () => {
  it('passes sanitized prose and rejects disclosure shapes in any code', () => {
    expect(publicErrorSchema.safeParse({ code: 'stale-session', ...base }).success).toBe(true);
    for (const message of [
      'the project at /Users/owner/site is unavailable',
      'child pid 4242 exited',
      'boom\n    at fn (/app/x.js:1:1)',
      'E:\\dev\\site exploded',
    ]) {
      expect(
        publicErrorSchema.safeParse({ code: 'internal-error', retryable: false, message }).success,
        JSON.stringify(message),
      ).toBe(false);
    }
  });
});

describe('wire semantics for the transport', () => {
  it('maps each code to its HTTP status — 409 and 421 per ADR-0006', () => {
    expect(ERROR_HTTP_STATUS['concurrent-activation']).toBe(409);
    expect(ERROR_HTTP_STATUS['revision-conflict']).toBe(409);
    expect(ERROR_HTTP_STATUS['stale-session']).toBe(409);
    expect(ERROR_HTTP_STATUS['misdirected-request']).toBe(421);
    expect(ERROR_HTTP_STATUS['payload-too-large']).toBe(413);
    expect(ERROR_HTTP_STATUS['internal-error']).toBe(500);
    expect(Object.keys(ERROR_HTTP_STATUS).sort()).toEqual([...PUBLIC_ERROR_CODES].sort());
  });
});
