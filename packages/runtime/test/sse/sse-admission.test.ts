import { EVENTS_PATH, errorEnvelopeSchema } from '@wojciechpiskorz/astroix-protocol';
import { describe, expect, it } from 'vitest';
import { admitSseStream, type SseAdmission } from '../../sse/sse-admission.ts';
import {
  createSseAuthorityFixture,
  eventsQuery,
  KEY_A,
  launcherStreamHeaders,
  NEXT_SESSION,
  OTHER_EPOCH,
  projectStreamHeaders,
  SESSION,
  type SseAuthorityFixture,
} from './fixtures.ts';

/**
 * The F3 SSE admission focused legs (#235): the pure core's every
 * refusal and admission, over the REAL grants and binding tables (F2's
 * machinery, imported read-only). The admission order is the ADR's —
 * route, method, duplicate headers, Host, capability, Origin, Fetch
 * Metadata, query shape, binding + role, then the SessionRef freshness
 * pair — and each leg pins one law of ADR-0006 §7's SSE sentence:
 * "SSE requires exact `Host`, `Origin`, host capability, client
 * binding, and `SessionRef`."
 */

function admit(
  fixture: SseAuthorityFixture,
  target: string,
  rawHeaders: readonly string[],
  method = 'GET',
): SseAdmission {
  return admitSseStream({ method, url: target, rawHeaders }, fixture.authority);
}

/** The refusal draft — throws when the leg unexpectedly admitted. */
function refusalOf(admission: SseAdmission): {
  status: number;
  headers: Record<string, string>;
  body: string;
} {
  if (admission.kind !== 'refused') throw new Error('expected a refusal');
  return admission.response;
}

function errorCode(admission: SseAdmission): string {
  return (
    errorEnvelopeSchema.parse(JSON.parse(refusalOf(admission).body)) as { error: { code: string } }
  ).error.code;
}

describe('the admitted admissions', () => {
  it('admits the authoritative editor at the exact current pair', () => {
    const fixture = createSseAuthorityFixture();
    const admission = admit(
      fixture,
      `${EVENTS_PATH}${eventsQuery(SESSION)}`,
      projectStreamHeaders(fixture, 'editor'),
    );
    expect(admission).toMatchObject({
      kind: 'admitted',
      role: 'editor',
      hostClass: 'project',
      session: SESSION,
      clientCapability: 'client-editor',
    });
  });

  it('admits a diagnostic at the exact current pair', () => {
    const fixture = createSseAuthorityFixture();
    const admission = admit(
      fixture,
      `${EVENTS_PATH}${eventsQuery(SESSION)}`,
      projectStreamHeaders(fixture, 'diagnostic'),
    );
    expect(admission).toMatchObject({ kind: 'admitted', role: 'diagnostic', session: SESSION });
  });

  it('admits the launcher stream without a pair — the idle-registry consumer', () => {
    const fixture = createSseAuthorityFixture();
    const admission = admit(fixture, EVENTS_PATH, launcherStreamHeaders(fixture));
    expect(admission).toMatchObject({
      kind: 'admitted',
      role: 'launcher',
      hostClass: 'launcher',
      session: null,
    });
  });
});

describe('route, method, and target laws', () => {
  it('answers a non-GET method on the events endpoint as an unknown route', () => {
    const fixture = createSseAuthorityFixture();
    for (const method of ['POST', 'OPTIONS', 'HEAD']) {
      const admission = admit(fixture, EVENTS_PATH, launcherStreamHeaders(fixture), method);
      expect(admission.kind, method).toBe('refused');
      expect(errorCode(admission), method).toBe('resource-not-found');
    }
  });

  it('answers a non-events reserved path as an unknown route', () => {
    const fixture = createSseAuthorityFixture();
    const admission = admit(fixture, '/__astroix/events/extra', launcherStreamHeaders(fixture));
    expect(errorCode(admission)).toBe('resource-not-found');
  });

  it('fails closed on an ambiguous reserved-boundary encoding', () => {
    const fixture = createSseAuthorityFixture();
    const admission = admit(fixture, '/__astroix%5Cevents', launcherStreamHeaders(fixture));
    expect(errorCode(admission)).toBe('malformed-request');
    expect(JSON.parse(refusalOf(admission).body).error.details).toEqual({
      issue: 'ambiguous-encoding',
    });
  });

  it('answers a duplicate security-relevant header as malformed', () => {
    const fixture = createSseAuthorityFixture();
    const base = launcherStreamHeaders(fixture);
    const admission = admit(fixture, EVENTS_PATH, [
      ...base,
      'Origin',
      'http://a',
      'Origin',
      'http://b',
    ]);
    expect(errorCode(admission)).toBe('malformed-request');
  });
});

describe('the Host law (exact Host, ADR-0006 §7)', () => {
  it('refuses a missing Host, a duplicate Host, and a wrong-port Host', () => {
    const fixture = createSseAuthorityFixture();
    const missing = admit(fixture, EVENTS_PATH, []);
    expect(errorCode(missing)).toBe('resource-not-found');
    // A duplicated security-relevant NAME is malformed outright — the
    // duplicate-header law precedes the Host parse (F2's admission order).
    const duplicated = admit(fixture, EVENTS_PATH, [
      ...launcherStreamHeaders(fixture),
      'Host',
      `launcher.localhost:${fixture.port}`,
    ]);
    expect(errorCode(duplicated)).toBe('malformed-request');
    const wrongPort = admit(
      fixture,
      EVENTS_PATH,
      launcherStreamHeaders(fixture, { Host: `launcher.localhost:${fixture.port + 1}` }),
    );
    expect(errorCode(wrongPort)).toBe('resource-not-found');
  });

  it('refuses an unknown virtual host and a trailing-dot host', () => {
    const fixture = createSseAuthorityFixture();
    const unknown = admit(
      fixture,
      EVENTS_PATH,
      launcherStreamHeaders(fixture, { Host: 'evil.example' }),
    );
    expect(errorCode(unknown)).toBe('resource-not-found');
    const trailing = admit(
      fixture,
      EVENTS_PATH,
      launcherStreamHeaders(fixture, { Host: `launcher.localhost.:${fixture.port}` }),
    );
    expect(errorCode(trailing)).toBe('resource-not-found');
  });
});

describe('the host capability law', () => {
  it('refuses a missing, a wrong, and a revoked capability', () => {
    const fixture = createSseAuthorityFixture();
    const missing = admit(fixture, EVENTS_PATH, launcherStreamHeaders(fixture, { Cookie: true }));
    expect(errorCode(missing)).toBe('unauthorized');
    const wrong = admit(
      fixture,
      EVENTS_PATH,
      launcherStreamHeaders(fixture, { Cookie: '__astroix_host=deadbeef' }),
    );
    expect(errorCode(wrong)).toBe('unauthorized');
    fixture.grants.revoke({ host: 'launcher' });
    const revoked = admit(fixture, EVENTS_PATH, launcherStreamHeaders(fixture));
    expect(errorCode(revoked)).toBe('unauthorized');
  });

  it('refuses a project capability presented on the launcher host — capabilities never cross hosts', () => {
    const fixture = createSseAuthorityFixture();
    const crossing = admit(
      fixture,
      EVENTS_PATH,
      launcherStreamHeaders(fixture, { Cookie: `__astroix_host=${fixture.projectCapability}` }),
    );
    expect(errorCode(crossing)).toBe('unauthorized');
  });
});

describe('the SSE-strict transport laws (exact Origin, Fetch Metadata, no mutation marker)', () => {
  it('refuses a MISSING Origin — stricter than a read, whose Origin is checked only when present', () => {
    const fixture = createSseAuthorityFixture();
    const admission = admit(fixture, EVENTS_PATH, launcherStreamHeaders(fixture, { Origin: true }));
    expect(errorCode(admission)).toBe('unauthorized');
  });

  it('refuses a wrong Origin, case-insensitively matched against the exact expected one', () => {
    const fixture = createSseAuthorityFixture();
    const foreign = admit(
      fixture,
      EVENTS_PATH,
      launcherStreamHeaders(fixture, { Origin: 'http://evil.example' }),
    );
    expect(errorCode(foreign)).toBe('unauthorized');
    const otherProject = admit(
      fixture,
      `${EVENTS_PATH}${eventsQuery(SESSION)}`,
      projectStreamHeaders(fixture, 'editor', {
        Origin: `http://${KEY_A}.localhost:${fixture.port + 1}`,
      }),
    );
    expect(errorCode(otherProject)).toBe('unauthorized');
  });

  it('refuses missing or cross-site Fetch Metadata', () => {
    const fixture = createSseAuthorityFixture();
    const missing = admit(
      fixture,
      EVENTS_PATH,
      launcherStreamHeaders(fixture, { 'Sec-Fetch-Site': true }),
    );
    expect(errorCode(missing)).toBe('unauthorized');
    const cross = admit(
      fixture,
      EVENTS_PATH,
      launcherStreamHeaders(fixture, { 'Sec-Fetch-Site': 'cross-site' }),
    );
    expect(errorCode(cross)).toBe('unauthorized');
  });

  it('refuses the mutation marker on a stream request as contradictory evidence', () => {
    const fixture = createSseAuthorityFixture();
    const admission = admit(
      fixture,
      EVENTS_PATH,
      launcherStreamHeaders(fixture, { 'X-Astroix-Request': '1' }),
    );
    expect(errorCode(admission)).toBe('malformed-request');
  });
});

describe('the query session-pair law (EventSource carries the pair in the URL)', () => {
  it('refuses an unknown key, a duplicate key, a lone half, and a non-schema pair', () => {
    const fixture = createSseAuthorityFixture();
    const legs: Array<[string, string]> = [
      [
        'unknown key',
        `${EVENTS_PATH}?runtimeEpoch=${SESSION.runtimeEpoch}&generation=${SESSION.generation}&extra=1`,
      ],
      [
        'duplicate key',
        `${EVENTS_PATH}?runtimeEpoch=a&runtimeEpoch=b&generation=${SESSION.generation}`,
      ],
      ['lone half', `${EVENTS_PATH}?runtimeEpoch=${SESSION.runtimeEpoch}`],
      ['non-schema pair', `${EVENTS_PATH}?runtimeEpoch=x&generation=zero`],
      ['undecodable value', `${EVENTS_PATH}?runtimeEpoch=%FF&generation=1`],
    ];
    for (const [name, target] of legs) {
      const admission = admit(fixture, target, projectStreamHeaders(fixture, 'editor'));
      expect(admission.kind, name).toBe('refused');
      expect(errorCode(admission), name).toBe('malformed-request');
    }
  });

  it('refuses a launcher stream that claims a session pair — the idle-registry rule', () => {
    const fixture = createSseAuthorityFixture();
    const admission = admit(
      fixture,
      `${EVENTS_PATH}${eventsQuery(SESSION)}`,
      launcherStreamHeaders(fixture),
    );
    expect(errorCode(admission)).toBe('malformed-request');
  });
});

describe('the binding and role laws', () => {
  it('refuses a missing, unknown, or cross-host client capability', () => {
    const fixture = createSseAuthorityFixture();
    const missing = admit(
      fixture,
      `${EVENTS_PATH}${eventsQuery(SESSION)}`,
      projectStreamHeaders(fixture, 'editor', { 'X-Astroix-Client': true }),
    );
    expect(errorCode(missing)).toBe('unauthorized');
    const unknown = admit(
      fixture,
      `${EVENTS_PATH}${eventsQuery(SESSION)}`,
      projectStreamHeaders(fixture, 'editor', { 'X-Astroix-Client': 'client-nobody' }),
    );
    expect(errorCode(unknown)).toBe('unauthorized');
    const crossHost = admit(
      fixture,
      `${EVENTS_PATH}${eventsQuery(SESSION)}`,
      projectStreamHeaders(fixture, 'editor', { 'X-Astroix-Client': fixture.launcherClient }),
    );
    expect(errorCode(crossHost)).toBe('unauthorized');
  });

  it('refuses the launcher role on the project host and the editor role on the launcher host', () => {
    const fixture = createSseAuthorityFixture();
    const launcherOnProject = admit(
      fixture,
      `${EVENTS_PATH}${eventsQuery(SESSION)}`,
      projectStreamHeaders(fixture, 'editor', { 'X-Astroix-Client': fixture.launcherClient }),
    );
    expect(errorCode(launcherOnProject)).toBe('unauthorized');
    const editorOnLauncher = admit(
      fixture,
      EVENTS_PATH,
      launcherStreamHeaders(fixture, { 'X-Astroix-Client': fixture.editorClient }),
    );
    expect(errorCode(editorOnLauncher)).toBe('unauthorized');
  });

  it('refuses a revoked binding — unbinding is revocation', () => {
    const fixture = createSseAuthorityFixture();
    fixture.bindings.unbind('client-editor');
    const admission = admit(
      fixture,
      `${EVENTS_PATH}${eventsQuery(SESSION)}`,
      projectStreamHeaders(fixture, 'editor'),
    );
    expect(errorCode(admission)).toBe('unauthorized');
  });
});

describe('the SessionRef freshness law (SSE is stricter: the CURRENT pair)', () => {
  it('refuses a session-bound stream with no pair as stale', () => {
    const fixture = createSseAuthorityFixture();
    const admission = admit(fixture, EVENTS_PATH, projectStreamHeaders(fixture, 'editor'));
    expect(errorCode(admission)).toBe('stale-session');
  });

  it('refuses a stale pair with 409 and echoes the presented pair', () => {
    const fixture = createSseAuthorityFixture();
    const admission = admit(
      fixture,
      `${EVENTS_PATH}${eventsQuery(NEXT_SESSION)}`,
      projectStreamHeaders(fixture, 'editor'),
    );
    expect(refusalOf(admission).status).toBe(409);
    const envelope = errorEnvelopeSchema.parse(JSON.parse(refusalOf(admission).body));
    expect(envelope.error.code).toBe('stale-session');
    expect(envelope.session).toEqual(NEXT_SESSION);
  });

  it('refuses a foreign epoch as stale', () => {
    const fixture = createSseAuthorityFixture();
    const admission = admit(
      fixture,
      `${EVENTS_PATH}${eventsQuery(OTHER_EPOCH)}`,
      projectStreamHeaders(fixture, 'editor'),
    );
    expect(errorCode(admission)).toBe('stale-session');
  });

  it('refuses a current pair presented through a binding minted at another pair — a stale tab never upgrades', () => {
    const fixture = createSseAuthorityFixture();
    fixture.setState({ sessionRef: NEXT_SESSION, projectKey: KEY_A });
    // the editor binding is still minted at SESSION (generation 1):
    // the CURRENT pair is 2, the request carries 2, the binding is 1.
    const admission = admit(
      fixture,
      `${EVENTS_PATH}${eventsQuery(NEXT_SESSION)}`,
      projectStreamHeaders(fixture, 'editor'),
    );
    expect(errorCode(admission)).toBe('unauthorized');
  });

  it('refuses a pair while no session is current', () => {
    const fixture = createSseAuthorityFixture();
    fixture.setState({ sessionRef: null, projectKey: KEY_A });
    const admission = admit(
      fixture,
      `${EVENTS_PATH}${eventsQuery(SESSION)}`,
      projectStreamHeaders(fixture, 'editor'),
    );
    expect(errorCode(admission)).toBe('stale-session');
  });
});

describe('output hygiene of the refusals', () => {
  it('never carries a capability byte, a client capability, or a header value in any refusal body', () => {
    const fixture = createSseAuthorityFixture();
    const legs = [
      admit(fixture, EVENTS_PATH, launcherStreamHeaders(fixture, { Cookie: true })),
      admit(fixture, EVENTS_PATH, launcherStreamHeaders(fixture, { Origin: true })),
      admit(
        fixture,
        `${EVENTS_PATH}${eventsQuery(NEXT_SESSION)}`,
        projectStreamHeaders(fixture, 'editor'),
      ),
    ];
    for (const admission of legs) {
      const body = refusalOf(admission).body;
      expect(body).not.toContain(fixture.launcherCapability);
      expect(body).not.toContain(fixture.projectCapability);
      expect(body).not.toContain(fixture.editorClient);
      expect(body).not.toContain(fixture.diagnosticClients[0]);
    }
  });

  it('answers every refusal with no-store and the generated marker — and zero CORS', () => {
    const fixture = createSseAuthorityFixture();
    const admission = admit(fixture, EVENTS_PATH, launcherStreamHeaders(fixture, { Origin: true }));
    const headers = refusalOf(admission).headers;
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['x-astroix-generated']).toBe('1');
    expect(Object.keys(headers).some((name) => name.includes('access-control'))).toBe(false);
  });
});
