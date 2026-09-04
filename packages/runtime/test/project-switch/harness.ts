import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type {
  InspectionRequest,
  ProjectKey,
  RequestEnvelope,
  ResponseEnvelope,
  SessionRef,
  SessionSnapshot,
  WritePlan,
} from '@wojciechpiskorz/astroix-protocol';
import { projectHostname } from '@wojciechpiskorz/astroix-runtime/origin';
import {
  type ControlPlaneComposition,
  createControlPlaneComposition,
} from '../../../../apps/web/src/control-plane.ts';
import { stagedFixtureCopy } from '../../../../apps/web/src/stage-e2e.ts';

// The K1 A-B-A switch harness — the runtime tier. No vitest docblock: the
// TEST files that import this module declare `@vitest-environment node`
// (real children, real sockets — no DOM).

/**
 * The SHARED deterministic A-B-A switching harness (#254, K1): one real
 * control-plane composition — the apps/web composition (#240's ruling:
 * the composition host) — over TWO disposable staged copies of the
 * canonical fixture (the stagedFixtureCopy discipline), driven EXACTLY
 * the way the real client drives it: raw-socket HTTP through the real
 * origin listener's admission, real SSE streams, real raw vite-hmr
 * upgrade tunnels, real managed `astro dev` children, real forked write
 * executors. No stand-ins, no re-derivations of the composition wiring
 * — the proof target is the product composition itself.
 *
 * Its home is a test-helpers module under the ticket's owned path
 * (`packages/runtime/test/project-switch/`), NEVER product code: the
 * harness imports the apps/web composition because that is where the
 * landed composition lives, not because the runtime package depends on
 * the app (the import direction is test-helper → composition host, the
 * same direction `apps/web/src/executor.test.ts` already uses).
 *
 * ── THE STABLE K-FAMILY API (#254's AC; K2 and K3 import THIS, they
 * never re-derive the sequence) ─────────────────────────────────────
 *
 * - `createSwitchHarness()` — boots the composition over isolated
 *   disposable projects; one per test file, closed in `afterAll`.
 * - `harness.activate(project)` / `harness.deactivate()` — the
 *   deterministic switch sequence through the REAL wire (launcher
 *   document → activate envelope → committed project document). K2
 *   drives this same sequence to prove client reset safety; K3 layers
 *   pending writes and diagnostic roles over it.
 * - `harness.projectDocument()` — the CURRENT project document's exact
 *   authority set (host capability cookie, client capability, pair).
 * - `harness.inspect()` / `harness.applyEdit()` / `harness.post()` —
 *   admitted wire exchanges with the exact header evidence the
 *   admission spine demands, for stale-authority replays.
 * - `harness.openEvents()` / `harness.openHmr()` — live SSE and HMR
 *   probes with settled `closed` promises (the stale-stream laws).
 * - `harness.openDelayedMutation()` — a mutation whose body completes
 *   only when the caller finishes it (precommit work delayed across
 *   the transition boundary — the fault tier's primitive).
 * - `harness.tree()` / `harness.subtreePids()` — the wrong-project and
 *   process-convergence oracles (bytes and real pids, never internals).
 *
 * Everything else here is private mechanics. Sibling K lanes extend by
 * ADDING harness members through their own tickets — never by editing
 * the product composition this module drives.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
/** The composition host's raw-Node register (the worker child's dev-checkout execArgv seam). */
const RAW_NODE_REGISTER = join(
  HERE,
  '..',
  '..',
  '..',
  '..',
  'apps',
  'web',
  'raw-node-register.mjs',
);
/** The minimal built-client stand-in the document surface serves (the injected bootstrap metas are the real ones). */
const CLIENT_DIST = join(HERE, 'fixtures', 'client-dist');

/** The activation budget — a real plane boot (worker + dev server) under CI load, load-shaped like the web lane's. */
export const ACTIVATION_BUDGET_MS = 300_000;
/** The settle budget — post-transition child-exit convergence (the graceful stop's tail, load-shaped for the full parallel suite). */
export const SETTLE_BUDGET_MS = 90_000;
/** One raw exchange's default bound — every wire helper is bounded, never hanging a leg. */
export const WIRE_BUDGET_MS = 30_000;

/** One staged, disposable project — distinct key, distinct resources, distinct observable content. */
export interface SwitchProject {
  readonly name: 'A' | 'B';
  readonly root: string;
  readonly key: ProjectKey;
  readonly hostname: string;
  readonly origin: string;
  /** The CSS vertical's write target (the fixture's staged sheet). */
  readonly cssPath: string;
  /** The Content vertical's write target (the fixture's blog entry). */
  readonly contentPath: string;
}

/** One project document's complete authority set — what a real client holds after a committed activation. */
export interface SwitchDocument {
  readonly project: SwitchProject;
  readonly origin: string;
  readonly hostCapability: string;
  readonly clientCapability: string;
  readonly session: SessionRef;
}

/** One raw wire exchange's honest accounting. */
export interface WireResponse {
  readonly status: number;
  readonly body: string;
}

/** A live long-lived probe (an SSE stream or an HMR tunnel) — status, frames, and the settled close. */
export interface LiveProbe {
  /** The head's status — 200 for an admitted stream, 101 for a completed upgrade. */
  readonly status: Promise<number>;
  /** Settles when the socket closes — the revocation's own observable. */
  readonly closed: Promise<void>;
  /** The `data:` frame payloads seen so far (SSE only; empty for a raw tunnel). */
  frames(): string[];
  destroy(): void;
}

/** A mutation whose body has not completed yet — `finish()` lands it, `destroy()` abandons it. */
export interface DelayedMutation {
  finish(): Promise<WireResponse>;
  destroy(): void;
}

/** The booted harness — the K-family's stable surface. */
export interface SwitchHarness {
  readonly port: number;
  readonly projectA: SwitchProject;
  readonly projectB: SwitchProject;
  readonly scratchRoot: string;
  /** The supervisor's own truth — the snapshot the activation envelopes carry. */
  snapshot(): SessionSnapshot;
  /** The deterministic switch: launcher document → activate → the committed project document. */
  activate(project: SwitchProject): Promise<{
    readonly document: SwitchDocument;
    readonly envelope: ResponseEnvelope;
  }>;
  /** The deterministic exit: deactivate through the live project document's authority. */
  deactivate(): Promise<WireResponse>;
  /** The current project document — GET the served app page, parse the real bootstrap metas. */
  projectDocument(): Promise<SwitchDocument>;
  /** One POST `/__astroix/api/v1` with the exact evidence the command's shape demands. */
  post(envelope: RequestEnvelope, credentials: WireCredentials): Promise<WireResponse>;
  /** One admitted inspect (a read) — the grant enrichment included when the payload carries it. */
  inspect(request: InspectionRequest, document: SwitchDocument): Promise<WireResponse>;
  /** One admitted apply-edit (a mutation) — the write lane's wire shape. */
  applyEdit(plan: WritePlan, document: SwitchDocument): Promise<WireResponse>;
  /** Opens the live session events stream on the project host (the editor binding's stream). */
  openEvents(document: SwitchDocument): Promise<LiveProbe>;
  /** Opens the live raw vite-hmr tunnel through the origin lease to the real dev server. */
  openHmr(document: SwitchDocument): Promise<LiveProbe>;
  /** One GET through the origin lease to the project's own dev server (proxied, never reserved). */
  fetchProxied(document: SwitchDocument, path: string): Promise<WireResponse>;
  /** A mutation whose body completes only when the caller finishes it — the fault tier's primitive. */
  openDelayedMutation(
    envelope: RequestEnvelope,
    document: SwitchDocument,
    splitAt: number,
  ): DelayedMutation;
  /** The bytes oracle: every source file's SHA-256 under a staged root (caches excluded). */
  tree(root: string): Promise<ReadonlyMap<string, string>>;
  /** The process oracle: this process's live subtree, by pid (real children — planes, executors). */
  subtreePids(): Promise<ReadonlyMap<number, string>>;
  close(): Promise<void>;
}

/** The credentials a wire exchange rides: whose cookie, whose client, on what host. */
export interface WireCredentials {
  readonly cookie: string;
  readonly client: string;
  readonly project?: SwitchProject;
}

/** Boots the harness: stages A and B, composes the real control plane, registers both roots. */
export async function createSwitchHarness(): Promise<SwitchHarness> {
  const scratchRoot = await mkdtemp(join(tmpdir(), 'astroix-aba-'));
  const rootA = await stagedFixtureCopy(scratchRoot, 'project-a');
  const rootB = await stagedFixtureCopy(scratchRoot, 'project-b');
  await markProjectA(rootA);
  await markProjectB(rootB);
  const composition: ControlPlaneComposition = await createControlPlaneComposition({
    registryDirectory: join(scratchRoot, 'registry'),
    port: 0,
    clientDist: CLIENT_DIST,
    registerRoots: [rootA, rootB],
    workerExecArgv: ['--import', RAW_NODE_REGISTER],
  });
  const port = composition.port;
  const [keyA, keyB] = await keysOf(composition, rootA, rootB);
  const projectA = projectOf('A', rootA, keyA, port);
  const projectB = projectOf('B', rootB, keyB, port);
  let seq = 0;
  const nextRequestId = (): string => `k1-${String(++seq)}`;
  const currentDocument = async (): Promise<SwitchDocument> =>
    await projectDocumentOf(port, projectA, projectB, composition);
  return {
    port,
    projectA,
    projectB,
    scratchRoot,
    snapshot: () => composition.supervisor.snapshot(),
    activate: async (project) => await activate(port, project, composition, nextRequestId),
    deactivate: async () => {
      const document = await currentDocument();
      return await postEnvelope(
        port,
        {
          protocolVersion: 1,
          requestId: nextRequestId(),
          session: document.session,
          command: { kind: 'deactivate' },
        },
        credentialsOf(document),
        nextRequestId,
        true,
      );
    },
    projectDocument: currentDocument,
    post: async (envelope, credentials) =>
      await postEnvelope(port, envelope, credentials, nextRequestId, mutationOf(envelope)),
    inspect: async (request, document) =>
      await postEnvelope(
        port,
        {
          protocolVersion: 1,
          requestId: nextRequestId(),
          session: document.session,
          command: { kind: 'inspect', request },
        },
        credentialsOf(document),
        nextRequestId,
        false,
      ),
    applyEdit: async (plan, document) =>
      await postEnvelope(
        port,
        {
          protocolVersion: 1,
          requestId: nextRequestId(),
          session: document.session,
          command: { kind: 'apply-edit', plan },
        },
        credentialsOf(document),
        nextRequestId,
        true,
      ),
    openEvents: async (document) => await openEvents(port, document),
    openHmr: async (document) => await openHmr(port, document),
    fetchProxied: async (document, path) => await fetchProxied(port, document, path),
    openDelayedMutation: (envelope, document, splitAt) =>
      openDelayedMutation(port, envelope, document, nextRequestId, splitAt),
    tree: async (root) => await treeOf(root),
    subtreePids: async () => await subtreePids(),
    close: async () => {
      await composition.close();
      await rm(scratchRoot, { recursive: true, force: true });
    },
  };
}

// ——— the deterministic switch sequence ———

/** The full activation, wire-driven exactly as the real client drives it. */
async function activate(
  port: number,
  project: SwitchProject,
  composition: ControlPlaneComposition,
  nextRequestId: () => string,
): Promise<{ readonly document: SwitchDocument; readonly envelope: ResponseEnvelope }> {
  // The commit oracle's baseline: the generation BEFORE the attempt —
  // every admitted attempt reserves a fresh one, so a committed
  // activation ALWAYS strictly bumps it.
  const generationBefore = composition.supervisor.snapshot().active?.ref.generation ?? 0;
  const launcher = await launcherDocument(port);
  const response = await postEnvelope(
    port,
    {
      protocolVersion: 1,
      requestId: nextRequestId(),
      command: { kind: 'activate', projectKey: project.key },
    },
    { cookie: launcher.cookie, client: launcher.client },
    nextRequestId,
    true,
  );
  if (response.status !== 200) {
    throw new Error(
      `activation of project ${project.name} failed (${response.status}): ${response.body}`,
    );
  }
  // A 200 activation envelope is NOT proof of a committed transition:
  // a failed attempt (ADR-0006 §4's `failed` label) also answers 200
  // with the sanitized failure on its snapshot — and, today, the
  // composition's deactivation never informs the supervisor's revoke
  // seam (#331's landed clear is un-wired composition-side, #411), so a
  // STALE crash failure can ride an otherwise-committed activation's
  // envelope. The supervisor's own active truth is therefore the
  // oracle: the exact project, ready, at a strictly newer generation.
  const active = composition.supervisor.snapshot().active;
  if (
    active === undefined ||
    active.projectKey !== project.key ||
    active.state !== 'ready' ||
    active.ref.generation <= generationBefore
  ) {
    throw new Error(
      `activation of project ${project.name} did not commit ` +
        `(active: ${JSON.stringify(composition.supervisor.snapshot())})`,
    );
  }
  const document = await documentOf(port, project, active.ref);
  return { document, envelope: JSON.parse(response.body) as ResponseEnvelope };
}

// ——— document surfaces ———

/** The launcher document's authority set — cookie from Set-Cookie, client from the bootstrap meta. */
export async function launcherDocument(port: number): Promise<{
  readonly cookie: string;
  readonly client: string;
}> {
  const response = await rawExchange(port, launcherGet(port));
  const cookie = /__astroix_host=([^;]+)/.exec(response.headers)?.[1];
  const client = /name="astroix-client" content="([^"]+)"/.exec(response.body)?.[1];
  if (response.status !== 200 || cookie === undefined || client === undefined) {
    throw new Error(`the launcher document did not carry bootstrap authority (${response.status})`);
  }
  return { cookie, client };
}

/** GETs the current project document and parses its real authority set. */
async function projectDocumentOf(
  port: number,
  projectA: SwitchProject,
  projectB: SwitchProject,
  composition: ControlPlaneComposition,
): Promise<SwitchDocument> {
  const active = composition.supervisor.snapshot().active;
  if (active === undefined) throw new Error('no active session to document');
  const project = active.projectKey === projectA.key ? projectA : projectB;
  return await documentOf(port, project, active.ref);
}

/** One project's served document — the exact capabilities a committed client holds. */
async function documentOf(
  port: number,
  project: SwitchProject,
  session: SessionRef,
): Promise<SwitchDocument> {
  const response = await rawExchange(
    port,
    [
      'GET /__astroix/app/ HTTP/1.1',
      `Host: ${project.hostname}:${port}`,
      'Connection: close',
      '',
      '',
    ].join('\r\n'),
  );
  const cookie = /__astroix_host=([^;]+)/.exec(response.headers)?.[1];
  const client = /name="astroix-client" content="([^"]+)"/.exec(response.body)?.[1];
  if (response.status !== 200 || cookie === undefined || client === undefined) {
    throw new Error(
      `the project ${project.name} document did not carry bootstrap authority (${response.status})`,
    );
  }
  return {
    project,
    origin: project.origin,
    hostCapability: cookie,
    clientCapability: client,
    session,
  };
}

// ——— the wire ———

/** Whether a command is a mutation (the admission's evidence shape depends on it). */
function mutationOf(envelope: RequestEnvelope): boolean {
  return envelope.command.kind !== 'inspect' && envelope.command.kind !== 'list-projects';
}

/** The Host header a credential set rides on — the launcher, or the named project's virtual host. */
function hostOf(credentials: WireCredentials, port: number): string {
  if (credentials.project === undefined) return `launcher.localhost:${port}`;
  return `${credentials.project.hostname}:${port}`;
}

/** The wire credentials one committed document holds — the cookie/client pair the admission verifies. */
function credentialsOf(document: SwitchDocument): WireCredentials {
  return {
    cookie: document.hostCapability,
    client: document.clientCapability,
    project: document.project,
  };
}

/** One admitted POST with the exact evidence the admission spine demands for the command's shape. */
async function postEnvelope(
  port: number,
  envelope: RequestEnvelope,
  credentials: WireCredentials,
  nextRequestId: () => string,
  mutation: boolean,
): Promise<WireResponse> {
  const body = JSON.stringify({ ...envelope, requestId: nextRequestId() });
  const host = hostOf(credentials, port);
  const lines = [
    'POST /__astroix/api/v1 HTTP/1.1',
    `Host: ${host}`,
    `Cookie: __astroix_host=${credentials.cookie}`,
    `X-Astroix-Client: ${credentials.client}`,
    'Content-Type: application/json',
    ...(mutation
      ? [`Origin: http://${host}`, 'X-Astroix-Request: 1']
      : ['Sec-Fetch-Site: same-origin']),
    `Content-Length: ${Buffer.byteLength(body, 'utf8')}`,
    'Connection: close',
    '',
    body,
  ];
  return await rawExchange(port, lines.join('\r\n'), ACTIVATION_BUDGET_MS);
}

// ——— the live probes ———

/** Opens the session events stream on the project host — the editor binding's own stream. */
async function openEvents(port: number, document: SwitchDocument): Promise<LiveProbe> {
  const query = `?runtimeEpoch=${encodeURIComponent(document.session.runtimeEpoch)}&generation=${document.session.generation}`;
  const request = [
    `GET /__astroix/events${query} HTTP/1.1`,
    `Host: ${document.project.hostname}:${port}`,
    `Cookie: __astroix_host=${document.hostCapability}`,
    `X-Astroix-Client: ${document.clientCapability}`,
    'Sec-Fetch-Site: same-origin',
    'Accept: text/event-stream',
    '',
    '',
  ].join('\r\n');
  return openLiveSocket(port, request);
}

/** Opens the raw vite-hmr upgrade through the lease — the token from the real dev server's own client. */
async function openHmr(port: number, document: SwitchDocument): Promise<LiveProbe> {
  const token = await hmrTokenOf(port, document);
  const key = randomBytes(16).toString('base64');
  const request = [
    `GET /?token=${token} HTTP/1.1`,
    `Host: ${document.project.hostname}:${port}`,
    `Origin: ${document.origin}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Protocol: vite-hmr',
    '',
    '',
  ].join('\r\n');
  return openLiveSocket(port, request);
}

/** The dev server's own HMR token — discovered from the served `/@vite/client`, never guessed. */
async function hmrTokenOf(port: number, document: SwitchDocument): Promise<string> {
  const response = await fetchProxied(port, document, '/@vite/client');
  const token = /const wsToken = "([^"]+)"/.exec(response.body)?.[1];
  if (response.status !== 200 || token === undefined) {
    throw new Error('the dev server did not disclose its HMR token (the probe cannot form)');
  }
  return token;
}

/** One GET through the lease (proxied traffic — Host-admitted, never reserved). */
async function fetchProxied(
  port: number,
  document: SwitchDocument,
  path: string,
): Promise<WireResponse> {
  return await rawExchange(
    port,
    [
      `GET ${path} HTTP/1.1`,
      `Host: ${document.project.hostname}:${port}`,
      `Cookie: __astroix_host=${document.hostCapability}`,
      'Connection: close',
      '',
      '',
    ].join('\r\n'),
  );
}

/**
 * One live socket whose status promise settles when the head arrives —
 * the SSE and HMR probes share it. The frame log keeps only complete
 * `data: …` lines (a bounded buffer: the tail is retained, the head is
 * dropped once it exceeds the cap — a probe, not a recorder).
 */
function openLiveSocket(port: number, request: string): LiveProbe {
  const socket = connect({ host: '127.0.0.1', port });
  const frames: string[] = [];
  let buffer = '';
  let settled = false;
  let settleStatus: ((status: number) => void) | undefined;
  const status = new Promise<number>((settle) => {
    settleStatus = settle;
  });
  const closed = new Promise<void>((settle) => {
    socket.on('close', () => settle());
  });
  const timer = armTimer(WIRE_BUDGET_MS, () => socket.destroy());
  socket.on('connect', () => socket.write(request));
  socket.on('data', (chunk: Buffer) => {
    const text = chunk.toString('latin1');
    if (!settled) {
      const parsed = parseStatus(text);
      if (parsed !== undefined) {
        settled = true;
        settleStatus?.(parsed);
        disarmTimer(timer);
      }
    }
    buffer += text;
    collectFrames();
  });
  socket.on('error', () => socket.destroy());
  return { status, closed, frames: () => [...frames], destroy: () => socket.destroy() };

  /** Drains complete `data:` lines out of the buffer, keeping the partial tail. */
  function collectFrames(): void {
    for (;;) {
      const start = buffer.indexOf('data: ');
      if (start === -1) {
        trimBuffer();
        return;
      }
      const end = buffer.indexOf('\n', start);
      if (end === -1) {
        buffer = buffer.slice(start);
        trimBuffer();
        return;
      }
      frames.push(buffer.slice(start + 6, end).trimEnd());
      buffer = buffer.slice(end + 1);
    }
  }

  /** Bounds the buffer — a long-lived tunnel's binary frames must not accumulate. */
  function trimBuffer(): void {
    if (buffer.length > 65_536) buffer = buffer.slice(-4096);
  }
}

/** A mutation whose body completes only when `finish()` runs — precommit work held at the boundary. */
function openDelayedMutation(
  port: number,
  envelope: RequestEnvelope,
  document: SwitchDocument,
  nextRequestId: () => string,
  splitAt: number,
): DelayedMutation {
  const body = JSON.stringify({ ...envelope, requestId: nextRequestId() });
  const host = `${document.project.hostname}:${port}`;
  const head = [
    'POST /__astroix/api/v1 HTTP/1.1',
    `Host: ${host}`,
    `Cookie: __astroix_host=${document.hostCapability}`,
    `X-Astroix-Client: ${document.clientCapability}`,
    'Content-Type: application/json',
    `Origin: http://${host}`,
    'X-Astroix-Request: 1',
    `Content-Length: ${Buffer.byteLength(body, 'utf8')}`,
    '',
    '',
  ].join('\r\n');
  const socket = connect({ host: '127.0.0.1', port });
  socket.on('connect', () => {
    socket.write(head);
    socket.write(body.slice(0, splitAt));
  });
  socket.on('error', () => socket.destroy());
  return {
    finish: () =>
      new Promise<WireResponse>((resolve, reject) => {
        const chunks: Buffer[] = [];
        socket.on('data', (chunk: Buffer) => chunks.push(chunk));
        socket.on('error', (error: Error) => reject(error));
        socket.on('close', () => {
          const text = Buffer.concat(chunks).toString('latin1');
          resolve({ status: parseStatus(text) ?? 0, body: bodyAfter(text) });
        });
        socket.write(body.slice(splitAt));
      }),
    destroy: () => socket.destroy(),
  };
}

// ——— the oracles ———

/** Every source file's SHA-256 under a root — caches and the symlinked installation excluded. */
async function treeOf(root: string): Promise<ReadonlyMap<string, string>> {
  const out = new Map<string, string>();
  await walk(root, '', out);
  return out;
}

/** The recursive tree walk — skip-listed caches never enter the oracle. */
async function walk(root: string, relativeDir: string, out: Map<string, string>): Promise<void> {
  const skip = new Set(['node_modules', 'dist', '.astro', '.vite']);
  const entries = await readdir(join(root, relativeDir), { withFileTypes: true });
  for (const entry of entries) {
    if (skip.has(entry.name)) continue;
    const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      await walk(root, relativePath, out);
    } else if (entry.isFile()) {
      const bytes = await readFile(join(root, relativePath));
      out.set(relativePath, createHash('sha256').update(bytes).digest('hex'));
    }
  }
}

/** This process's live subtree — every descendant pid with its command line. */
async function subtreePids(): Promise<ReadonlyMap<number, string>> {
  const { stdout } = await promisify(execFile)('ps', ['-axo', 'pid=,ppid=,command=']);
  const parents = new Map<number, { ppid: number; command: string }>();
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    parents.set(Number.parseInt(match[1] ?? '0', 10), {
      ppid: Number.parseInt(match[2] ?? '0', 10),
      command: match[3] ?? '',
    });
  }
  const out = new Map<number, string>();
  const frontier = [process.pid];
  while (frontier.length > 0) {
    const pid = frontier.pop();
    if (pid === undefined || out.has(pid)) continue;
    const entry = parents.get(pid);
    if (entry === undefined) continue;
    out.set(pid, entry.command);
    for (const [child, record] of parents) {
      if (record.ppid === pid) frontier.push(child);
    }
  }
  return out;
}

// ——— staging ———

/** Project A's distinct observable content: its marker sheet comment. */
async function markProjectA(root: string): Promise<void> {
  await appendMarker(root, '/* project-a: the A-B-A switch harness marker */\n');
}

/** Project B's distinct observable content: its marker, its own route, its own content bytes. */
async function markProjectB(root: string): Promise<void> {
  await appendMarker(root, '/* project-b: the A-B-A switch harness marker */\n');
  await writeFile(
    join(root, 'src', 'pages', 'about.astro'),
    ['---', '---', '<html><body><h1 data-project="b">Project B about</h1></body></html>', ''].join(
      '\n',
    ),
    'utf8',
  );
  const entry = join(root, 'src', 'content', 'blog', 'hello-builder.md');
  await writeFile(
    entry,
    `${await readFile(entry, 'utf8')}\n<!-- project-b content marker -->\n`,
    'utf8',
  );
}

/** Appends one marker line to the staged sheet — the wrong-project oracle's anchor. */
async function appendMarker(root: string, marker: string): Promise<void> {
  const sheet = join(root, 'src', 'pages', 'home.css');
  await writeFile(sheet, `${await readFile(sheet, 'utf8')}${marker}`, 'utf8');
}

/** The registry's own keys for the staged roots — distinct roots, distinct keys (the registry's law). */
async function keysOf(
  composition: ControlPlaneComposition,
  rootA: string,
  rootB: string,
): Promise<[ProjectKey, ProjectKey]> {
  const records = composition.registry.snapshot().records;
  const canonicalA = await realpath(rootA);
  const canonicalB = await realpath(rootB);
  const keyA = records.find((entry) => entry.canonicalRoot === canonicalA)?.projectKey;
  const keyB = records.find((entry) => entry.canonicalRoot === canonicalB)?.projectKey;
  if (keyA === undefined || keyB === undefined || keyA === keyB) {
    throw new Error('the staged projects did not register as distinct keys');
  }
  return [keyA, keyB];
}

/** Builds one project view — the hostname and origin the listener publishes for its key. */
function projectOf(name: 'A' | 'B', root: string, key: ProjectKey, port: number): SwitchProject {
  const hostname = projectHostname(key);
  return {
    name,
    root,
    key,
    hostname,
    origin: `http://${hostname}:${port}`,
    cssPath: 'src/pages/home.css',
    contentPath: 'src/content/blog/hello-builder.md',
  };
}

// ——— raw socket plumbing ———

/** The launcher document's GET bytes. */
function launcherGet(port: number): string {
  return [
    'GET /__astroix/app/ HTTP/1.1',
    `Host: launcher.localhost:${port}`,
    'Connection: close',
    '',
    '',
  ].join('\r\n');
}

/** One raw HTTP/1.1 exchange — head and body out, the honest accounting in. */
export function rawExchange(
  port: number,
  request: string,
  timeoutMs = WIRE_BUDGET_MS,
): Promise<{ readonly status: number; readonly headers: string; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    const timer = armTimer(timeoutMs, () => socket.destroy());
    const finish = (): void => {
      disarmTimer(timer);
      const text = Buffer.concat(chunks).toString('latin1');
      resolve({ status: parseStatus(text) ?? 0, headers: headOf(text), body: bodyAfter(text) });
    };
    socket.on('connect', () => socket.write(request));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', (error: Error) => {
      disarmTimer(timer);
      reject(error);
    });
    socket.on('close', finish);
  });
}

/** The status line's number, or undefined when no status line has arrived. */
function parseStatus(text: string): number | undefined {
  const status = Number.parseInt(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? '0', 10);
  return status > 0 ? status : undefined;
}

/** The head block of one raw response. */
function headOf(text: string): string {
  const split = text.indexOf('\r\n\r\n');
  return split === -1 ? text : text.slice(0, split);
}

/** The body block of one raw response — chunked framing is not decoded (probes never need it). */
function bodyAfter(text: string): string {
  const split = text.indexOf('\r\n\r\n');
  return split === -1 ? '' : text.slice(split + 4);
}

/** A cancellable timer handle — never a bare Node.Timeout leaking into probe types. */
interface TimerHandle {
  clear(): void;
}

/** setTimeout with a clear() handle — the bounded probes' timer discipline. */
function armTimer(ms: number, onFire: () => void): TimerHandle {
  const handle = globalThis.setTimeout(onFire, ms);
  return { clear: () => globalThis.clearTimeout(handle) };
}

/** clearTimeout through the handle — one spelling. */
function disarmTimer(handle: TimerHandle): void {
  handle.clear();
}

/** Awaits a predicate with a bounded poll — the settle discipline (never a naked sleep). */
export async function pollUntil(
  probe: () => Promise<boolean>,
  budgetMs: number,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (await probe()) return;
    if (Date.now() >= deadline) throw new Error('the polled condition never settled');
    await sleep(intervalMs);
  }
}

/** One bounded sleep — the poll's interval. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}
