import { connect, type Socket } from 'node:net';
import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import {
  type ClientBindings,
  createClientBindings,
  createHostCapabilityGrants,
  type HostCapabilityGrants,
} from '../../api/http/reserved-handler.ts';
import type { SseAuthority } from '../../sse/sse-admission.ts';

/**
 * Deterministic fixtures for the F3 SSE focused lane (#235): one
 * authority bundle (the REAL grants and binding tables — the same
 * machinery F2's lane composes, imported read-only), plus the raw-socket
 * stream client the real-socket legs collect open streams with. The
 * pure legs run admission and the hub directly; the socket legs compose
 * the same authority behind F1's actual origin listener.
 */

/** A valid routing key (26 lowercase Base32 chars, the protocol's shape). */
export const KEY_A = 'abcdefghijklmnopqrstuvwxyz';

export const SESSION: SessionRef = { runtimeEpoch: 'epoch-fixture', generation: 1 };
export const NEXT_SESSION: SessionRef = { runtimeEpoch: 'epoch-fixture', generation: 2 };
export const OTHER_EPOCH: SessionRef = { runtimeEpoch: 'epoch-other', generation: 1 };

/** The one authority bundle every SSE admission leg starts from. */
export interface SseAuthorityFixture {
  /** The listener port the Host/Origin evidence is built against (4321 for pure-core legs; the real port for socket legs). */
  readonly port: number;
  readonly authority: SseAuthority;
  readonly grants: HostCapabilityGrants;
  readonly bindings: ClientBindings;
  readonly launcherCapability: string;
  readonly projectCapability: string;
  readonly launcherClient: string;
  readonly editorClient: string;
  readonly diagnosticClients: readonly string[];
  /** Moves the session-state view admission validates freshness against. */
  setState(state: { sessionRef: SessionRef | null; projectKey: string | null }): void;
}

export function createSseAuthorityFixture(
  options: { readonly expectedPort?: number } = {},
): SseAuthorityFixture {
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
  const diagnosticClients: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const bound = bindings.bind({
      role: 'diagnostic',
      host: 'project',
      sessionRef: SESSION,
      capability: `client-diagnostic-${index}`,
    });
    if (bound.kind !== 'bound') throw new Error('fixture diagnostic binding failed to install');
    diagnosticClients.push(bound.capability);
  }
  const launcher = bindings.bind({
    role: 'launcher',
    host: 'launcher',
    sessionRef: null,
    capability: 'client-launcher',
  });
  if (editor.kind !== 'bound' || launcher.kind !== 'bound') {
    throw new Error('fixture bindings failed to install');
  }
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
    diagnosticClients,
    authority: {
      expectedPort: port,
      sessionState: () => state,
      verifyHostCapability: grants.verify,
      resolveClientBinding: bindings.resolve,
    },
    setState: (next) => {
      state = next;
    },
  };
}

// ——— raw request assembly ———

/** One request's headers as the admission evidence wants them: raw name/value pairs, in order. */
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

/** The events query carrying the exact pair — the freshness pair an `EventSource` cannot put anywhere else. */
export function eventsQuery(session: SessionRef): string {
  return `?runtimeEpoch=${encodeURIComponent(session.runtimeEpoch)}&generation=${session.generation}`;
}

/**
 * The header pairs with every pair of `name` removed — the absent-header
 * shape a raw socket must be able to present (the extras mechanism can
 * only replace or add, never remove). The absent-`Origin` shape is the
 * real-browser one (#330): `Origin` is a forbidden header on a
 * same-origin GET, so Chromium sends none.
 */
export function withoutHeader(headers: readonly string[], name: string): string[] {
  const target = name.toLowerCase();
  const filtered: string[] = [];
  for (let i = 0; i < headers.length; i += 2) {
    const current = (headers[i] ?? '').toLowerCase();
    if (current === target) continue;
    filtered.push(headers[i] ?? '', headers[i + 1] ?? '');
  }
  return filtered;
}

/**
 * The launcher-host header set for an events stream: same-origin Fetch
 * Metadata always; the exact `Origin` is the present-and-exact shape a
 * raw socket can carry (a real browser sends none on a same-origin GET,
 * #330 — use {@link withoutHeader} to present that shape).
 */
export function launcherStreamHeaders(
  fixture: SseAuthorityFixture,
  extras: Record<string, string | true | string[]> = {},
): string[] {
  const base: Record<string, string | string[]> = {
    Host: `launcher.localhost:${fixture.port}`,
    Cookie: `__astroix_host=${fixture.launcherCapability}`,
    'X-Astroix-Client': fixture.launcherClient,
    Origin: `http://launcher.localhost:${fixture.port}`,
    'Sec-Fetch-Site': 'same-origin',
  };
  return rawPairs({ ...base, ...extras });
}

/**
 * The project-host header set for an events stream, in the given client
 * role; the exact `Origin` is the present-and-exact shape (see
 * {@link launcherStreamHeaders} for the absent-`Origin` real-browser
 * shape, #330).
 */
export function projectStreamHeaders(
  fixture: SseAuthorityFixture,
  role: 'editor' | 'diagnostic',
  extras: Record<string, string | true | string[]> = {},
): string[] {
  const base: Record<string, string | string[]> = {
    Host: `${KEY_A}.localhost:${fixture.port}`,
    Cookie: `__astroix_host=${fixture.projectCapability}`,
    'X-Astroix-Client':
      role === 'editor' ? fixture.editorClient : (fixture.diagnosticClients[0] as string),
    Origin: `http://${KEY_A}.localhost:${fixture.port}`,
    'Sec-Fetch-Site': 'same-origin',
  };
  return rawPairs({ ...base, ...extras });
}

/** Assembles one raw HTTP/1.1 GET for the events endpoint — the socket legs' wire truth. */
export function rawSseGet(target: string, rawHeaders: readonly string[]): string {
  const lines = [`GET ${target} HTTP/1.1`];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    lines.push(`${rawHeaders[i]}: ${rawHeaders[i + 1]}`);
  }
  lines.push('Connection: keep-alive', '', '');
  return lines.join('\r\n');
}

/** One open SSE connection as the socket legs drive it: head, collected frames, and the observed close. */
export interface SseConnection {
  readonly status: number;
  readonly headers: string;
  /** Every byte received after the head — frames accumulate here as they were written. */
  readonly frames: readonly string[];
  readonly closed: Promise<void>;
  readonly socket: Socket;
  end(): void;
}

/**
 * Incremental HTTP chunked-transfer decoder: Node frames an open SSE
 * body (no `Content-Length`, keep-alive) in chunks, so the collected
 * post-head bytes carry `<hex-size>\r\n<data>\r\n` framing the frame
 * assertions must see through. Deterministic; tolerates splits at any
 * byte boundary. The terminal `0` chunk is the server's `end()` — on a
 * keep-alive connection there is no FIN behind it, so it is the
 * stream-end signal the connection reports as `closed`.
 */
function createDechunker(): { push(chunk: string): string[]; isDone(): boolean } {
  let buffer = '';
  let done = false;
  const decoded: string[] = [];
  return {
    push(chunk: string): string[] {
      buffer += chunk;
      for (;;) {
        const lineEnd = buffer.indexOf('\r\n');
        if (lineEnd === -1) break;
        const sizeText = buffer.slice(0, lineEnd);
        if (!/^[0-9a-fA-F]+$/.test(sizeText)) break; // not a size line (yet)
        const size = Number.parseInt(sizeText, 16);
        if (buffer.length < lineEnd + 2 + size + 2) break; // wait for the whole chunk
        const data = buffer.slice(lineEnd + 2, lineEnd + 2 + size);
        buffer = buffer.slice(lineEnd + 2 + size + 2);
        if (size > 0) decoded.push(data);
        if (size === 0) done = true; // the terminal chunk
        if (done) break;
      }
      return decoded.splice(0);
    },
    isDone(): boolean {
      return done;
    },
  };
}

/**
 * Opens one events connection on a loopback port and collects the
 * stream: resolves the head as soon as it arrives, keeps collecting
 * dechunked frame bytes, and settles `closed` when the server ends or
 * severs the exchange (bounded — a stream that never closes cannot
 * hang a leg; a keep-alive FIN counts, via the socket's `end`).
 */
export function openSse(port: number, request: string, timeoutMs = 5000): Promise<SseConnection> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.write(request);
    });
    const chunks: Buffer[] = [];
    const frames: string[] = [];
    const dechunker = createDechunker();
    let settled: SseConnection | null = null;
    let closedResolve: (() => void) | null = null;
    const closed = new Promise<void>((resolveClose) => {
      closedResolve = resolveClose;
    });
    const finish = (): void => {
      clearTimeout(timer);
      closedResolve?.();
    };
    const timer = setTimeout(() => {
      socket.destroy();
    }, timeoutMs);
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      if (settled === null) {
        const text = Buffer.concat(chunks).toString('latin1');
        const split = text.indexOf('\r\n\r\n');
        if (split === -1) return;
        const statusMatch = /^HTTP\/1\.1 (\d{3})/.exec(text);
        for (const decoded of dechunker.push(text.slice(split + 4))) frames.push(decoded);
        settled = {
          status: statusMatch === null ? 0 : Number.parseInt(statusMatch[1] ?? '0', 10),
          headers: text.slice(0, split),
          frames,
          closed,
          socket,
          end: () => {
            clearTimeout(timer);
            socket.end();
          },
        };
        resolve(settled);
        if (dechunker.isDone()) finish();
        return;
      }
      for (const decoded of dechunker.push(chunk.toString('latin1'))) frames.push(decoded);
      if (dechunker.isDone()) finish();
    });
    socket.on('error', (error) => {
      if (settled === null) {
        clearTimeout(timer);
        reject(error);
      } else {
        finish();
      }
    });
    socket.on('close', finish);
    socket.on('end', finish);
  });
}

/** Resolves when `probe` turns true — the bounded polling helper (never a sleep-race). */
export async function waitFor(probe: () => boolean, timeoutMs = 3000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (probe()) return;
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor: condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
