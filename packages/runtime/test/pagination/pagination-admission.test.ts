import type {
  PublicError,
  RequestEnvelope,
  ResponseEnvelope,
  SessionRef,
} from '@wojciechpiskorz/astroix-protocol';
import { describe, expect, it } from 'vitest';
import {
  type ApiDispatchAuthority,
  createClientBindings,
  createHostCapabilityGrants,
  dispatchApiRequest,
  responseWithinCap,
  type SessionStateView,
} from '../../api/http/reserved-handler.ts';
import { pagedInspection } from '../../api/pagination/paged-envelopes.ts';

/**
 * The F3 pagination-behind-admission focused legs (#235, AC: "pagination
 * does not bypass authorization or freshness checks"): the REAL F2
 * dispatch core (imported read-only) composed with a paginated
 * inspection executor — proving the page assembly sits strictly AFTER
 * the admission matrix. An unauthorized or stale request never reaches
 * the executor, so it never paginates and never answers data; the
 * authorized diagnostic's response is the bounded page, within the
 * transport's own response-cap gate.
 */

/** A valid routing key (26 lowercase Base32 chars, the protocol's shape). */
const KEY_A = 'abcdefghijklmnopqrstuvwxyz';
const SESSION: SessionRef = { runtimeEpoch: 'epoch-fixture', generation: 1 };
const NEXT_SESSION: SessionRef = { runtimeEpoch: 'epoch-fixture', generation: 2 };

/** The inspection items the executor pages over — a contract-shaped rules list. */
const RULES = Array.from({ length: 40 }, (_unused, index) => `rule-${index} { color: red; }`);

/** The authority bundle: real grants and bindings, an executor that answers paged inspections. */
function createDispatchFixture(): {
  readonly authority: ApiDispatchAuthority;
  readonly projectCapability: string;
  readonly executed: RequestEnvelope[];
  setState(state: { sessionRef: SessionRef | null; projectKey: string | null }): void;
} {
  const grants = createHostCapabilityGrants();
  const bindings = createClientBindings();
  const projectCapability = grants.mint({ host: 'project', projectKey: KEY_A });
  const editor = bindings.bind({
    role: 'editor',
    host: 'project',
    sessionRef: SESSION,
    capability: 'client-editor',
  });
  const diagnostic = bindings.bind({
    role: 'diagnostic',
    host: 'project',
    sessionRef: SESSION,
    capability: 'client-diagnostic',
  });
  const launcher = bindings.bind({
    role: 'launcher',
    host: 'launcher',
    sessionRef: null,
    capability: 'client-launcher',
  });
  if (editor.kind !== 'bound' || diagnostic.kind !== 'bound' || launcher.kind !== 'bound') {
    throw new Error('fixture bindings failed to install');
  }
  const executed: RequestEnvelope[] = [];
  let state: SessionStateView = { sessionRef: SESSION, projectKey: KEY_A };
  return {
    authority: {
      expectedPort: 4321,
      sessionState: () => state,
      verifyHostCapability: grants.verify,
      resolveClientBinding: bindings.resolve,
      executeCommand: async (envelope): Promise<ResponseEnvelope | PublicError> => {
        executed.push(envelope);
        if (envelope.command.kind !== 'inspect' || envelope.session === undefined) {
          return {
            protocolVersion: 1,
            requestId: envelope.requestId,
            result: { kind: 'project-list', projects: [] },
          };
        }
        const page = pagedInspection({
          requestId: envelope.requestId,
          session: envelope.session,
          inspectionKind: envelope.command.request.kind,
          revision: 5,
          items: RULES,
          payloadFor: (rules) => ({ rules }),
          requestedPageSize: 12,
        });
        if (page.kind === 'refused') {
          throw new Error('the fixture pagination refused a small rules list');
        }
        return page.envelope;
      },
    },
    projectCapability,
    executed,
    setState: (next) => {
      state = next;
    },
  };
}

/** One inspect request's evidence on the project host; `wrongCookie` breaks only the host capability. */
function inspectEvidence(input: {
  readonly projectCapability: string;
  readonly session: SessionRef;
  readonly clientCapability: string;
  readonly wrongCookie?: boolean;
}): { method: string; url: string; rawHeaders: string[]; body: string } {
  return {
    method: 'POST',
    url: '/__astroix/api/v1/',
    rawHeaders: [
      'Host',
      `${KEY_A}.localhost:4321`,
      'Cookie',
      `__astroix_host=${input.wrongCookie === true ? 'not-the-capability' : input.projectCapability}`,
      'X-Astroix-Client',
      input.clientCapability,
      'Sec-Fetch-Site',
      'same-origin',
      'Content-Type',
      'application/json',
    ],
    body: JSON.stringify({
      protocolVersion: 1,
      requestId: 'req-1',
      session: input.session,
      command: { kind: 'inspect', request: { kind: 'styles' } },
    }),
  };
}

describe('the authorized diagnostics pagination (a session-bound read)', () => {
  it('admits the diagnostic role and answers the bounded page', async () => {
    const fixture = createDispatchFixture();
    const draft = await dispatchApiRequest(
      inspectEvidence({
        projectCapability: fixture.projectCapability,
        session: SESSION,
        clientCapability: 'client-diagnostic',
      }),
      fixture.authority,
    );
    expect(draft.status).toBe(200);
    const envelope = JSON.parse(draft.body);
    expect(envelope.result.kind).toBe('inspection');
    expect(envelope.session).toEqual(SESSION);
    expect(envelope.result.result.payload.rules).toHaveLength(12);
    expect(responseWithinCap(draft.body)).toBe(true);
    expect(fixture.executed).toHaveLength(1);
  });

  it('admits the editor role for the same bounded read', async () => {
    const fixture = createDispatchFixture();
    const draft = await dispatchApiRequest(
      inspectEvidence({
        projectCapability: fixture.projectCapability,
        session: SESSION,
        clientCapability: 'client-editor',
      }),
      fixture.authority,
    );
    expect(draft.status).toBe(200);
    expect(JSON.parse(draft.body).result.result.payload.rules).toHaveLength(12);
  });
});

describe('pagination never bypasses authorization or freshness', () => {
  it('never paginates for a wrong host capability — the executor is unreached', async () => {
    const fixture = createDispatchFixture();
    const draft = await dispatchApiRequest(
      inspectEvidence({
        projectCapability: fixture.projectCapability,
        session: SESSION,
        clientCapability: 'client-diagnostic',
        wrongCookie: true,
      }),
      fixture.authority,
    );
    expect(draft.status).toBe(403);
    expect(fixture.executed).toHaveLength(0);
  });

  it('never paginates for a role the inspection command forbids (the launcher document)', async () => {
    const fixture = createDispatchFixture();
    const draft = await dispatchApiRequest(
      inspectEvidence({
        projectCapability: fixture.projectCapability,
        session: SESSION,
        clientCapability: 'client-launcher',
      }),
      fixture.authority,
    );
    expect(draft.status).toBe(403);
    expect(fixture.executed).toHaveLength(0);
  });

  it('never paginates a stale SessionRef — freshness is checked before the executor', async () => {
    const fixture = createDispatchFixture();
    const draft = await dispatchApiRequest(
      inspectEvidence({
        projectCapability: fixture.projectCapability,
        session: NEXT_SESSION,
        clientCapability: 'client-diagnostic',
      }),
      fixture.authority,
    );
    expect(draft.status).toBe(409);
    expect(fixture.executed).toHaveLength(0);
  });

  it("never paginates when the session moved — the stale tab's binding never covers new traffic", async () => {
    const fixture = createDispatchFixture();
    fixture.setState({ sessionRef: NEXT_SESSION, projectKey: KEY_A });
    const draft = await dispatchApiRequest(
      inspectEvidence({
        projectCapability: fixture.projectCapability,
        session: NEXT_SESSION,
        clientCapability: 'client-diagnostic',
      }),
      fixture.authority,
    );
    expect(draft.status).toBe(403);
    expect(fixture.executed).toHaveLength(0);
  });
});
