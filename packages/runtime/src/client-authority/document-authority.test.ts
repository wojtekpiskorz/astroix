import type { ProjectKey, SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { describe, expect, it } from 'vitest';
import {
  type ApiDispatchAuthority,
  type ApiRequestEvidence,
  dispatchApiRequest,
} from '../../api/http/api-dispatch.ts';
import { stripControlAuthority } from '../../api/http/authority-strip.ts';
import { type ClientBindings, createClientBindings } from '../../api/http/client-bindings.ts';
import {
  createHostCapabilityGrants,
  type HostCapabilityGrants,
} from '../../api/http/host-capability.ts';
import { reconstructUpgradeHandshake } from '../../proxy/upgrade-request.ts';
import type { SessionClients } from '../../session-supervisor/clients/session-clients.ts';
import { createSessionClients } from '../../session-supervisor/clients/session-clients.ts';
import { admitSseStream } from '../../sse/sse-admission.ts';
import {
  applyEditEnvelope,
  deactivateEnvelope,
  inspectEnvelope,
  KEY_A,
  NEXT_SESSION,
  rawPairs,
  SESSION,
} from '../../test/http-api/fixtures.ts';
import { createDocumentAuthority, type DocumentAuthority } from './document-authority.ts';

/**
 * The document-authority focused lane (#246): every focused test the
 * ticket names, driven against the REAL settled surfaces — F2's HTTP
 * binding table and dispatch core, F4's supervisor-side client registry,
 * F3's SSE admission — with this module as the only new truth. The
 * caps, the four-identity binding, the invalidation matrix, the
 * diagnostic read-only law, the forged-capability refusals, and the
 * A→B→A stale-document guard are all asserted at BOTH truths and, where
 * admission is the question, through the real dispatch (the server-side
 * enforcement, not a re-implemented check).
 */

/** The fixture port the Host/Origin evidence is built against (the http-api lane's pure-core idiom). */
const PORT = 4321;

/** The returning-A generation of the A→B→A cycle — a NEW pair, never gen 1 again. */
const RETURNED_SESSION: SessionRef = { runtimeEpoch: SESSION.runtimeEpoch, generation: 3 };

/** One harness: the two real tables, the real grants, the real dispatch, and the authority over them. */
function harness(): {
  readonly authority: DocumentAuthority;
  readonly httpBindings: ClientBindings;
  readonly clients: SessionClients;
  readonly executed: unknown[];
  rotateProjectCapability(): string;
  projectCapability(): string;
  setState(state: { sessionRef: SessionRef | null; projectKey: ProjectKey | null }): void;
  dispatch(input: {
    readonly body: string;
    readonly client?: string;
    readonly hostCapability?: string;
    readonly mutation?: boolean;
  }): Promise<{ readonly status: number; readonly code: string | null }>;
} {
  const httpBindings = createClientBindings();
  const clients = createSessionClients();
  const grants: HostCapabilityGrants = createHostCapabilityGrants();
  const authority = createDocumentAuthority({ httpBindings, clients });
  let projectCapability = grants.mint({ host: 'project', projectKey: KEY_A });
  let state: { sessionRef: SessionRef | null; projectKey: ProjectKey | null } = {
    sessionRef: SESSION,
    projectKey: KEY_A,
  };
  const executed: unknown[] = [];
  const dispatchAuthority: ApiDispatchAuthority = {
    expectedPort: PORT,
    sessionState: () => state,
    verifyHostCapability: grants.verify,
    resolveClientBinding: httpBindings.resolve,
    executeCommand: async (envelope) => {
      executed.push(envelope);
      return {
        protocolVersion: 1,
        requestId: envelope.requestId,
        session: envelope.session,
        result: {
          kind: 'inspection',
          result: { kind: 'styles', revision: 1, payload: { rules: [] } },
        },
      };
    },
  };
  return {
    authority,
    httpBindings,
    clients,
    executed,
    rotateProjectCapability: () => {
      projectCapability = grants.mint({ host: 'project', projectKey: KEY_A });
      return projectCapability;
    },
    projectCapability: () => projectCapability,
    setState: (next) => {
      state = next;
    },
    dispatch: (input) => {
      const headers: Record<string, string | string[]> = {
        Host: `${KEY_A}.localhost:${PORT}`,
        Cookie: `session-data=1; __astroix_host=${input.hostCapability ?? projectCapability}`,
        'Content-Type': 'application/json',
        ...(input.mutation === true
          ? { Origin: `http://${KEY_A}.localhost:${PORT}`, 'X-Astroix-Request': '1' }
          : { 'Sec-Fetch-Site': 'same-origin' }),
      };
      if (input.client !== undefined) headers['X-Astroix-Client'] = input.client;
      const evidence: ApiRequestEvidence = {
        method: 'POST',
        url: '/__astroix/api/v1/',
        rawHeaders: rawPairs(headers),
        body: input.body,
      };
      // The draft is the wire truth; the error code is the sanitized finding.
      return dispatchApiRequest(evidence, dispatchAuthority).then((draft) => ({
        status: draft.status,
        code: (JSON.parse(draft.body) as { error?: { code?: string } }).error?.code ?? null,
      }));
    },
  };
}

/** Binds the canonical editor: W1 declared authoritative, observed at navigation 1, bound at SESSION. */
function bindEditor(
  world: ReturnType<typeof harness>,
  sessionRef: SessionRef = SESSION,
): { readonly capability: string; readonly clientCapability: string } {
  world.authority.declareAuthoritativeTarget(1);
  world.authority.documentNavigated(1, 1);
  const bound = world.authority.bindEditor({
    document: { webContentsId: 1, navigationId: 1 },
    sessionRef,
    projectKey: KEY_A,
  });
  if (bound.kind !== 'bound') throw new Error(`fixture editor bind failed: ${bound.reason}`);
  return { capability: bound.grant.capability, clientCapability: bound.grant.clientCapability };
}

describe('the document authority — role caps, server-enforced across both truths', () => {
  it('binds exactly one authoritative editor and refuses the second', () => {
    const world = harness();
    const editor = bindEditor(world);
    expect(editor.capability).toMatch(/^[0-9a-f]{64}$/);
    expect(world.httpBindings.resolve(editor.capability)).toEqual({
      role: 'editor',
      host: 'project',
      sessionRef: SESSION,
    });
    expect(world.httpBindings.counts()).toEqual({ editor: 1, diagnostic: 0, launcher: 0 });
    expect(world.clients.counts()).toEqual({ editor: 1, diagnostic: 0 });

    const second = world.authority.bindEditor({
      document: { webContentsId: 1, navigationId: 1 },
      sessionRef: SESSION,
      projectKey: KEY_A,
    });
    expect(second).toEqual({ kind: 'refused', reason: 'editor-already-bound' });
    expect(world.authority.grants()).toHaveLength(1);
    expect(world.httpBindings.counts()).toEqual({ editor: 1, diagnostic: 0, launcher: 0 });
  });

  it('binds at most three diagnostics and refuses the fourth', () => {
    const world = harness();
    bindEditor(world);
    const capabilities: string[] = [];
    for (const webContentsId of [2, 3, 4]) {
      world.authority.documentNavigated(webContentsId, 1);
      const bound = world.authority.bindDiagnostic({
        document: { webContentsId, navigationId: 1 },
        sessionRef: SESSION,
        projectKey: KEY_A,
      });
      expect(bound.kind).toBe('bound');
      if (bound.kind === 'bound') capabilities.push(bound.grant.capability);
    }
    expect(world.httpBindings.counts()).toEqual({ editor: 1, diagnostic: 3, launcher: 0 });
    expect(world.clients.counts()).toEqual({ editor: 1, diagnostic: 3 });

    world.authority.documentNavigated(5, 1);
    const fourth = world.authority.bindDiagnostic({
      document: { webContentsId: 5, navigationId: 1 },
      sessionRef: SESSION,
      projectKey: KEY_A,
    });
    expect(fourth).toEqual({ kind: 'refused', reason: 'diagnostics-full' });
    expect(world.authority.grants()).toHaveLength(4);
    // Every refused bind minted nothing: the capabilities that exist are exactly the granted ones.
    for (const capability of capabilities) {
      expect(world.httpBindings.resolve(capability)).not.toBeNull();
    }
    expect(world.httpBindings.counts()).toEqual({ editor: 1, diagnostic: 3, launcher: 0 });
  });

  it('rolls the HTTP binding back when the supervisor-side table refuses (lockstep coherence)', () => {
    const world = harness();
    world.authority.declareAuthoritativeTarget(1);
    world.authority.documentNavigated(1, 1);
    // A foreign editor binding lives in F4's registry only (a composition
    // holding state this module never drove): the HTTP table would accept
    // a second editor — the registry must refuse, and the mint roll back.
    world.clients.bind({
      role: 'editor',
      document: { webContentsId: 9, navigationId: 9 },
      sessionRef: SESSION,
    });
    const refused = world.authority.bindEditor({
      document: { webContentsId: 1, navigationId: 1 },
      sessionRef: SESSION,
      projectKey: KEY_A,
    });
    expect(refused).toEqual({ kind: 'refused', reason: 'editor-already-bound' });
    expect(world.httpBindings.counts()).toEqual({ editor: 0, diagnostic: 0, launcher: 0 });
    expect(world.authority.grants()).toHaveLength(0);
  });

  it('refuses a second grant at one live document — one document is one client (injection totality)', () => {
    const world = harness();
    bindEditor(world);
    // A diagnostic at the EDITOR's exact document would make the
    // injection port ambiguous; the mint refuses before either table
    // records anything.
    const sameDocument = world.authority.bindDiagnostic({
      document: { webContentsId: 1, navigationId: 1 },
      sessionRef: SESSION,
      projectKey: KEY_A,
    });
    expect(sameDocument).toEqual({ kind: 'refused', reason: 'document-already-bound' });
    expect(world.httpBindings.counts()).toEqual({ editor: 1, diagnostic: 0, launcher: 0 });
    expect(world.clients.counts()).toEqual({ editor: 1, diagnostic: 0 });
    // A different document of the same webContents is not current — the
    // stale-document law holds ahead of the uniqueness law.
    const olderNavigation = world.authority.bindDiagnostic({
      document: { webContentsId: 1, navigationId: 0 },
      sessionRef: SESSION,
      projectKey: KEY_A,
    });
    expect(olderNavigation).toEqual({ kind: 'refused', reason: 'stale-document' });
    // After the editor's death the document may bind again — one LIVE
    // grant per document, never one per lifetime.
    world.authority.revoke(world.authority.grants()[0]?.capability as string);
    const rebound = world.authority.bindDiagnostic({
      document: { webContentsId: 1, navigationId: 1 },
      sessionRef: SESSION,
      projectKey: KEY_A,
    });
    expect(rebound.kind).toBe('bound');
    expect(world.authority.injectableCapability(1)).toEqual(
      rebound.kind === 'bound' ? rebound.grant.capability : null,
    );
  });
});

describe('the authoritative binding identities', () => {
  it('carries webContents identity, top-level navigation identity, role, and the exact SessionRef', () => {
    const world = harness();
    const editor = bindEditor(world, NEXT_SESSION);
    const grants = world.authority.grants();
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      role: 'editor',
      document: { webContentsId: 1, navigationId: 1 },
      sessionRef: NEXT_SESSION,
      projectKey: KEY_A,
    });
    // The supervisor-side truth authorizes the same document at the same pair.
    expect(
      world.clients.authorize({
        capability: editor.clientCapability,
        document: { webContentsId: 1, navigationId: 1 },
        sessionRef: NEXT_SESSION,
        role: 'editor',
      }),
    ).toEqual({ kind: 'authorized', role: 'editor' });
    // The HTTP truth resolves the injected value to the same role and pair.
    expect(world.httpBindings.resolve(editor.capability)?.role).toBe('editor');
    expect(world.httpBindings.resolve(editor.capability)?.sessionRef).toEqual(NEXT_SESSION);
    // The two capabilities are separately minted values (the two-truth shape).
    expect(editor.clientCapability).not.toEqual(editor.capability);
  });

  it('serves the current document’s capability to the injection port and nothing else', () => {
    const world = harness();
    const editor = bindEditor(world);
    expect(world.authority.injectableCapability(1)).toBe(editor.capability);
    expect(world.authority.injectableCapability(2)).toBeNull();
    world.authority.documentNavigated(1, 2);
    expect(world.authority.injectableCapability(1)).toBeNull();
  });
});

describe('binding invalidation — every cause dies in BOTH tables before further control work', () => {
  type Cause = (
    world: ReturnType<typeof harness>,
    editor: { capability: string; clientCapability: string },
  ) => void;

  const causes: readonly {
    readonly name: string;
    readonly cause: Cause;
    readonly navigationResumed?: boolean;
  }[] = [
    {
      name: 'a new top-level navigation of the same webContents',
      cause: (world) => {
        world.authority.documentNavigated(1, 2);
      },
    },
    {
      name: 'renderer loss',
      cause: (world) => {
        world.authority.rendererLost(1);
      },
    },
    {
      name: 'target destruction',
      cause: (world) => {
        world.authority.targetDestroyed(1);
      },
    },
    {
      name: 'session replacement',
      cause: (world) => {
        world.authority.sessionReplaced(SESSION);
      },
    },
    {
      name: 'authority revocation',
      cause: (world, editor) => {
        world.authority.revoke(editor.capability);
      },
    },
  ];

  for (const { name, cause } of causes) {
    it(`invalidates the binding on ${name}`, async () => {
      const world = harness();
      const editor = bindEditor(world);
      // Live before: both truths hold the binding.
      expect(world.httpBindings.resolve(editor.capability)).not.toBeNull();

      cause(world, editor);

      // Dead after — synchronously, in both tables and the join.
      expect(world.httpBindings.resolve(editor.capability)).toBeNull();
      expect(world.authority.injectableCapability(1)).toBeNull();
      expect(world.authority.grants()).toHaveLength(0);
      expect(
        world.clients.authorize({
          capability: editor.clientCapability,
          document: { webContentsId: 1, navigationId: 1 },
          sessionRef: SESSION,
        }),
      ).toEqual({ kind: 'rejected', reason: 'no-binding' });

      // And BEFORE further control work: the very next request presenting
      // the dead capability is refused by the real dispatch.
      const refused = await world.dispatch({
        body: inspectEnvelope(SESSION),
        client: editor.capability,
      });
      expect(refused.status).toBe(403);
      expect(refused.code).toBe('unauthorized');
      expect(world.executed).toHaveLength(0);
    });
  }

  it('clears the authoritative target declaration when the target is destroyed', () => {
    const world = harness();
    bindEditor(world);
    world.authority.targetDestroyed(1);
    world.authority.documentNavigated(1, 5);
    const refused = world.authority.bindEditor({
      document: { webContentsId: 1, navigationId: 5 },
      sessionRef: SESSION,
      projectKey: KEY_A,
    });
    expect(refused).toEqual({ kind: 'refused', reason: 'not-authoritative-target' });
    world.authority.declareAuthoritativeTarget(1);
    const rebound = world.authority.bindEditor({
      document: { webContentsId: 1, navigationId: 5 },
      sessionRef: SESSION,
      projectKey: KEY_A,
    });
    expect(rebound.kind).toBe('bound');
  });

  it('treats a reordered older navigation report as the stale one (monotonic identity)', () => {
    const world = harness();
    world.authority.declareAuthoritativeTarget(1);
    world.authority.documentNavigated(1, 5);
    world.authority.documentNavigated(1, 3);
    const stale = world.authority.bindEditor({
      document: { webContentsId: 1, navigationId: 3 },
      sessionRef: SESSION,
      projectKey: KEY_A,
    });
    expect(stale).toEqual({ kind: 'refused', reason: 'stale-document' });
    const current = world.authority.bindEditor({
      document: { webContentsId: 1, navigationId: 5 },
      sessionRef: SESSION,
      projectKey: KEY_A,
    });
    expect(current.kind).toBe('bound');
  });

  it('revokes an unknown capability without touching live grants (idempotent)', () => {
    const world = harness();
    const editor = bindEditor(world);
    world.authority.revoke('0'.repeat(64));
    expect(world.authority.grants()).toHaveLength(1);
    expect(world.httpBindings.resolve(editor.capability)).not.toBeNull();
  });
});

describe('diagnostics — inspection and events only, every write denied', () => {
  function bindDiagnostic(world: ReturnType<typeof harness>): string {
    world.authority.documentNavigated(2, 1);
    const bound = world.authority.bindDiagnostic({
      document: { webContentsId: 2, navigationId: 1 },
      sessionRef: SESSION,
      projectKey: KEY_A,
    });
    if (bound.kind !== 'bound') throw new Error(`fixture diagnostic bind failed: ${bound.reason}`);
    return bound.grant.capability;
  }

  it('admits a diagnostic read and denies every mutation through the real dispatch', async () => {
    const world = harness();
    bindEditor(world);
    const diagnostic = bindDiagnostic(world);

    const inspect = await world.dispatch({ body: inspectEnvelope(SESSION), client: diagnostic });
    expect(inspect.status).toBe(200);
    expect(world.executed).toHaveLength(1);

    const edit = await world.dispatch({
      body: applyEditEnvelope(SESSION),
      client: diagnostic,
      mutation: true,
    });
    expect(edit.status).toBe(403);
    expect(edit.code).toBe('unauthorized');

    const deactivate = await world.dispatch({
      body: deactivateEnvelope(SESSION),
      client: diagnostic,
      mutation: true,
    });
    expect(deactivate.status).toBe(403);
    expect(deactivate.code).toBe('unauthorized');
    expect(world.executed).toHaveLength(1);
  });

  it('admits a diagnostic events stream and refuses a forged capability', () => {
    const world = harness();
    bindEditor(world);
    const diagnostic = bindDiagnostic(world);
    const admitted = admitSseStream(
      {
        method: 'GET',
        url: `/__astroix/events?runtimeEpoch=${SESSION.runtimeEpoch}&generation=${SESSION.generation}`,
        rawHeaders: rawPairs({
          Host: `${KEY_A}.localhost:${PORT}`,
          Cookie: `__astroix_host=${world.projectCapability()}`,
          'X-Astroix-Client': diagnostic,
          Origin: `http://${KEY_A}.localhost:${PORT}`,
          'Sec-Fetch-Site': 'same-origin',
        }),
      },
      {
        expectedPort: PORT,
        sessionState: () => ({ sessionRef: SESSION, projectKey: KEY_A }),
        verifyHostCapability: (presented, host) =>
          presented === world.projectCapability() && host.host === 'project',
        resolveClientBinding: world.httpBindings.resolve,
      },
    );
    expect(admitted).toMatchObject({ kind: 'admitted', role: 'diagnostic' });

    const forged = admitSseStream(
      {
        method: 'GET',
        url: `/__astroix/events?runtimeEpoch=${SESSION.runtimeEpoch}&generation=${SESSION.generation}`,
        rawHeaders: rawPairs({
          Host: `${KEY_A}.localhost:${PORT}`,
          Cookie: `__astroix_host=${world.projectCapability()}`,
          'X-Astroix-Client': 'f'.repeat(64),
          Origin: `http://${KEY_A}.localhost:${PORT}`,
          'Sec-Fetch-Site': 'same-origin',
        }),
      },
      {
        expectedPort: PORT,
        sessionState: () => ({ sessionRef: SESSION, projectKey: KEY_A }),
        verifyHostCapability: (presented, host) =>
          presented === world.projectCapability() && host.host === 'project',
        resolveClientBinding: world.httpBindings.resolve,
      },
    );
    expect(forged.kind).toBe('refused');
    if (forged.kind === 'refused') {
      expect(forged.response.status).toBe(403);
    }
  });

  it('denies a diagnostic write even under a freshly rotated host cookie (no upgrade path)', async () => {
    const world = harness();
    bindEditor(world);
    const diagnostic = bindDiagnostic(world);
    const rotated = world.rotateProjectCapability();

    const edit = await world.dispatch({
      body: applyEditEnvelope(SESSION),
      client: diagnostic,
      mutation: true,
      hostCapability: rotated,
    });
    expect(edit.status).toBe(403);
    expect(edit.code).toBe('unauthorized');
  });
});

describe('the A→B→A race — the old A document never acquires or reuses the returning generation', () => {
  it('refuses the stale document, the stale tab, and the dead capability at every layer', async () => {
    const world = harness();
    const first = bindEditor(world, SESSION);

    // A→B: the commit retires generation 1; the window navigates through B.
    world.setState({ sessionRef: NEXT_SESSION, projectKey: KEY_A });
    world.authority.sessionReplaced(SESSION);
    world.authority.documentNavigated(1, 2);

    // B→A: the returning A is generation 3 — a NEW pair — and a NEW document.
    world.setState({ sessionRef: RETURNED_SESSION, projectKey: KEY_A });
    world.authority.documentNavigated(1, 3);

    // The old A document (navigation 1) cannot ACQUIRE the returning
    // generation's editor authority — even before the new editor binds
    // (the race window): its navigation is stale.
    const staleDocument = world.authority.bindEditor({
      document: { webContentsId: 1, navigationId: 1 },
      sessionRef: RETURNED_SESSION,
      projectKey: KEY_A,
    });
    expect(staleDocument).toEqual({ kind: 'refused', reason: 'stale-document' });

    // A stale tab in another webContents is current in its own navigation
    // but was never declared the authoritative target.
    world.authority.documentNavigated(7, 1);
    const staleTab = world.authority.bindEditor({
      document: { webContentsId: 7, navigationId: 1 },
      sessionRef: RETURNED_SESSION,
      projectKey: KEY_A,
    });
    expect(staleTab).toEqual({ kind: 'refused', reason: 'not-authoritative-target' });

    // The old A capability cannot REUSE the returning generation: it
    // resolves to nothing (dead at the A→B commit), so even a correct
    // host cookie and the fresh pair are refused.
    const reused = await world.dispatch({
      body: inspectEnvelope(RETURNED_SESSION),
      client: first.capability,
    });
    expect(reused.status).toBe(403);
    expect(reused.code).toBe('unauthorized');

    // The returning generation's authority is minted for the NEW document alone.
    const returned = world.authority.bindEditor({
      document: { webContentsId: 1, navigationId: 3 },
      sessionRef: RETURNED_SESSION,
      projectKey: KEY_A,
    });
    expect(returned.kind).toBe('bound');
    if (returned.kind === 'bound') {
      expect(world.authority.injectableCapability(1)).toBe(returned.grant.capability);
      const admitted = await world.dispatch({
        body: inspectEnvelope(RETURNED_SESSION),
        client: returned.grant.capability,
      });
      expect(admitted.status).toBe(200);
    }
  });

  it('rejects the old A document under a newly rotated host cookie too', async () => {
    const world = harness();
    const first = bindEditor(world, SESSION);
    world.authority.sessionReplaced(SESSION);
    world.authority.documentNavigated(1, 2);
    world.setState({ sessionRef: RETURNED_SESSION, projectKey: KEY_A });
    world.authority.documentNavigated(1, 3);
    const rotated = world.rotateProjectCapability();

    const staleEdit = await world.dispatch({
      body: applyEditEnvelope(RETURNED_SESSION),
      client: first.capability,
      mutation: true,
      hostCapability: rotated,
    });
    expect(staleEdit.status).toBe(403);
    expect(staleEdit.code).toBe('unauthorized');
    expect(world.executed).toHaveLength(0);
  });
});

describe('forged capabilities — unknown values never act', () => {
  it('refuses a forged client capability with an otherwise valid request', async () => {
    const world = harness();
    bindEditor(world);
    const forged = await world.dispatch({
      body: inspectEnvelope(SESSION),
      client: 'e'.repeat(64),
    });
    expect(forged.status).toBe(403);
    expect(forged.code).toBe('unauthorized');
    expect(world.executed).toHaveLength(0);
  });

  it('refuses a request carrying no client capability at all', async () => {
    const world = harness();
    bindEditor(world);
    const absent = await world.dispatch({ body: inspectEnvelope(SESSION) });
    expect(absent.status).toBe(403);
    expect(absent.code).toBe('unauthorized');
  });

  it('refuses a valid client capability under a stale host cookie (the rotated-cookie leg)', async () => {
    const world = harness();
    const editor = bindEditor(world);
    const retiredCookie = world.projectCapability();
    world.rotateProjectCapability();
    const staleCookie = await world.dispatch({
      body: inspectEnvelope(SESSION),
      client: editor.capability,
      hostCapability: retiredCookie,
    });
    expect(staleCookie.status).toBe(403);
    expect(staleCookie.code).toBe('unauthorized');
    expect(world.executed).toHaveLength(0);
  });
});

describe('the two-truth separation — only the HTTP capability ever crosses toward the wire', () => {
  it('serves the HTTP capability to the injection port, never the supervisor-side value', () => {
    const world = harness();
    const editor = bindEditor(world);
    expect(world.authority.injectableCapability(1)).toBe(editor.capability);
    expect(world.authority.injectableCapability(1)).not.toBe(editor.clientCapability);
    // Neither value resolves in the OTHER truth: the supervisor-side
    // capability is no HTTP header value, and the HTTP value authorizes
    // nothing in the supervisor registry — a leak of one table never
    // mints authority in the other.
    expect(world.httpBindings.resolve(editor.clientCapability)).toBeNull();
    expect(
      world.clients.authorize({
        capability: editor.capability,
        document: { webContentsId: 1, navigationId: 1 },
        sessionRef: SESSION,
        role: 'editor',
      }),
    ).toEqual({ kind: 'rejected', reason: 'no-binding' });
  });
});

describe('the upstream strip — the injected authority never forwards (HTTP and HMR views)', () => {
  /**
   * The two header views the proxy legs forward (F1's composition):
   * node:http's parsed lowercased record for the stream proxy, and the
   * raw-cased pair view the HMR handshake reconstruction preserves.
   * F2's one strip definition (`stripControlAuthority`) must clean BOTH;
   * the live wiring of the strip into the proxy paths is the open
   * prerequisite this lane reports (its owned paths are F1's).
   */
  function rawPairRecord(rawHeaders: readonly string[]): Record<string, string> {
    const record: Record<string, string> = {};
    for (let i = 0; i < rawHeaders.length; i += 2) {
      record[rawHeaders[i] as string] = rawHeaders[i + 1] as string;
    }
    return record;
  }

  it('strips the injected client capability and the host cookie from the stream proxy parsed view', () => {
    const world = harness();
    const editor = bindEditor(world);
    const hostCookie = world.projectCapability();
    // node:http's parsed view: lowercased names, the cookie header as one
    // string — exactly what `proxyHttpStream` forwards today.
    const parsed: Record<string, string | string[] | undefined> = {
      host: `${KEY_A}.localhost:4321`,
      'x-astroix-client': editor.capability,
      cookie: `__astroix_host=${hostCookie}; theme=dark`,
      accept: '*/*',
    };
    const forwarded = stripControlAuthority(parsed);
    expect(forwarded['x-astroix-client']).toBeUndefined();
    expect(String(forwarded.cookie)).not.toContain(hostCookie);
    expect(forwarded.cookie).toBe('theme=dark');
    // The capability bytes never survive anywhere in the forwarded view.
    expect(JSON.stringify(forwarded)).not.toContain(editor.capability);
    // Everything else rides verbatim.
    expect(forwarded.host).toBe(`${KEY_A}.localhost:4321`);
    expect(forwarded.accept).toBe('*/*');
  });

  it('strips the authority from the raw HMR handshake view, preserving the Vite contract bytes', () => {
    const world = harness();
    const editor = bindEditor(world);
    const hostCookie = world.projectCapability();
    // The renderer-cased handshake pairs the tunnel reconstructs: a
    // capitalized client header, the cookie, and Vite's own HMR shape.
    const rawHeaders = rawPairs({
      Host: `${KEY_A}.localhost:4321`,
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Protocol': 'vite-hmr',
      'Sec-WebSocket-Key': 'dGhlIHNtb2tlIHRlc3Qga2V5',
      'Sec-WebSocket-Version': '13',
      Origin: `http://${KEY_A}.localhost:4321`,
      'X-Astroix-Client': editor.capability,
      Cookie: `__astroix_host=${hostCookie}`,
    });
    // Precondition the strip exists to handle: the reconstructed handshake
    // carries the client header byte-for-byte (mixed case preserved).
    const unstripped = reconstructUpgradeHandshake({
      method: 'GET',
      url: '/@vite/client?token=hmr-token-value',
      httpVersion: '1.1',
      rawHeaders,
    });
    expect(unstripped).toContain(`X-Astroix-Client: ${editor.capability}`);
    // The stripped pair view reconstructs to bytes with no authority name
    // in any casing and no capability or cookie byte, while the URL token,
    // Host, subprotocol, and key survive exactly.
    const stripped = stripControlAuthority(rawPairRecord(rawHeaders));
    const strippedPairs: string[] = [];
    for (const [name, value] of Object.entries(stripped)) {
      const values = value === undefined ? [] : Array.isArray(value) ? value : [value];
      for (const item of values) strippedPairs.push(name, item);
    }
    const forwardedHandshake = reconstructUpgradeHandshake({
      method: 'GET',
      url: '/@vite/client?token=hmr-token-value',
      httpVersion: '1.1',
      rawHeaders: strippedPairs,
    });
    expect(forwardedHandshake).not.toContain(editor.capability);
    expect(forwardedHandshake).not.toContain(hostCookie);
    for (const authorityName of ['astroix-client', 'ASTROIX-CLIENT', '__astroix_host']) {
      expect(forwardedHandshake.toLowerCase()).not.toContain(authorityName.toLowerCase());
    }
    expect(forwardedHandshake).toContain('GET /@vite/client?token=hmr-token-value HTTP/1.1');
    expect(forwardedHandshake).toContain(`Host: ${KEY_A}.localhost:4321`);
    expect(forwardedHandshake).toContain('Sec-WebSocket-Protocol: vite-hmr');
    expect(forwardedHandshake).toContain('Sec-WebSocket-Key: dGhlIHNtb2tlIHRlc3Qga2V5');
  });
});
