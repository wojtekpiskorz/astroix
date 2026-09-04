import { COMMAND_MUTATION } from '@wojciechpiskorz/astroix-protocol';
import { describe, expect, it } from 'vitest';
import {
  COMMAND_ENDPOINT_PATHS,
  COMMAND_ROUTES,
  classifyApiRoute,
  rolePermitted,
} from '../../api/http/command-routes.ts';

/**
 * The command-endpoint route classification and the permission matrix
 * (#234): the two exact route spellings, the literal-only match (no
 * decoding, no normalization, no query), and every cell of the
 * command × host × role matrix (ADR-0006 §5/§7).
 */

describe('command endpoint route classification', () => {
  it('admits exactly the two canonical spellings of the command endpoint', () => {
    expect(COMMAND_ENDPOINT_PATHS).toEqual(['/__astroix/api/v1', '/__astroix/api/v1/']);
    expect(classifyApiRoute('/__astroix/api/v1').kind).toBe('command-endpoint');
    expect(classifyApiRoute('/__astroix/api/v1/').kind).toBe('command-endpoint');
  });

  it("answers unknown-route for every other reserved path — including F3's events path before it composes", () => {
    for (const target of [
      '/__astroix',
      '/__astroix/',
      '/__astroix/app/',
      '/__astroix/events',
      '/__astroix/api',
      '/__astroix/api/',
      '/__astroix/api/v1/commands',
      '/__astroix/api/v2',
      '/__astroix/api/v1/extra/segments',
    ]) {
      expect(classifyApiRoute(target), target).toEqual({ kind: 'unknown-route' });
    }
  });

  it('matches the literal path only — encoded lookalikes and normalizations are unknown routes', () => {
    for (const target of [
      '/__astroix/api%2Fv1',
      '/__astroix/api%2fv1/',
      '/__astroix/api/v1/..',
      '/__astroix/api/v1/.',
      '/__astroix/./api/v1',
    ]) {
      expect(classifyApiRoute(target), target).toEqual({ kind: 'unknown-route' });
    }
  });

  it('answers unknown-route for a query-carrying command endpoint — the envelope is the whole request', () => {
    expect(classifyApiRoute('/__astroix/api/v1/?page=2')).toEqual({ kind: 'unknown-route' });
    expect(classifyApiRoute('/__astroix/api/v1?x=1')).toEqual({ kind: 'unknown-route' });
    expect(classifyApiRoute('/__astroix/api/v1?').kind).toBe('command-endpoint'); // bare '?' is no query
  });

  it("re-runs the listener's target classification as defense in depth — absolute-form and ambiguous encodings refused", () => {
    expect(classifyApiRoute('http://launcher.localhost:4321/__astroix/api/v1')).toEqual({
      kind: 'rejected-target',
      reason: 'absolute-form-target',
    });
    expect(classifyApiRoute('*')).toEqual({
      kind: 'rejected-target',
      reason: 'asterisk-form-target',
    });
    expect(classifyApiRoute('/__astroix%2Fapi/v1')).toEqual({
      kind: 'rejected-target',
      reason: 'ambiguous-reserved-encoding',
    });
    expect(classifyApiRoute('/%5f%5fastroix/api/v1')).toEqual({
      kind: 'rejected-target',
      reason: 'ambiguous-reserved-encoding',
    });
    // the backslash boundary is ambiguous too — WHATWG normalizes `\` to `/`
    expect(classifyApiRoute('/__astroix%5Capi/v1')).toEqual({
      kind: 'rejected-target',
      reason: 'ambiguous-reserved-encoding',
    });
    expect(classifyApiRoute(undefined)).toEqual({
      kind: 'rejected-target',
      reason: 'malformed-target',
    });
  });
});

describe('command permission matrix (ADR-0006 §5)', () => {
  it('classifies mutations and reads per ADR-0006 §7', () => {
    expect(COMMAND_ROUTES['list-projects'].mutation).toBe(false);
    expect(COMMAND_ROUTES.inspect.mutation).toBe(false);
    expect(COMMAND_ROUTES.activate.mutation).toBe(true);
    expect(COMMAND_ROUTES.deactivate.mutation).toBe(true);
    expect(COMMAND_ROUTES['apply-edit'].mutation).toBe(true);
  });

  it("derives every cell's mutation bit from the protocol table — the server and the client's marker set are one truth (#334)", () => {
    for (const [kind, mutation] of Object.entries(COMMAND_MUTATION)) {
      expect(COMMAND_ROUTES[kind as keyof typeof COMMAND_ROUTES].mutation, kind).toBe(mutation);
    }
  });

  it('pins every cell: lifecycle is launcher+editor; inspection is project editor+diagnostic; editing is project editor alone', () => {
    // lifecycle commands — launcher document on the launcher host, the
    // authoritative editor on the project host (§5 "launcher and
    // authoritative project target only")
    for (const command of ['list-projects', 'activate', 'deactivate'] as const) {
      expect(rolePermitted(command, 'launcher', 'launcher'), command).toBe(true);
      expect(rolePermitted(command, 'launcher', 'editor'), command).toBe(false);
      expect(rolePermitted(command, 'launcher', 'diagnostic'), command).toBe(false);
      expect(rolePermitted(command, 'project', 'editor'), command).toBe(true);
      expect(rolePermitted(command, 'project', 'launcher'), command).toBe(false);
      expect(rolePermitted(command, 'project', 'diagnostic'), command).toBe(false);
    }
    // inspection — the active project host only; diagnostics read
    expect(rolePermitted('inspect', 'project', 'editor')).toBe(true);
    expect(rolePermitted('inspect', 'project', 'diagnostic')).toBe(true);
    expect(rolePermitted('inspect', 'project', 'launcher')).toBe(false);
    expect(rolePermitted('inspect', 'launcher', 'launcher')).toBe(false);
    expect(rolePermitted('inspect', 'launcher', 'editor')).toBe(false);
    // editing — the one authoritative editor alone
    expect(rolePermitted('apply-edit', 'project', 'editor')).toBe(true);
    expect(rolePermitted('apply-edit', 'project', 'diagnostic')).toBe(false);
    expect(rolePermitted('apply-edit', 'project', 'launcher')).toBe(false);
    expect(rolePermitted('apply-edit', 'launcher', 'launcher')).toBe(false);
  });
});
