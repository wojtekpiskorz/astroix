import type {
  PublicError,
  RequestEnvelope,
  ResponseEnvelope,
  SessionRef,
} from '@wojciechpiskorz/astroix-protocol';
import {
  type ApiDispatchAuthority,
  type ClientBindings,
  createClientBindings,
  createHostCapabilityGrants,
  type HostCapabilityGrants,
} from '../../api/http/reserved-handler.ts';

/**
 * Deterministic fixtures for the F2 focused lane (#234): one authority
 * bundle (real grants table, real binding table, recording executor),
 * envelope builders for every command kind, and raw-header assembly —
 * so every admission matrix leg runs against the REAL pure modules,
 * never re-implemented fakes. The real-socket legs
 * (`reserved-handler.test.ts`) compose the same authority behind F1's
 * actual origin listener.
 */

/** A valid routing key (26 lowercase Base32 chars, the protocol's shape). */
export const KEY_A = 'abcdefghijklmnopqrstuvwxyz';

export const SESSION: SessionRef = { runtimeEpoch: 'epoch-fixture', generation: 1 };
export const NEXT_SESSION: SessionRef = { runtimeEpoch: 'epoch-fixture', generation: 2 };
export const OTHER_EPOCH: SessionRef = { runtimeEpoch: 'epoch-other', generation: 1 };

/** The one authority bundle every matrix leg starts from. */
export interface AuthorityFixture {
  /** The listener port the Host/Origin evidence is built against (4321 for pure-core legs; the real port for socket legs). */
  readonly port: number;
  readonly authority: ApiDispatchAuthority;
  readonly grants: HostCapabilityGrants;
  readonly bindings: ClientBindings;
  readonly launcherCapability: string;
  readonly projectCapability: string;
  readonly launcherClient: string;
  readonly editorClient: string;
  readonly diagnosticClient: string;
  /** Every admitted envelope, in order — the executor-recorder seam. */
  readonly executed: RequestEnvelope[];
  /** What the executor answers next: a response envelope (default) or a public error. */
  setExecutorResult(result: ResponseEnvelope | PublicError): void;
  /** Moves the session-state view the dispatch validates freshness against. */
  setState(state: { sessionRef: SessionRef | null; projectKey: string | null }): void;
  failExecutor(error: Error): void;
}

export function createAuthorityFixture(
  options: { readonly expectedPort?: number } = {},
): AuthorityFixture {
  const port = options.expectedPort ?? 4321;
  const grants = createHostCapabilityGrants();
  const bindings = createClientBindings();
  const launcherCapability = grants.mint({ host: 'launcher' });
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
  let result: ResponseEnvelope | PublicError | Error = {
    protocolVersion: 1,
    requestId: 'unused',
    result: { kind: 'project-list', projects: [] },
  };
  let state: { sessionRef: SessionRef | null; projectKey: string | null } = {
    sessionRef: SESSION,
    projectKey: KEY_A,
  };
  return {
    port,
    grants,
    bindings,
    launcherCapability,
    projectCapability,
    launcherClient: launcher.capability,
    editorClient: editor.capability,
    diagnosticClient: diagnostic.capability,
    executed,
    authority: {
      expectedPort: port,
      sessionState: () => state,
      verifyHostCapability: grants.verify,
      resolveClientBinding: bindings.resolve,
      executeCommand: async (envelope) => {
        executed.push(envelope);
        if (result instanceof Error) throw result;
        return result;
      },
    },
    setExecutorResult: (next) => {
      result = next;
    },
    setState: (next) => {
      state = next;
    },
    failExecutor: (error) => {
      result = error;
    },
  };
}

// ——— envelope builders ———

export function listProjectsEnvelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    protocolVersion: 1,
    requestId: 'req-1',
    command: { kind: 'list-projects' },
    ...overrides,
  });
}

export function activateEnvelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    protocolVersion: 1,
    requestId: 'req-1',
    command: { kind: 'activate', projectKey: KEY_A },
    ...overrides,
  });
}

export function deactivateEnvelope(session: SessionRef = SESSION): string {
  return JSON.stringify({
    protocolVersion: 1,
    requestId: 'req-1',
    session,
    command: { kind: 'deactivate' },
  });
}

export function inspectEnvelope(session: SessionRef = SESSION): string {
  return JSON.stringify({
    protocolVersion: 1,
    requestId: 'req-1',
    session,
    command: { kind: 'inspect', request: { kind: 'styles' } },
  });
}

export function applyEditEnvelope(session: SessionRef = SESSION): string {
  return JSON.stringify({
    protocolVersion: 1,
    requestId: 'req-1',
    session,
    command: {
      kind: 'apply-edit',
      plan: {
        operation: 'replace-contents',
        grant: {
          token: 'opaque-grant-token',
          kind: 'css',
          operations: ['replace-contents'],
          displayPath: 'src/styles/main.css',
          baseline: { type: 'sha256', sha256: 'a'.repeat(64) },
        },
        contents: 'body { color: red; }',
      },
    },
  });
}

// ——— executor result envelopes ———

export function projectListResult(requestId = 'req-1'): ResponseEnvelope {
  return {
    protocolVersion: 1,
    requestId,
    result: {
      kind: 'project-list',
      projects: [{ projectKey: KEY_A, displayName: 'Fixture project', availability: 'available' }],
    },
  };
}

export function inspectionResult(
  session: SessionRef = SESSION,
  requestId = 'req-1',
): ResponseEnvelope {
  return {
    protocolVersion: 1,
    requestId,
    session,
    result: { kind: 'inspection', result: { kind: 'styles', revision: 1, payload: { rules: [] } } },
  };
}

export function editResult(session: SessionRef = SESSION, requestId = 'req-1'): ResponseEnvelope {
  return {
    protocolVersion: 1,
    requestId,
    session,
    result: { kind: 'edit', result: { revision: 2 } },
  };
}

// ——— raw request assembly ———

/** One request's headers as the dispatch evidence wants them: raw name/value pairs, in order. */
export function rawPairs(headers: Record<string, string | true | string[]>): string[] {
  const pairs: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (value === true) {
      pairs.push(name, '');
    } else if (Array.isArray(value)) {
      for (const item of value) pairs.push(name, item);
    } else {
      pairs.push(name, value);
    }
  }
  return pairs;
}

/** The launcher-host header set for a mutation (`origin` + marker) or a read (`sec-fetch-site`). */
export function launcherHeaders(
  fixture: AuthorityFixture,
  extras: Record<string, string | true | string[]> = {},
  kind: 'mutation' | 'read' = 'read',
): string[] {
  const base: Record<string, string | string[]> = {
    Host: `launcher.localhost:${fixture.port}`,
    Cookie: `__astroix_host=${fixture.launcherCapability}`,
    'X-Astroix-Client': fixture.launcherClient,
    'Content-Type': 'application/json',
    ...(kind === 'mutation'
      ? { Origin: `http://launcher.localhost:${fixture.port}`, 'X-Astroix-Request': '1' }
      : { 'Sec-Fetch-Site': 'same-origin' }),
  };
  return rawPairs({ ...base, ...extras });
}

/** The project-host header set for a mutation or a read, in the given client role. */
export function projectHeaders(
  fixture: AuthorityFixture,
  role: 'editor' | 'diagnostic',
  extras: Record<string, string | true | string[]> = {},
  kind: 'mutation' | 'read' = 'read',
): string[] {
  const base: Record<string, string | string[]> = {
    Host: `${KEY_A}.localhost:${fixture.port}`,
    Cookie: `__astroix_host=${fixture.projectCapability}`,
    'X-Astroix-Client': role === 'editor' ? fixture.editorClient : fixture.diagnosticClient,
    'Content-Type': 'application/json',
    ...(kind === 'mutation'
      ? { Origin: `http://${KEY_A}.localhost:${fixture.port}`, 'X-Astroix-Request': '1' }
      : { 'Sec-Fetch-Site': 'same-origin' }),
  };
  return rawPairs({ ...base, ...extras });
}

/** Assembles one raw HTTP/1.1 POST from raw header pairs — the socket legs' wire truth. */
export function rawPost(
  target: string,
  rawHeaders: readonly string[],
  body: string,
  method = 'POST',
): string {
  const lines = [`${method} ${target} HTTP/1.1`];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    lines.push(`${rawHeaders[i]}: ${rawHeaders[i + 1]}`);
  }
  lines.push(`Content-Length: ${Buffer.byteLength(body, 'utf8')}`, 'Connection: close', '', body);
  return lines.join('\r\n');
}
