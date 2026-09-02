import { stat } from 'node:fs/promises';
import {
  type ProjectAvailability,
  type ProjectKey,
  type ProjectSummary,
  sanitizedTextSchema,
} from '@wojciechpiskorz/astroix-protocol';
import {
  classifyRegistryDocument,
  emptyRegistryDocument,
  type QuarantineReason,
  type RegistryDocument,
  type RegistryRecord,
  serializeRegistryDocument,
} from './document';
import {
  allocateProjectKey,
  canonicalizeRoot,
  defaultDisplayName,
  RootUnavailableError,
} from './identity';
import {
  LAST_KNOWN_GOOD_FILE,
  openRegistryStore,
  QUARANTINE_FILE,
  REGISTRY_FILE,
  type RegistryStore,
} from './store';

/**
 * ProjectRegistry — the first deep seam of `packages/runtime` (ADR-0006 §9;
 * #221): canonical registered-project persistence. Identity is the
 * realpath'd root with the filesystem's own case semantics; routing is a
 * random record-lifetime ProjectKey; the document is strictly versioned
 * JSON with a separately maintained last-known-good snapshot; unusable
 * documents quarantine and recover only through the explicit restore
 * command — never a silent restore, guess, or auto-activation.
 *
 * Scope fence (the #209 gates this layer does and does not carry): the
 * kernel-backed `registry-writer` lease, its busy-shape classification,
 * packaged-Node integrity, and per-pin requalification belong to the
 * sibling kernel-lease/boot lanes (`packages/runtime/kernel-lease`,
 * `packages/runtime/private-boot`). This module holds no lease state, no
 * PID, no ownership record — exclusive write authority is acquired
 * upstream, before this store opens, and process exit is its release.
 */

/** The control-plane view of one persisted record (roots live here, never on the wire). */
export type RegistryRecordView = Readonly<RegistryRecord>;

/**
 * The whole registry state as the control plane sees it. While
 * quarantined there are no visible records and no guessing: the snapshot
 * says that the document is quarantined, why, and whether the explicit
 * restore command has anything to restore from.
 */
export interface RegistrySnapshot {
  status: 'ok' | 'quarantined';
  records: readonly RegistryRecordView[];
  quarantine: { reason: QuarantineReason; restoreAvailable: boolean } | null;
}

/**
 * The closed registry command union (ADR-0006 §9): register, rename,
 * remove, explicit last-known-good restore — and deliberately nothing
 * else. No root-rebind command exists in version 1: an unavailable
 * record is removed and its root registered as a new record, with the
 * key and browser origin rotating.
 */
export type RegistryCommand =
  | { kind: 'register'; root: string; displayName?: string }
  | { kind: 'rename'; projectKey: ProjectKey; displayName: string }
  | { kind: 'remove'; projectKey: ProjectKey }
  | { kind: 'restore' };

/** The closed failure code set — control-plane outcomes, not browser wire errors. */
export type RegistryErrorCode =
  | 'quarantined'
  | 'not-quarantined'
  | 'restore-unavailable'
  | 'root-unavailable'
  | 'unknown-project-key'
  | 'active-record'
  | 'invalid-display-name'
  | 'closed';

/** Static, sanitized messages per code — no interpolated paths, errnos, or system text. */
const FAILURE_MESSAGES: Record<RegistryErrorCode, string> = {
  quarantined: 'the registry document is quarantined; only the explicit restore command runs',
  'not-quarantined': 'the registry is healthy; there is nothing to restore',
  'restore-unavailable': 'no valid last-known-good snapshot exists to restore from',
  'root-unavailable': 'the granted directory is unavailable or is not a directory',
  'unknown-project-key': 'no registered project carries that project key',
  'active-record': 'the record is active; removal is rejected until its session has ended',
  'invalid-display-name': 'the display name is empty or fails the disclosure guard',
  closed: 'the registry is closed',
};

/** Summaries are Result-shaped for exactly one failure: the closed fence. */
export type SummariesResult =
  | { ok: true; summaries: readonly ProjectSummary[] }
  | { ok: false; code: 'closed'; message: string };

export type RegistryResult =
  | { ok: true; kind: 'registered'; record: RegistryRecordView; existed: boolean }
  | { ok: true; kind: 'renamed'; record: RegistryRecordView }
  | { ok: true; kind: 'removed'; record: RegistryRecordView }
  | { ok: true; kind: 'restored'; records: readonly RegistryRecordView[] }
  | { ok: false; code: RegistryErrorCode; message: string };

export interface ProjectRegistry {
  /** The in-memory truth — pure, no filesystem access. */
  snapshot(): RegistrySnapshot;
  /** Executes one registry command; domain failures are results, system errors propagate. */
  execute(command: RegistryCommand): Promise<RegistryResult>;
  /**
   * Browser-facing summaries: key, display name, sanitized availability —
   * no roots, ever. Availability is live (a stat per record), so a closed
   * registry refuses rather than answer from a filesystem it no longer
   * owns — fenced exactly like execute.
   */
  projectSummaries(): Promise<SummariesResult>;
  /** Fences further mutation; idempotent. */
  close(): Promise<void>;
}

export interface ProjectRegistryOptions {
  /**
   * Whether a project key names the active session's record (ADR-0006 §1:
   * remove/re-register is rejected while the record is active; a
   * display-only rename stays legal). The session supervisor wires this
   * in a later lane; the default is "nothing is active".
   */
  readonly isActiveProjectKey?: (projectKey: ProjectKey) => boolean;
}

interface RegistryState {
  status: 'ok' | 'quarantined';
  document: RegistryDocument;
  quarantineReason: QuarantineReason | null;
  restoreAvailable: boolean;
}

/**
 * Opens the registry over `directory`: loads and classifies the current
 * document, quarantining (renaming intact aside) a corrupt or
 * unsupported-future one, and computes whether the explicit restore
 * command has a valid last-known-good snapshot. See `loadState` for the
 * crash-window reasoning behind each branch.
 */
export async function createProjectRegistry(
  directory: string,
  options: ProjectRegistryOptions = {},
): Promise<ProjectRegistry> {
  const store = await openRegistryStore(directory);
  const state = await loadState(store);
  let closed = false;
  // Mutations serialize through one queue: the in-memory document is the
  // single editing surface, and overlapping commands must not interleave
  // their read-modify-write. (Cross-process exclusion is not this queue's
  // job — that is the upstream registry-writer lease.)
  let queue: Promise<unknown> = Promise.resolve();

  return {
    snapshot: () => ({
      status: state.status,
      records: state.status === 'ok' ? [...state.document.records] : [],
      quarantine:
        state.status === 'quarantined' && state.quarantineReason !== null
          ? { reason: state.quarantineReason, restoreAvailable: state.restoreAvailable }
          : null,
    }),

    execute: (command) => {
      const run = queue.then(() =>
        closed ? failure('closed') : dispatch(state, store, options, command),
      );
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },

    projectSummaries: () =>
      closed ? Promise.resolve(summariesFailure()) : projectSummaries(state),

    close: async () => {
      closed = true;
    },
  };
}

async function dispatch(
  state: RegistryState,
  store: RegistryStore,
  options: ProjectRegistryOptions,
  command: RegistryCommand,
): Promise<RegistryResult> {
  switch (command.kind) {
    case 'register':
      return register(state, store, command);
    case 'rename':
      return rename(state, store, command);
    case 'remove':
      return remove(state, store, options, command);
    case 'restore':
      return restore(state, store);
  }
}

// --- command handlers ---

async function register(
  state: RegistryState,
  store: RegistryStore,
  command: { root: string; displayName?: string },
): Promise<RegistryResult> {
  if (state.status !== 'ok') return failure('quarantined');
  let canonicalRoot: string;
  try {
    canonicalRoot = await canonicalizeRoot(command.root);
  } catch (error) {
    // identity.ts names RootUnavailableError the only thrown error — a
    // bare catch would silently reclassify any future divergence as an
    // unavailable root; system errors propagate instead
    if (!(error instanceof RootUnavailableError)) throw error;
    return failure('root-unavailable');
  }
  // Alias resolution (ADR-0006 §1): a root symlink or case alias of an
  // existing record IS that record — the registration neither duplicates
  // nor silently renames; an explicit displayName is ignored in favor of
  // the rename command. An EXPLICIT name is still validated first —
  // silently discarding an invalid one would mask a caller input error
  // the rest of the API rejects (a valid name just stays ignored on
  // dedupe).
  if (
    command.displayName !== undefined &&
    !sanitizedTextSchema.safeParse(command.displayName).success
  ) {
    return failure('invalid-display-name');
  }
  const existing = state.document.records.find((r) => r.canonicalRoot === canonicalRoot);
  if (existing !== undefined) {
    return { ok: true, kind: 'registered', record: existing, existed: true };
  }
  const displayName = command.displayName ?? defaultDisplayName(canonicalRoot);
  if (!sanitizedTextSchema.safeParse(displayName).success) {
    return failure('invalid-display-name');
  }
  const record: RegistryRecord = {
    projectKey: allocateProjectKey(new Set(state.document.records.map((r) => r.projectKey))),
    canonicalRoot,
    displayName,
  };
  await persist(state, store, withRecords(state.document, [...state.document.records, record]));
  return { ok: true, kind: 'registered', record, existed: false };
}

async function rename(
  state: RegistryState,
  store: RegistryStore,
  command: { projectKey: ProjectKey; displayName: string },
): Promise<RegistryResult> {
  if (state.status !== 'ok') return failure('quarantined');
  const record = findByKey(state, command.projectKey);
  if (record === undefined) return failure('unknown-project-key');
  if (!sanitizedTextSchema.safeParse(command.displayName).success) {
    return failure('invalid-display-name');
  }
  const renamed: RegistryRecord = { ...record, displayName: command.displayName };
  await persist(
    state,
    store,
    withRecords(
      state.document,
      state.document.records.map((r) => (r.projectKey === renamed.projectKey ? renamed : r)),
    ),
  );
  return { ok: true, kind: 'renamed', record: renamed };
}

async function remove(
  state: RegistryState,
  store: RegistryStore,
  options: ProjectRegistryOptions,
  command: { projectKey: ProjectKey },
): Promise<RegistryResult> {
  if (state.status !== 'ok') return failure('quarantined');
  const record = findByKey(state, command.projectKey);
  if (record === undefined) return failure('unknown-project-key');
  if (options.isActiveProjectKey?.(record.projectKey)) return failure('active-record');
  // The record leaves the registry; the project's files are never touched
  // (ADR-0006 §1: removing a registry record never removes project files).
  await persist(
    state,
    store,
    withRecords(
      state.document,
      state.document.records.filter((r) => r.projectKey !== record.projectKey),
    ),
  );
  return { ok: true, kind: 'removed', record };
}

async function restore(state: RegistryState, store: RegistryStore): Promise<RegistryResult> {
  if (state.status !== 'quarantined') return failure('not-quarantined');
  if (!state.restoreAvailable) return failure('restore-unavailable');
  const snapshotText = await store.read(LAST_KNOWN_GOOD_FILE);
  if (snapshotText === null) return failure('restore-unavailable');
  const classification = classifyRegistryDocument(snapshotText);
  if (classification.status !== 'ok') {
    // The snapshot degraded since load (nothing this process wrote — all
    // mutation is fenced while quarantined); fail closed, stay quarantined.
    return failure('restore-unavailable');
  }
  // The restore's exact snapshot bytes become the current document —
  // byte-identical to what was last known good, no reformatting. The
  // quarantine file is deleted only after the current document is safely
  // back; a crash between the two leaves a valid document plus stale
  // quarantine residue, which the next load resolves in favor of the
  // valid document (see loadState).
  await store.writeAtomically(REGISTRY_FILE, snapshotText);
  state.document = classification.document;
  state.status = 'ok';
  state.quarantineReason = null;
  state.restoreAvailable = false;
  await store.delete(QUARANTINE_FILE);
  return { ok: true, kind: 'restored', records: [...classification.document.records] };
}

// --- load ---

/**
 * The load state machine. Every branch is crash-safe:
 * - A valid current document plus a leftover quarantine file is the
 *   crash window of an interrupted restore (or a completed manual
 *   recovery) — the valid current document governs and the residue goes.
 * - An invalid current document is renamed aside NOW so its bytes
 *   survive for diagnostics and no later first-boot logic can mistake
 *   the state for a fresh registry.
 * - No current document plus a quarantine file is that rename surviving
 *   a crash: still quarantined (the reason is re-derived from the
 *   quarantined bytes themselves).
 * - Neither file is a genuine first boot: an empty registry. A
 *   last-known-good without a current document is not auto-restored —
 *   restore is explicit or nothing.
 */
async function loadState(store: RegistryStore): Promise<RegistryState> {
  const current = await store.read(REGISTRY_FILE);
  if (current !== null) {
    const classification = classifyRegistryDocument(current);
    if (classification.status === 'ok') {
      if (await store.exists(QUARANTINE_FILE)) {
        await store.delete(QUARANTINE_FILE);
      }
      return okState(classification.document);
    }
    await store.quarantineCurrent();
    return quarantinedState(
      classification.status === 'unsupported-future' ? 'unsupported-future' : 'corrupt',
      store,
    );
  }
  if (await store.exists(QUARANTINE_FILE)) {
    const quarantined = await store.read(QUARANTINE_FILE);
    const reason =
      quarantined !== null && classifyRegistryDocument(quarantined).status === 'unsupported-future'
        ? 'unsupported-future'
        : 'corrupt';
    return quarantinedState(reason, store);
  }
  return okState(emptyRegistryDocument());
}

function okState(document: RegistryDocument): RegistryState {
  return { status: 'ok', document, quarantineReason: null, restoreAvailable: false };
}

async function quarantinedState(
  reason: QuarantineReason,
  store: RegistryStore,
): Promise<RegistryState> {
  return {
    status: 'quarantined',
    document: emptyRegistryDocument(),
    quarantineReason: reason,
    restoreAvailable: await snapshotIsRestorable(store),
  };
}

async function snapshotIsRestorable(store: RegistryStore): Promise<boolean> {
  const snapshotText = await store.read(LAST_KNOWN_GOOD_FILE);
  return snapshotText !== null && classifyRegistryDocument(snapshotText).status === 'ok';
}

// --- persistence and reads ---

/**
 * The write discipline per mutation (ADR-0006 §2): serialize
 * deterministically, atomically replace the current document, adopt it in
 * memory, then mirror the same bytes into the last-known-good snapshot.
 * At rest the snapshot equals the current document; a crash between the
 * two writes leaves the snapshot one mutation behind — always a valid,
 * explicitly restorable state.
 */
async function persist(
  state: RegistryState,
  store: RegistryStore,
  document: RegistryDocument,
): Promise<void> {
  const text = serializeRegistryDocument(document);
  await store.writeAtomically(REGISTRY_FILE, text);
  state.document = document;
  await store.writeAtomically(LAST_KNOWN_GOOD_FILE, text);
}

function withRecords(document: RegistryDocument, records: RegistryRecord[]): RegistryDocument {
  return { schemaVersion: document.schemaVersion, records };
}

function findByKey(state: RegistryState, projectKey: ProjectKey): RegistryRecord | undefined {
  return state.document.records.find((r) => r.projectKey === projectKey);
}

/**
 * Browser-facing summaries (ADR-0006 §1): project key, display name, and
 * sanitized availability — the exact protocol `ProjectSummary` shape, so
 * the summary cannot carry a root or process detail structurally. A root
 * that has gone missing stays visible as `unavailable` until its record
 * is explicitly removed; availability says whether, never why.
 */
async function projectSummaries(state: RegistryState): Promise<SummariesResult> {
  const summaries = await Promise.all(
    state.document.records.map(async (record) => {
      const availability: ProjectAvailability = (await isAvailable(record.canonicalRoot))
        ? 'available'
        : 'unavailable';
      return {
        projectKey: record.projectKey,
        displayName: record.displayName,
        availability,
      } satisfies ProjectSummary;
    }),
  );
  return { ok: true, summaries };
}

/** The closed fence's answer — the one failure summaries can be. */
function summariesFailure(): SummariesResult {
  return { ok: false, code: 'closed', message: FAILURE_MESSAGES.closed };
}

async function isAvailable(canonicalRoot: string): Promise<boolean> {
  try {
    await stat(canonicalRoot);
    return true;
  } catch {
    return false;
  }
}

function failure(code: RegistryErrorCode): RegistryResult {
  return { ok: false, code, message: FAILURE_MESSAGES[code] };
}
