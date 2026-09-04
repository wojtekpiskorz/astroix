import { describe, expect, it } from 'vitest';
import {
  COMMAND_MUTATION,
  COMMAND_SESSION_PRESENCE,
  type CommandKind,
  commandSchema,
  RESULT_SESSION_PRESENCE,
  resultSchema,
  sessionPresenceError,
} from './commands';
import { inspectionResultSchema } from './inspection';

/**
 * The closed command/result unions (ADR-0006 §5/§7) and the session
 * presence rules the envelopes enforce.
 */
const projectKey = 'abcdefghijklmnopqrstuvwxyz';
const session = { runtimeEpoch: 'epoch-1', generation: 1 };
const sha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('commandSchema', () => {
  it('parses exactly the browser-callable set (ADR-0006 §5)', () => {
    expect(commandSchema.safeParse({ kind: 'list-projects' }).success).toBe(true);
    expect(commandSchema.safeParse({ kind: 'activate', projectKey }).success).toBe(true);
    expect(commandSchema.safeParse({ kind: 'deactivate' }).success).toBe(true);
    expect(commandSchema.safeParse({ kind: 'inspect', request: { kind: 'styles' } }).success).toBe(
      true,
    );
    expect(
      commandSchema.safeParse({
        kind: 'apply-edit',
        plan: {
          operation: 'replace-contents',
          grant: {
            token: 'g1',
            kind: 'css',
            operations: ['replace-contents'],
            displayPath: 'src/a.css',
            baseline: { type: 'sha256', sha256: sha },
          },
          contents: 'a{}',
        },
      }).success,
    ).toBe(true);
  });

  it('has no register command — registration is a native directory grant (ADR-0006 §1)', () => {
    expect(commandSchema.safeParse({ kind: 'register', root: '/Users/x/site' }).success).toBe(
      false,
    );
    expect(commandSchema.safeParse({ kind: 'remove', projectKey }).success).toBe(false);
    expect(commandSchema.safeParse({ kind: 'rename', projectKey, displayName: 'x' }).success).toBe(
      false,
    );
  });

  it('rejects malformed discriminants and unknown fields', () => {
    expect(commandSchema.safeParse({}).success).toBe(false);
    expect(commandSchema.safeParse({ kind: 'inspect' }).success).toBe(false);
    expect(commandSchema.safeParse({ kind: 'activate' }).success).toBe(false);
    expect(commandSchema.safeParse({ kind: 'activate', projectKey, root: '/x' }).success).toBe(
      false,
    );
  });
});

describe('resultSchema', () => {
  it('parses the idle registry read without inventing a session', () => {
    const result = {
      kind: 'project-list',
      projects: [{ projectKey, displayName: 'site', availability: 'available' }],
    };
    expect(resultSchema.safeParse(result)).toEqual({ success: true, data: result });
  });

  it('carries the target reference and current snapshot on lifecycle results (ADR-0006 §7)', () => {
    for (const kind of ['activation', 'deactivation'] as const) {
      const parsed = resultSchema.safeParse({
        kind,
        target: { session, projectKey },
        snapshot: { attempt: { ref: session, projectKey, state: 'starting' } },
      });
      expect(parsed.success, kind).toBe(true);
    }
    expect(
      resultSchema.safeParse({
        kind: 'activation',
        target: { session, projectKey },
        snapshot: {},
      }).success,
    ).toBe(true);
  });

  it('wraps inspection results and edit results', () => {
    expect(
      resultSchema.safeParse({
        kind: 'inspection',
        result: inspectionResultSchema.parse({ kind: 'routes', revision: 2, payload: [] }),
      }).success,
    ).toBe(true);
    expect(resultSchema.safeParse({ kind: 'edit', result: { revision: 3 } }).success).toBe(true);
  });
});

describe('session presence rules', () => {
  it('binds each command and result kind to its rule (ADR-0006 §3/§5/§7)', () => {
    expect(COMMAND_SESSION_PRESENCE).toEqual({
      'list-projects': 'forbidden',
      activate: 'optional',
      deactivate: 'required',
      inspect: 'required',
      'apply-edit': 'required',
    });
    expect(RESULT_SESSION_PRESENCE).toEqual({
      'project-list': 'forbidden',
      activation: 'required',
      deactivation: 'required',
      inspection: 'required',
      edit: 'required',
    });
  });

  it('classifies exactly the lifecycle and edit commands as mutations (ADR-0006 §7; the table every consumer derives from)', () => {
    expect(COMMAND_MUTATION).toEqual({
      'list-projects': false,
      activate: true,
      deactivate: true,
      inspect: false,
      'apply-edit': true,
    });
    // The table is closed over the command union — a new kind that
    // forgets its classification fails this exhaustiveness pin at type
    // check time, not at a consumer's admission refusal.
    const kinds = Object.keys(COMMAND_SESSION_PRESENCE) as CommandKind[];
    expect([...kinds].sort()).toEqual([...Object.keys(COMMAND_MUTATION)].sort());
  });

  it('reports exactly the required/forbidden violations and null otherwise', () => {
    expect(sessionPresenceError('required', undefined)).toContain('must carry its SessionRef');
    expect(sessionPresenceError('required', session)).toBe(null);
    expect(sessionPresenceError('forbidden', session)).toContain('must not invent a SessionRef');
    expect(sessionPresenceError('forbidden', undefined)).toBe(null);
    expect(sessionPresenceError('optional', undefined)).toBe(null);
    expect(sessionPresenceError('optional', session)).toBe(null);
  });
});
