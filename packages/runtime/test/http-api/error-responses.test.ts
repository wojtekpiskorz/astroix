import {
  ERROR_HTTP_STATUS,
  errorEnvelopeSchema,
  findDisclosure,
  PUBLIC_ERROR_CODES,
} from '@wojciechpiskorz/astroix-protocol';
import { describe, expect, it } from 'vitest';
import {
  apiResponseHeaders,
  buildErrorEnvelope,
  errorResponse,
  PUBLIC_ERROR_MESSAGES,
  publicErrorResponse,
  successResponse,
  UNAVAILABLE_REQUEST_ID,
} from '../../api/errors/error-responses.ts';
import { SESSION } from './fixtures.ts';

/**
 * The sanitized public-error responses (#234; ADR-0006 §7 "Errors use a
 * stable envelope", ADR-0007 output hygiene): every code's message is
 * constant and disclosure-clean, every drafted body parses against the
 * protocol's closed error-envelope schema, statuses follow
 * `ERROR_HTTP_STATUS`, responses carry `no-store`, and no CORS header
 * exists anywhere.
 */

describe('the closed message table', () => {
  it('carries one non-empty message per public code, all disclosure-clean', () => {
    expect(new Set(Object.keys(PUBLIC_ERROR_MESSAGES))).toEqual(new Set(PUBLIC_ERROR_CODES));
    for (const code of PUBLIC_ERROR_CODES) {
      const message = PUBLIC_ERROR_MESSAGES[code];
      expect(message.length, code).toBeGreaterThan(0);
      expect(findDisclosure(message), code).toBeNull();
    }
  });
});

describe('error envelope construction', () => {
  it('builds schema-valid envelopes: constant message, optional session echo, closed details', () => {
    const envelope = buildErrorEnvelope({
      code: 'malformed-request',
      requestId: 'req-1',
      details: { malformed: { issue: 'unknown-field', pointer: 'command.extra' } },
    });
    expect(() => errorEnvelopeSchema.parse(envelope)).not.toThrow();
    expect(envelope.error.message).toBe(PUBLIC_ERROR_MESSAGES['malformed-request']);
    expect(envelope.session).toBeUndefined();
    const scoped = buildErrorEnvelope({ code: 'stale-session', session: SESSION });
    expect(scoped.session).toEqual(SESSION);
  });

  it('defaults the correlation id and retryable honestly', () => {
    const envelope = buildErrorEnvelope({ code: 'internal-error' });
    expect(envelope.requestId).toBe(UNAVAILABLE_REQUEST_ID);
    expect(envelope.error.retryable).toBe(false);
  });

  it('cannot construct an unapproved code/detail pairing — closure enforced at build time', () => {
    // unauthorized has no approved details schema (ADR-0006 §7): a
    // details payload for it throws at construction, never reaches the wire
    expect(() =>
      buildErrorEnvelope({
        code: 'unauthorized',
        details: { notFound: { what: 'route' } } as never,
      }),
    ).toThrow();
  });
});

describe('error response drafts', () => {
  it('answers each code with its HTTP status, the API header set, and a schema-valid body', () => {
    for (const code of PUBLIC_ERROR_CODES) {
      const draft = errorResponse({ code, session: SESSION });
      expect(draft.status, code).toBe(ERROR_HTTP_STATUS[code]);
      expect(draft.headers['cache-control'], code).toBe('no-store');
      expect(draft.headers['content-type'], code).toBe('application/json');
      expect(draft.headers['x-astroix-generated'], code).toBe('1');
      expect(() => errorEnvelopeSchema.parse(JSON.parse(draft.body)), code).not.toThrow();
      expect(findDisclosure(draft.body), code).toBeNull();
    }
  });

  it('never grants CORS — no access-control header exists on the response surface', () => {
    const headers = apiResponseHeaders();
    for (const name of Object.keys(headers)) {
      expect(name.toLowerCase().startsWith('access-control-')).toBe(false);
    }
    expect(JSON.stringify(headers).toLowerCase()).not.toContain('access-control');
  });
});

describe('executor error and success passthrough', () => {
  it('answers an executor-returned public error as itself, under the request id and session', () => {
    const draft = publicErrorResponse(
      {
        code: 'concurrent-activation',
        message: 'another activation attempt is in flight',
        retryable: true,
      },
      'req-9',
      SESSION,
    );
    expect(draft.status).toBe(409);
    const envelope = errorEnvelopeSchema.parse(JSON.parse(draft.body));
    expect(envelope.error.code).toBe('concurrent-activation');
    expect(envelope.requestId).toBe('req-9');
    expect(envelope.session).toEqual(SESSION);
  });

  it('drafts a success response with the same header law', () => {
    const draft = successResponse(
      JSON.stringify({
        protocolVersion: 1,
        requestId: 'r',
        result: { kind: 'project-list', projects: [] },
      }),
    );
    expect(draft.status).toBe(200);
    expect(draft.headers['cache-control']).toBe('no-store');
    expect(draft.headers['content-type']).toBe('application/json');
  });
});
