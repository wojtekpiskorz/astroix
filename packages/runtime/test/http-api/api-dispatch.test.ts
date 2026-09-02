import { errorEnvelopeSchema } from '@wojciechpiskorz/astroix-protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { dispatchApiRequest } from '../../api/http/api-dispatch.ts';
import {
  type AuthorityFixture,
  activateEnvelope,
  applyEditEnvelope,
  createAuthorityFixture,
  deactivateEnvelope,
  inspectEnvelope,
  KEY_A,
  launcherHeaders,
  listProjectsEnvelope,
  NEXT_SESSION,
  OTHER_EPOCH,
  projectHeaders,
  projectListResult,
} from './fixtures.ts';

/**
 * The F2 admission matrices over the pure dispatch core (#234; ADR-0006
 * §7's admission paragraph, ADR-0007's mandatory negative matrix):
 * mutations (exact Host/Origin, capability, role, JSON, marker,
 * SessionRef), reads (exact Host, capability, same-origin Fetch
 * Metadata, role, no CORS grant), the Host/capability/binding/SessionRef
 * staleness matrices, and the malformed/duplicate/oversized refusals —
 * every leg against the REAL grants table, binding table, and
 * validation mapping, through the single dispatch entry point.
 */

const URL = '/__astroix/api/v1/';

let fixture: AuthorityFixture;

beforeEach(() => {
  fixture = createAuthorityFixture();
  fixture.setExecutorResult(projectListResult());
});

function post(body: string, rawHeaders: string[], url: string = URL, method = 'POST') {
  return dispatchApiRequest({ method, url, rawHeaders, body }, fixture.authority);
}

function errorBody(draft: { body: string }): { code: string; message: string } {
  return (
    errorEnvelopeSchema.parse(JSON.parse(draft.body)) as {
      error: { code: string; message: string };
    }
  ).error;
}

function errorDetails(draft: { body: string }): unknown {
  const envelope = errorEnvelopeSchema.parse(JSON.parse(draft.body));
  return (envelope.error as { details?: unknown }).details;
}

describe('admitted traffic — every command kind reaches the executor and answers 200', () => {
  it('admits the launcher read (list-projects) and the launcher mutation (activate)', async () => {
    const read = await post(listProjectsEnvelope(), launcherHeaders(fixture, {}, 'read'));
    expect(read.status).toBe(200);
    expect(fixture.executed.map((envelope) => envelope.command.kind)).toEqual(['list-projects']);
    const mutation = await post(activateEnvelope(), launcherHeaders(fixture, {}, 'mutation'));
    expect(mutation.status).toBe(200);
    expect(fixture.executed).toHaveLength(2);
  });

  it('admits the project-host session-scoped commands: deactivate, inspect (editor AND diagnostic), apply-edit', async () => {
    await post(deactivateEnvelope(), projectHeaders(fixture, 'editor', {}, 'mutation'));
    await post(inspectEnvelope(), projectHeaders(fixture, 'editor'));
    await post(inspectEnvelope(), projectHeaders(fixture, 'diagnostic'));
    await post(applyEditEnvelope(), projectHeaders(fixture, 'editor', {}, 'mutation'));
    expect(fixture.executed.map((envelope) => envelope.command.kind)).toEqual([
      'deactivate',
      'inspect',
      'inspect',
      'apply-edit',
    ]);
    for (const kind of ['deactivate', 'inspect', 'apply-edit'] as const) {
      const envelope = fixture.executed.find((candidate) => candidate.command.kind === kind);
      expect(envelope?.session, kind).toEqual({ runtimeEpoch: 'epoch-fixture', generation: 1 });
    }
  });

  it('answers with no-store, JSON content type, and the generated marker — never a CORS grant', async () => {
    const draft = await post(listProjectsEnvelope(), launcherHeaders(fixture));
    expect(draft.headers['cache-control']).toBe('no-store');
    expect(draft.headers['content-type']).toBe('application/json');
    expect(draft.headers['x-astroix-generated']).toBe('1');
    expect(JSON.stringify(draft.headers).toLowerCase()).not.toContain('access-control');
  });
});

describe('Host and host-capability matrices (ADR-0007 negatives)', () => {
  it('refuses an unknown virtual host — fail closed even behind the listener', async () => {
    const draft = await post(
      listProjectsEnvelope(),
      launcherHeaders(fixture, { Host: 'nobody.localhost:4321' }),
    );
    expect(draft.status).toBe(404);
    expect(errorBody(draft).code).toBe('resource-not-found');
    expect(fixture.executed).toHaveLength(0);
  });

  it('refuses a malformed or duplicated Host at the dispatch boundary (defense in depth)', async () => {
    const malformed = await post(
      listProjectsEnvelope(),
      launcherHeaders(fixture, { Host: 'a..localhost:4321' }),
    );
    expect(malformed.status).toBe(404);
    const duplicated = await post(
      listProjectsEnvelope(),
      launcherHeaders(fixture, { Host: ['launcher.localhost:4321', 'evil.example'] }),
    );
    expect(duplicated.status).toBe(400);
    expect(errorBody(duplicated).code).toBe('malformed-request');
  });

  it('refuses a port-mismatched Host', async () => {
    const draft = await post(
      listProjectsEnvelope(),
      launcherHeaders(fixture, { Host: 'launcher.localhost:9999' }),
    );
    expect(draft.status).toBe(404);
  });

  it('refuses the project host while no project is bound', async () => {
    fixture.setState({ sessionRef: null, projectKey: null });
    const draft = await post(inspectEnvelope(), projectHeaders(fixture, 'editor'));
    expect(draft.status).toBe(404);
    expect(errorBody(draft).code).toBe('resource-not-found');
  });

  it('refuses a missing, wrong, stale, cross-host, or smuggle-shaped capability — all unauthorized', async () => {
    const legs: Array<[string, string[]]> = [
      ['missing cookie', launcherHeaders(fixture, { Cookie: true })],
      ['wrong cookie', launcherHeaders(fixture, { Cookie: `__astroix_host=${'0'.repeat(64)}` })],
      [
        'project cookie on launcher host',
        launcherHeaders(fixture, { Cookie: `__astroix_host=${fixture.projectCapability}` }),
      ],
      [
        'launcher cookie on project host',
        projectHeaders(fixture, 'editor', {
          Cookie: `__astroix_host=${fixture.launcherCapability}`,
        }),
      ],
      [
        'duplicate capability cookie name',
        launcherHeaders(fixture, {
          Cookie: `__astroix_host=${fixture.launcherCapability}; __astroix_host=${fixture.launcherCapability}`,
        }),
      ],
    ];
    for (const [name, headers] of legs) {
      const draft = await post(listProjectsEnvelope(), headers);
      expect(draft.status, name).toBe(403);
      expect(errorBody(draft).code, name).toBe('unauthorized');
    }
    expect(fixture.executed).toHaveLength(0);
  });

  it('refuses the stale capability after the host re-minted — the A-to-B-to-A host-cookie shape', async () => {
    const stale = fixture.launcherCapability;
    const fresh = fixture.grants.mint({ host: 'launcher' });
    expect(fresh).not.toBe(stale);
    const draft = await post(
      listProjectsEnvelope(),
      launcherHeaders(fixture, { Cookie: `__astroix_host=${stale}` }),
    );
    expect(draft.status).toBe(403);
    const admitted = await post(
      listProjectsEnvelope(),
      launcherHeaders(fixture, { Cookie: `__astroix_host=${fresh}` }),
    );
    expect(admitted.status).toBe(200);
  });
});

describe('Origin and Fetch Metadata matrices (ADR-0006 §7)', () => {
  it('mutations require the exact Origin', async () => {
    const legs: Array<[string, Record<string, string | true>]> = [
      ['missing origin', { Origin: true }],
      ['foreign origin', { Origin: 'http://evil.example' }],
      ['the other virtual host', { Origin: `http://${KEY_A}.localhost:4321` }],
    ];
    for (const [name, extras] of legs) {
      const draft = await post(activateEnvelope(), launcherHeaders(fixture, extras, 'mutation'));
      expect(draft.status, name).toBe(403);
      expect(errorBody(draft).code, name).toBe('unauthorized');
    }
    expect(fixture.executed).toHaveLength(0);
  });

  it('accepts a case-different but exact Origin (URL scheme/host case-insensitivity)', async () => {
    const draft = await post(
      activateEnvelope(),
      launcherHeaders(fixture, { Origin: 'HTTP://LAUNCHER.LOCALHOST:4321' }, 'mutation'),
    );
    expect(draft.status).toBe(200);
  });

  it('reads require same-origin Fetch Metadata — missing is refused (the oracle finding pinned)', async () => {
    const legs: Array<[string, Record<string, string | true>]> = [
      ['missing entirely', { 'Sec-Fetch-Site': true }],
      ['cross-site', { 'Sec-Fetch-Site': 'cross-site' }],
      ['same-site (not same-origin)', { 'Sec-Fetch-Site': 'same-site' }],
      ['none', { 'Sec-Fetch-Site': 'none' }],
    ];
    for (const [name, extras] of legs) {
      const draft = await post(listProjectsEnvelope(), launcherHeaders(fixture, extras));
      expect(draft.status, name).toBe(403);
      expect(errorBody(draft).code, name).toBe('unauthorized');
    }
  });

  it('refuses a read whose Origin disagrees with its same-origin claim — forged evidence', async () => {
    const draft = await post(
      listProjectsEnvelope(),
      launcherHeaders(fixture, { 'Sec-Fetch-Site': 'same-origin', Origin: 'http://evil.example' }),
    );
    expect(draft.status).toBe(403);
  });

  it('mutations require the exact X-Astroix-Request marker value', async () => {
    for (const marker of [true, '0', '2', 'true'] as (string | true)[]) {
      const draft = await post(
        activateEnvelope(),
        launcherHeaders(fixture, { 'X-Astroix-Request': marker }, 'mutation'),
      );
      expect(draft.status, `marker=${String(marker)}`).toBe(403);
    }
    const read = await post(listProjectsEnvelope(), launcherHeaders(fixture, {}, 'read'));
    expect(read.status).toBe(200);
  });

  it('refuses a read that carries the mutation marker — contradictory transport evidence is malformed', async () => {
    const draft = await post(
      listProjectsEnvelope(),
      launcherHeaders(fixture, { 'X-Astroix-Request': '1' }),
    );
    expect(draft.status).toBe(400);
    expect(errorBody(draft).code).toBe('malformed-request');
  });
});

describe('client-binding matrices (document-bound authority)', () => {
  it('refuses a missing, unbound, or revoked client capability', async () => {
    const unbound = 'client-nobody';
    const legs: Array<[string, Record<string, string | true>]> = [
      ['missing header', { 'X-Astroix-Client': true }],
      ['unbound value', { 'X-Astroix-Client': unbound }],
    ];
    for (const [name, extras] of legs) {
      const draft = await post(listProjectsEnvelope(), launcherHeaders(fixture, extras));
      expect(draft.status, name).toBe(403);
      expect(errorBody(draft).code, name).toBe('unauthorized');
    }
    fixture.bindings.bind({
      role: 'launcher',
      host: 'launcher',
      sessionRef: null,
      capability: 'client-doomed',
    });
    fixture.bindings.unbind('client-doomed');
    const revoked = await post(
      listProjectsEnvelope(),
      launcherHeaders(fixture, { 'X-Astroix-Client': 'client-doomed' }),
    );
    expect(revoked.status).toBe(403);
    expect(fixture.executed).toHaveLength(0);
  });

  it('refuses a binding used on the other host — a launcher document never acts on the project host', async () => {
    const draft = await post(
      inspectEnvelope(),
      projectHeaders(fixture, 'editor', { 'X-Astroix-Client': fixture.launcherClient }),
    );
    expect(draft.status).toBe(403);
  });

  it('enforces the role matrix end to end: diagnostics read but never mutate; the launcher host serves no project command', async () => {
    const diagnosticMutations: Array<[string, string]> = [
      ['deactivate', deactivateEnvelope()],
      ['apply-edit', applyEditEnvelope()],
    ];
    for (const [name, body] of diagnosticMutations) {
      const draft = await post(body, projectHeaders(fixture, 'diagnostic', {}, 'mutation'));
      expect(draft.status, name).toBe(403);
    }
    for (const [name, body] of [
      ['inspect on launcher', inspectEnvelope()],
      ['apply-edit on launcher', applyEditEnvelope()],
    ] as Array<[string, string]>) {
      const draft = await post(body, launcherHeaders(fixture, {}, 'read'));
      expect(draft.status, name).toBe(403);
    }
    // the diagnostic's permitted read stays admitted
    const read = await post(inspectEnvelope(), projectHeaders(fixture, 'diagnostic'));
    expect(read.status).toBe(200);
  });
});

describe('SessionRef freshness matrices (ADR-0006 §3/§5)', () => {
  it('refuses a wrong-generation, wrong-epoch, and post-revocation SessionRef as stale — with the pair echoed', async () => {
    for (const session of [NEXT_SESSION, OTHER_EPOCH]) {
      const draft = await post(inspectEnvelope(session), projectHeaders(fixture, 'editor'));
      expect(draft.status, `epoch=${session.runtimeEpoch}`).toBe(409);
      const envelope = errorEnvelopeSchema.parse(JSON.parse(draft.body));
      expect(envelope.error.code).toBe('stale-session');
      expect(envelope.session).toEqual(session);
    }
    fixture.setState({ sessionRef: null, projectKey: KEY_A });
    const noSession = await post(inspectEnvelope(), projectHeaders(fixture, 'editor'));
    expect(noSession.status).toBe(409);
    expect(errorBody(noSession).code).toBe('stale-session');
    expect(fixture.executed).toHaveLength(0);
  });

  it('refuses a session-scoped command whose envelope lacks the pair — the envelope-level law, surfaced as malformed', async () => {
    const body = JSON.stringify({
      protocolVersion: 1,
      requestId: 'req-1',
      command: { kind: 'deactivate' },
    });
    const draft = await post(body, projectHeaders(fixture, 'editor', {}, 'mutation'));
    expect(draft.status).toBe(400);
    expect(errorBody(draft).code).toBe('malformed-request');
  });

  it('admits activate without a pair from the idle launcher; refuses activate that claims a stale pair', async () => {
    fixture.setState({ sessionRef: null, projectKey: null });
    const idle = await post(activateEnvelope(), launcherHeaders(fixture, {}, 'mutation'));
    expect(idle.status).toBe(200);
    fixture.setState({
      sessionRef: { runtimeEpoch: 'epoch-fixture', generation: 7 },
      projectKey: KEY_A,
    });
    const claiming = activateEnvelope({
      session: { runtimeEpoch: 'epoch-fixture', generation: 1 },
    });
    const stale = await post(claiming, launcherHeaders(fixture, {}, 'mutation'));
    expect(stale.status).toBe(409);
    expect(errorBody(stale).code).toBe('stale-session');
  });

  it('refuses a session-scoped command from a document bound at another generation — the stale tab, even against a fresh envelope', async () => {
    // the binding was minted at generation 1; the session moved to 2 and
    // the envelope truthfully carries 2: the DOCUMENT is stale (403, not
    // 409 — the binding does not cover this traffic at all)
    fixture.setState({ sessionRef: NEXT_SESSION, projectKey: KEY_A });
    const draft = await post(inspectEnvelope(NEXT_SESSION), projectHeaders(fixture, 'editor'));
    expect(draft.status).toBe(403);
    expect(errorBody(draft).code).toBe('unauthorized');
    expect(fixture.executed).toHaveLength(0);
  });
});

describe('route, method, and transport hygiene', () => {
  it('refuses non-POST methods and unknown routes — the command endpoint is the one route', async () => {
    for (const method of ['GET', 'OPTIONS', 'PUT', 'DELETE']) {
      const draft = await post(listProjectsEnvelope(), launcherHeaders(fixture), URL, method);
      expect(draft.status, method).toBe(404);
      expect(errorBody(draft).code, method).toBe('resource-not-found');
    }
    for (const url of [
      '/__astroix/api/v1/none',
      '/__astroix/events',
      '/__astroix/api/v1/?page=1',
    ]) {
      const draft = await post(listProjectsEnvelope(), launcherHeaders(fixture), url);
      expect(draft.status, url).toBe(404);
    }
    expect(fixture.executed).toHaveLength(0);
  });

  it('refuses absolute-form and ambiguous-encoding targets at the dispatch boundary (defense in depth)', async () => {
    const absolute = await post(
      listProjectsEnvelope(),
      launcherHeaders(fixture),
      'http://launcher.localhost:4321/__astroix/api/v1/',
    );
    expect(absolute.status).toBe(400);
    expect(errorBody(absolute).code).toBe('malformed-request');
    const ambiguous = await post(
      listProjectsEnvelope(),
      launcherHeaders(fixture),
      '/__astroix%2Fapi/v1/',
    );
    expect(ambiguous.status).toBe(400);
    expect(errorDetails(ambiguous)).toEqual({ issue: 'ambiguous-encoding' });
  });

  it('refuses duplicate security-relevant headers before any value is read — every name in the closed set', async () => {
    // ALL EIGHT names of SECURITY_RELEVANT_HEADERS drive this one loop:
    // six the base header set never spells, plus `host` (the base set
    // already carries one Host pair, so the two appended pairs make
    // three — the duplicate branch fires BEFORE the Host
    // re-derivation, which is the ordering under test) and
    // `content-length` (absent from the base set; a real socket's node
    // parser would refuse it even earlier — this pins the dispatch's
    // own defense, the layer further from the socket).
    for (const [name, header] of [
      ['host', 'Host'],
      ['origin', 'Origin'],
      ['cookie', 'Cookie'],
      ['content-type', 'Content-Type'],
      ['content-length', 'Content-Length'],
      ['sec-fetch-site', 'Sec-Fetch-Site'],
      ['x-astroix-request', 'X-Astroix-Request'],
      ['x-astroix-client', 'X-Astroix-Client'],
    ] as const) {
      const base = launcherHeaders(fixture);
      const draft = await post(listProjectsEnvelope(), [...base, header, 'x', header, 'y']);
      expect(draft.status, name).toBe(400);
      expect(errorBody(draft).code, name).toBe('malformed-request');
    }
    expect(fixture.executed).toHaveLength(0);
  });

  it('requires exact JSON content — text/plain and foreign parameters are malformed', async () => {
    for (const contentType of ['text/plain', 'application/json; charset=iso-8859-1', 'text/json']) {
      const draft = await post(
        listProjectsEnvelope(),
        launcherHeaders(fixture, { 'Content-Type': contentType }),
      );
      expect(draft.status, contentType).toBe(400);
      expect(errorBody(draft).code, contentType).toBe('malformed-request');
    }
    const fine = await post(
      listProjectsEnvelope(),
      launcherHeaders(fixture, { 'Content-Type': 'application/json; charset=utf-8' }),
    );
    expect(fine.status).toBe(200);
  });
});

describe('malformed and oversized payloads (ADR-0006 §7)', () => {
  it('maps malformed JSON, unknown fields, bad discriminants, and wrong versions onto the closed codes', async () => {
    const legs: Array<[string, string, string]> = [
      ['not json', 'plain text', 'malformed-request'],
      ['unknown field', listProjectsEnvelope({ extra: true }), 'malformed-request'],
      [
        'unknown command',
        JSON.stringify({ protocolVersion: 1, requestId: 'req-1', command: { kind: 'nope' } }),
        'malformed-request',
      ],
      [
        'future version',
        JSON.stringify({
          protocolVersion: 2,
          requestId: 'req-1',
          command: { kind: 'list-projects' },
        }),
        'unsupported-protocol-version',
      ],
    ];
    for (const [name, body, code] of legs) {
      const draft = await post(body, launcherHeaders(fixture));
      expect(draft.status, name).toBe(400);
      expect(errorBody(draft).code, name).toBe(code);
    }
    // unknown-field details survive the trip end to end
    const unknown = await post(listProjectsEnvelope({ rogue: 1 }), launcherHeaders(fixture));
    expect(errorDetails(unknown)).toEqual({ issue: 'unknown-field', pointer: 'rogue' });
    expect(errorEnvelopeSchema.parse(JSON.parse(unknown.body)).requestId).toBe('req-1');
  });

  it('refuses a schema-valid lifecycle envelope over its class cap as payload-too-large', async () => {
    const padding = ',"requestId":"req-1"'.repeat(4000);
    const body = `{${listProjectsEnvelope().slice(1, -1)}${padding}}`;
    const draft = await post(body, launcherHeaders(fixture));
    expect(draft.status).toBe(413);
    expect(errorDetails(draft)).toEqual({
      limit: 'lifecycleJsonBytes',
      receivedBytes: Buffer.byteLength(body, 'utf8'),
    });
  });
});

describe('the executor seam', () => {
  it('passes an executor-returned public error through with the request id and session echoed', async () => {
    fixture.setExecutorResult({
      code: 'concurrent-activation',
      message: 'another activation attempt is already in flight',
      retryable: true,
    });
    const draft = await post(activateEnvelope(), launcherHeaders(fixture, {}, 'mutation'));
    expect(draft.status).toBe(409);
    const envelope = errorEnvelopeSchema.parse(JSON.parse(draft.body));
    expect(envelope.error.code).toBe('concurrent-activation');
    expect(envelope.requestId).toBe('req-1');
  });

  it('never leaks a thrown executor error — the closed catch-all is the whole answer', async () => {
    fixture.failExecutor(
      new Error('file /Users/secret/project/astro.config.mjs failed: EACCES pid 1234'),
    );
    const draft = await post(listProjectsEnvelope(), launcherHeaders(fixture));
    expect(draft.status).toBe(500);
    const envelope = errorEnvelopeSchema.parse(JSON.parse(draft.body));
    expect(envelope.error.code).toBe('internal-error');
    expect(envelope.error.message).toBe('the request could not be completed');
    expect(draft.body).not.toContain('astro.config');
    expect(draft.body).not.toContain('EACCES');
    expect(draft.body).not.toContain('pid');
  });

  it('refuses to emit an over-cap response envelope', async () => {
    fixture.setExecutorResult({
      protocolVersion: 1,
      requestId: 'req-1',
      session: { runtimeEpoch: 'epoch-fixture', generation: 1 },
      result: {
        kind: 'inspection',
        result: { kind: 'styles', revision: 1, payload: { blob: 'x'.repeat(34 * 1024 * 1024) } },
      },
    });
    const draft = await post(inspectEnvelope(), projectHeaders(fixture, 'editor'));
    expect(draft.status).toBe(500);
    expect(errorBody(draft).code).toBe('internal-error');
  });
});
