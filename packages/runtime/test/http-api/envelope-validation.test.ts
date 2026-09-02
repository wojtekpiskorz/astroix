import { LIMITS } from '@wojciechpiskorz/astroix-protocol';
import { describe, expect, it } from 'vitest';
import {
  requestByteCap,
  responseWithinCap,
  validateRequestEnvelope,
} from '../../api/http/envelope-validation.ts';
import {
  applyEditEnvelope,
  inspectEnvelope,
  listProjectsEnvelope,
  NEXT_SESSION,
  SESSION,
} from './fixtures.ts';

/**
 * Bounded request-envelope validation (#234; ADR-0006 §7 "Reject
 * unknown JSON fields … unsupported protocol versions", "Initial hard
 * limits"; D1's reviewer note: the caps are enforced HERE, at the
 * transport): the zod-failure mapping onto the closed
 * `malformed-request` / `unsupported-protocol-version` detail unions,
 * and the per-command-class byte caps in UTF-8 bytes.
 */

describe('byte caps by command class (the wired limits)', () => {
  it('maps every command class onto its protocol cap — edits 8 MiB, all other control JSON 64 KiB', () => {
    expect(requestByteCap('apply-edit')).toBe('editRequestBytes');
    expect(requestByteCap('list-projects')).toBe('lifecycleJsonBytes');
    expect(requestByteCap('activate')).toBe('lifecycleJsonBytes');
    expect(requestByteCap('deactivate')).toBe('lifecycleJsonBytes');
    expect(requestByteCap('inspect')).toBe('lifecycleJsonBytes');
    expect(LIMITS.editRequestBytes).toBe(8 * 1024 * 1024);
    expect(LIMITS.lifecycleJsonBytes).toBe(64 * 1024);
  });

  it('rejects a schema-valid lifecycle envelope over 64 KiB — duplicate JSON keys keep it valid while inflating the bytes', () => {
    // JSON allows repeated keys (the last parse wins), so this body is
    // BOTH schema-valid and over the cap — the honest way the byte cap
    // binds on a bounded-field envelope: caps count wire bytes, not fields.
    const padding = ',"requestId":"req-1"'.repeat(4000); // ~72 KiB of valid JSON
    const body = `{${listProjectsEnvelope().slice(1, -1)}${padding}}`;
    const result = validateRequestEnvelope(body);
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.rejection.code).toBe('payload-too-large');
    expect(result.rejection.details?.tooLarge).toEqual({
      limit: 'lifecycleJsonBytes',
      receivedBytes: Buffer.byteLength(body, 'utf8'),
    });
  });

  it('bounds the response side by the inspection response cap', () => {
    expect(responseWithinCap('{}')).toBe(true);
    const oversized = JSON.stringify({ padding: 'x'.repeat(LIMITS.inspectionResponseBytes) });
    expect(responseWithinCap(oversized)).toBe(false);
  });
});

describe('malformed bodies', () => {
  it('rejects non-JSON bodies as invalid-shape with no pointer', () => {
    const result = validateRequestEnvelope('this is not json');
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.rejection.code).toBe('malformed-request');
    expect(result.rejection.details?.malformed).toEqual({ issue: 'invalid-shape' });
    expect(result.rejection.requestId).toBeUndefined();
  });

  it('rejects non-object JSON bodies', () => {
    for (const body of ['42', '"text"', 'null', '[1,2]']) {
      const result = validateRequestEnvelope(body);
      expect(result.kind, body).toBe('rejected');
    }
  });
});

describe('unknown JSON fields (ADR-0006 §7)', () => {
  it('names the offending field and its JSON-pointer-style location', () => {
    const result = validateRequestEnvelope(listProjectsEnvelope({ extra: 1 }));
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.rejection.code).toBe('malformed-request');
    expect(result.rejection.details?.malformed).toEqual({
      issue: 'unknown-field',
      pointer: 'extra',
    });
    expect(result.rejection.requestId).toBe('req-1');
  });

  it('locates unknown fields inside nested objects', () => {
    const body = JSON.stringify({
      protocolVersion: 1,
      requestId: 'req-1',
      command: { kind: 'inspect', request: { kind: 'styles', rogue: true } },
      session: SESSION,
    });
    const result = validateRequestEnvelope(body);
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.rejection.details?.malformed).toEqual({
      issue: 'unknown-field',
      pointer: 'command.request.rogue',
    });
  });
});

describe('invalid discriminants and shapes', () => {
  it('rejects an unknown command kind as invalid-discriminant at command', () => {
    const result = validateRequestEnvelope(
      JSON.stringify({ protocolVersion: 1, requestId: 'req-1', command: { kind: 'nope' } }),
    );
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.rejection.code).toBe('malformed-request');
    expect(result.rejection.details?.malformed).toEqual({
      issue: 'invalid-discriminant',
      pointer: 'command',
    });
  });

  it('rejects a shape failure with its location and echoes the session of session-scoped traffic', () => {
    const body = JSON.stringify({
      protocolVersion: 1,
      requestId: 'req-1',
      session: SESSION,
      command: { kind: 'inspect', request: { wrong: 'shape' } },
    });
    const result = validateRequestEnvelope(body);
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.rejection.code).toBe('malformed-request');
    expect(result.rejection.details?.malformed?.issue).toBe('invalid-shape');
    expect(result.rejection.session).toEqual(SESSION);
  });

  it('rejects a session-scoped command without its SessionRef (the envelope-level presence law)', () => {
    const result = validateRequestEnvelope(
      JSON.stringify({
        protocolVersion: 1,
        requestId: 'req-1',
        command: { kind: 'inspect', request: { kind: 'styles' } },
      }),
    );
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.rejection.code).toBe('malformed-request');
    expect(result.rejection.details?.malformed).toEqual({
      issue: 'invalid-shape',
      pointer: 'session',
    });
  });

  it('rejects an idle registry read that invented a SessionRef', () => {
    const result = validateRequestEnvelope(listProjectsEnvelope({ session: NEXT_SESSION }));
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.rejection.code).toBe('malformed-request');
  });
});

describe('unsupported protocol versions (ADR-0006 §7)', () => {
  it('rejects protocolVersion 2 with the received value in the details', () => {
    const result = validateRequestEnvelope(
      JSON.stringify({
        protocolVersion: 2,
        requestId: 'req-1',
        command: { kind: 'list-projects' },
      }),
    );
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.rejection.code).toBe('unsupported-protocol-version');
    expect(result.rejection.details?.unsupportedVersion).toEqual({ received: 2 });
  });

  it('rejects a stringified version without echoing a non-number', () => {
    const result = validateRequestEnvelope(
      JSON.stringify({
        protocolVersion: '1',
        requestId: 'req-1',
        command: { kind: 'list-projects' },
      }),
    );
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.rejection.code).toBe('unsupported-protocol-version');
    expect(result.rejection.details).toBeUndefined();
  });
});

describe('well-formed envelopes pass with their parsed shape', () => {
  it("admits every command kind's canonical envelope", () => {
    for (const body of [listProjectsEnvelope(), inspectEnvelope(), applyEditEnvelope()]) {
      const result = validateRequestEnvelope(body);
      expect(result.kind, body).toBe('envelope');
    }
    const edit = validateRequestEnvelope(applyEditEnvelope());
    if (edit.kind !== 'envelope') throw new Error('unreachable');
    expect(edit.envelope.command.kind).toBe('apply-edit');
  });
});
