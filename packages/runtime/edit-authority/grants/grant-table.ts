import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type EditOperationKind,
  projectRelativePathSchema,
  type ResourceGrant,
  type ResourceKind,
  type RevisionContract,
  type SessionRef,
  type Sha256Hex,
} from '@wojciechpiskorz/astroix-protocol';
import {
  isCanonicalDescendant,
  isCreationParent,
  sameSession,
  sha256Hex,
} from './canonical-bounds';
import { mintGrantToken } from './grant-token';

/**
 * The server-side resource-grant table (#223, ADR-0006 §6): the only
 * issuance point of opaque per-activation `ResourceGrant` values, and the
 * authority every echoed wire grant is re-validated against. A grant
 * record binds the canonical project identity (the realpath'd root —
 * D2's identity; the ProjectKey is routing, never identity), the exact
 * `SessionRef`, the resource kind, the allowed operations, the canonical
 * existing target or creation parent, and the revision contract: an
 * exact SHA-256 baseline for existing text, an explicit expected-absent
 * baseline plus a contained canonical parent for creation.
 *
 * Scope fence (the #223/D5 split): this module issues and validates
 * grants; it never writes. Execution — the serialized write executor,
 * the temp-file/atomic-replace and exclusive-creation mechanics, the
 * final realpath/lstat/containment recheck immediately before commit —
 * belongs to `edit-authority/executor/` (D5, #224). The world checks
 * here are the planning-boundary halves of the same law: they fail
 * stale, revoked, mismatched, cross-session, wrong-kind, or changed
 * grants before any write is admitted.
 */

/**
 * The closed kind→operation species matrix: what each resource kind
 * permits. A grant's allowed operations are always a non-empty subset of
 * its kind's row.
 */
export const KIND_OPERATIONS: Readonly<Record<ResourceKind, readonly EditOperationKind[]>> = {
  // The content vertical rewrites whole entry files (core's entry-writer
  // serialization — the raw truth's byte-anchored replace) and creates
  // new entries under discovered collection directories.
  content: ['replace-contents', 'create-contents'],
  // The style vertical splices into existing CSS (core's splice-writer)
  // or replaces whole contents. New-rule placement (nearest home,
  // overrides fallback) is deferred beyond the pre-alpha (#203), so
  // creation is not in the css species set.
  css: ['replace-contents', 'splice'],
};

/** The only operation a creation grant may carry. */
const CREATION_OPERATIONS: readonly EditOperationKind[] = ['create-contents'];

/**
 * A discovered existing text resource — control-plane only, never a wire
 * shape (ADR-0006 §9: `DiscoveredResource` stays off the wire). The path
 * and revision are exactly what Astroix's own discovery served: E4's
 * content inspection (`filePath` + the SHA-256 entry revision) or the
 * styles model's file records with the same digest species over the CSS
 * bytes.
 */
export interface DiscoveredTextResource {
  readonly discovery: 'existing-text';
  readonly kind: ResourceKind;
  /** Project-relative posix path exactly as discovery served it. */
  readonly path: string;
  /**
   * The inspection-minted SHA-256 revision of the resource's current
   * bytes — the grant baseline. Issuance verifies it against the world;
   * a stale discovery fact never becomes authority.
   */
  revision: Sha256Hex;
  /** Optional narrowing of the kind's species set (non-empty subset). */
  readonly operations?: readonly EditOperationKind[];
}

/** A discovered creation slot — a canonical parent directory plus one file segment. */
export interface DiscoveredCreationResource {
  readonly discovery: 'creation';
  readonly kind: ResourceKind;
  /** Project-relative posix path of the discovered creation parent. */
  readonly parentPath: string;
  /** The single file segment to create under the parent. */
  readonly fileName: string;
  /** Optional narrowing; a creation grant only ever permits `create-contents`. */
  readonly operations?: readonly EditOperationKind[];
}

export type DiscoveredResource = DiscoveredTextResource | DiscoveredCreationResource;

/**
 * What one grant authorizes — the server-side truth the wire grant is a
 * claim about. Carries everything the executor lane needs to write
 * without re-deriving authority: the canonical target (or creation
 * parent), the revision contract it must still hold, the session and
 * kind it belongs to.
 */
export interface GrantedResource {
  /** Canonical project identity (the realpath'd root; never the routing key). */
  readonly canonicalRoot: string;
  readonly session: SessionRef;
  readonly kind: ResourceKind;
  readonly operations: readonly EditOperationKind[];
  /** Project-relative posix display path — presentation only, never authority. */
  readonly displayPath: string;
  readonly baseline: RevisionContract;
  readonly target:
    | { readonly type: 'existing'; readonly canonicalPath: string }
    | {
        readonly type: 'creation';
        readonly canonicalParent: string;
        readonly fileName: string;
      };
}

/** The closed grant failure set — control-plane outcomes, sanitized by construction. */
export type GrantFailureCode =
  // authorize
  | 'unknown-grant'
  | 'cross-session'
  | 'revoked'
  | 'superseded'
  | 'wrong-kind'
  | 'operation-not-allowed'
  // issue
  | 'invalid-resource-path'
  | 'invalid-operations'
  | 'outside-root'
  | 'parent-outside-root'
  | 'target-absent'
  | 'parent-absent'
  | 'not-a-file'
  | 'parent-not-directory'
  | 'hard-linked-target'
  | 'revision-mismatch'
  | 'target-exists'
  // verify
  | 'target-moved'
  | 'changed-baseline';

/** Static, sanitized messages per code — no interpolated paths, errnos, or system text. */
const FAILURE_MESSAGES: Record<GrantFailureCode, string> = {
  'unknown-grant': 'the presented grant matches no issued grant',
  'cross-session': 'the grant belongs to another session',
  revoked: 'the grant was revoked',
  superseded: 'a newer grant for the same resource replaced this one',
  'wrong-kind': 'the grant is for another resource kind',
  'operation-not-allowed': 'the operation is not among the grant\u2019s allowed operations',
  'invalid-resource-path': 'the discovered resource path is not project-relative posix',
  'invalid-operations':
    'the requested operations are not a non-empty subset of the kind\u2019s species',
  'outside-root': 'the discovered resource resolves outside the canonical project root',
  'parent-outside-root': 'the creation parent resolves outside the canonical project root',
  'target-absent': 'the discovered resource no longer exists',
  'parent-absent': 'the creation parent no longer exists',
  'not-a-file': 'the discovered resource is not a regular file',
  'parent-not-directory': 'the creation parent is not a directory',
  'hard-linked-target': 'the target has more than one hard link',
  'revision-mismatch': 'the discovered revision does not match the resource\u2019s current bytes',
  'target-exists': 'the expected-absent creation target already exists',
  'target-moved': 'the canonical target changed underneath the grant',
  'changed-baseline': 'the resource no longer matches the grant\u2019s revision contract',
};

export type GrantResult =
  | { ok: true; grant: ResourceGrant }
  | { ok: false; code: GrantFailureCode; message: string };

export type Authorization =
  | { ok: true; resource: GrantedResource; grant: ResourceGrant }
  | { ok: false; code: GrantFailureCode; message: string };

/**
 * The world check of a granted resource's revision contract: existing
 * text re-read and re-digested against the exact baseline, creation
 * targets re-checked expected-absent. `text` is the verified current
 * string contents for existing targets (the space a splice range is
 * planned against) and `null` for verified-absent creation slots.
 */
export type WorldVerification =
  | { ok: true; text: string | null }
  | { ok: false; code: GrantFailureCode; message: string };

export interface GrantTable {
  /**
   * Issues one opaque grant from a discovered resource, binding the
   * given session. The discovery facts are verified against the
   * canonical filesystem before anything is minted: containment is
   * realpath-resolved (never lexical-only), the target is a regular
   * unlinked file, and the discovered revision still equals the current
   * bytes. Issuing supersedes the session's previous active grant for
   * the same resource.
   */
  issue(resource: DiscoveredResource, session: SessionRef): Promise<GrantResult>;
  /**
   * Re-validates an echoed grant claim against the table: token
   * membership, session pair, lifecycle status, kind, and operation.
   * Pure table state — no filesystem access; the world half is
   * {@link GrantTable.verify}. Returns the server-side truth and the
   * exact issued wire grant (for echo-equality in planning).
   */
  authorize(input: {
    token: string;
    session: SessionRef;
    kind: ResourceKind;
    operation: EditOperationKind;
  }): Authorization;
  /**
   * Verifies the granted resource's revision contract against the
   * current world. This is the fail-before-any-write half the executor
   * lane repeats immediately before commit; the residual race to the
   * atomic replacement itself is the disclosed optimistic-concurrency
   * limit (ADR-0006 §6), not a check that can close it.
   */
  verify(resource: GrantedResource): Promise<WorldVerification>;
  /** Revokes one grant; returns whether an active grant was revoked. */
  revoke(token: string): boolean;
  /**
   * Revokes every active grant of one session (activation teardown);
   * returns how many died. Other sessions' grants are untouched.
   */
  revokeSession(session: SessionRef): number;
}

/** One live grant record: the authorized truth plus lifecycle state. */
interface GrantRecord {
  readonly resource: GrantedResource;
  readonly issued: ResourceGrant;
  status: 'active' | 'revoked' | 'superseded';
}

/**
 * Opens the grant table over a canonical project root. The root is
 * re-realpath'd here: the control plane passes the registry's canonical
 * root, and a root that cannot be re-resolved as a directory is a
 * construction failure (a sanitized error, like the registry's own
 * unavailable-root idiom), never a grant failure.
 */
export async function createGrantTable(canonicalRoot: string): Promise<GrantTable> {
  let root: string;
  try {
    root = await realpath(canonicalRoot);
  } catch {
    throw new Error('the canonical project root is unavailable or is not a directory');
  }
  if (!(await lstat(root)).isDirectory()) {
    throw new Error('the canonical project root is unavailable or is not a directory');
  }
  const records = new Map<string, GrantRecord>();

  return {
    issue: (resource, session) => dispatchIssue(records, root, resource, session),

    authorize: (input) => {
      const record = records.get(input.token);
      if (record === undefined) return failure('unknown-grant');
      if (!sameSession(record.resource.session, input.session)) return failure('cross-session');
      if (record.status === 'revoked') return failure('revoked');
      if (record.status === 'superseded') return failure('superseded');
      if (record.resource.kind !== input.kind) return failure('wrong-kind');
      if (!record.resource.operations.includes(input.operation)) {
        return failure('operation-not-allowed');
      }
      return { ok: true, resource: record.resource, grant: record.issued };
    },

    verify: (resource) =>
      resource.target.type === 'existing' ? verifyExisting(resource) : verifyCreation(resource),

    revoke: (token) => {
      const record = records.get(token);
      if (record === undefined || record.status !== 'active') return false;
      record.status = 'revoked';
      return true;
    },

    revokeSession: (session) => {
      let revoked = 0;
      for (const record of records.values()) {
        if (record.status === 'active' && sameSession(record.resource.session, session)) {
          record.status = 'revoked';
          revoked += 1;
        }
      }
      return revoked;
    },
  };
}

// --- issuance ---

async function dispatchIssue(
  records: Map<string, GrantRecord>,
  root: string,
  resource: DiscoveredResource,
  session: SessionRef,
): Promise<GrantResult> {
  return resource.discovery === 'existing-text'
    ? issueExisting(records, root, resource, session)
    : issueCreation(records, root, resource, session);
}

async function issueExisting(
  records: Map<string, GrantRecord>,
  root: string,
  resource: DiscoveredTextResource,
  session: SessionRef,
): Promise<GrantResult> {
  if (!projectRelativePathSchema.safeParse(resource.path).success) {
    return failure('invalid-resource-path');
  }
  const operations = resource.operations ?? KIND_OPERATIONS[resource.kind];
  if (!operationsAreSubset(KIND_OPERATIONS[resource.kind], operations)) {
    return failure('invalid-operations');
  }
  // Canonical resolution: realpath first, containment on the resolved
  // path — an internal symlink whose target stays inside the root is
  // grantable (bound to its resolved canonical), an external one is not,
  // and no lexical spelling decides either way.
  let canonical: string;
  try {
    canonical = await realpath(join(root, resource.path));
  } catch {
    return failure('target-absent');
  }
  if (!isCanonicalDescendant(root, canonical)) return failure('outside-root');
  const info = await lstat(canonical);
  if (!info.isFile()) return failure('not-a-file');
  if (info.nlink > 1) return failure('hard-linked-target');
  const bytes = await readFile(canonical);
  if (sha256Hex(bytes) !== resource.revision) return failure('revision-mismatch');
  return commit(records, {
    canonicalRoot: root,
    session,
    kind: resource.kind,
    operations: [...operations],
    displayPath: resource.path,
    baseline: { type: 'sha256', sha256: resource.revision },
    target: { type: 'existing', canonicalPath: canonical },
  });
}

async function issueCreation(
  records: Map<string, GrantRecord>,
  root: string,
  resource: DiscoveredCreationResource,
  session: SessionRef,
): Promise<GrantResult> {
  if (
    !projectRelativePathSchema.safeParse(resource.parentPath).success ||
    !isFileNameSegment(resource.fileName)
  ) {
    return failure('invalid-resource-path');
  }
  const operations = resource.operations ?? CREATION_OPERATIONS;
  if (!operationsAreSubset(CREATION_OPERATIONS, operations)) {
    return failure('invalid-operations');
  }
  let canonicalParent: string;
  try {
    canonicalParent = await realpath(join(root, resource.parentPath));
  } catch {
    return failure('parent-absent');
  }
  if (!isCreationParent(root, canonicalParent)) return failure('parent-outside-root');
  if (!(await lstat(canonicalParent)).isDirectory()) return failure('parent-not-directory');
  // Expected-absent is checked, not merely declared: the creation slot
  // must be empty now. The race to the write itself stays closed by the
  // executor's exclusive creation (D5) — ADR-0006 §6.
  try {
    await lstat(join(canonicalParent, resource.fileName));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return commit(records, {
        canonicalRoot: root,
        session,
        kind: resource.kind,
        operations: [...operations],
        displayPath: `${resource.parentPath}/${resource.fileName}`,
        baseline: { type: 'expected-absent' },
        target: { type: 'creation', canonicalParent, fileName: resource.fileName },
      });
    }
    throw error;
  }
  return failure('target-exists');
}

/**
 * The shared mint-and-supersede step: a fresh opaque token (never
 * derived from any fact of the resource), supersession of the session's
 * previous active grant for the same exact target, and insertion. The
 * wire grant is the deterministic projection of the record — token,
 * kind, operations, display path, baseline — nothing canonical leaks
 * into it.
 */
function commit(records: Map<string, GrantRecord>, resource: GrantedResource): GrantResult {
  const token = mintGrantToken();
  const issued: ResourceGrant = {
    token,
    kind: resource.kind,
    operations: [...resource.operations],
    displayPath: resource.displayPath,
    baseline: resource.baseline,
  };
  for (const other of records.values()) {
    if (
      other.status === 'active' &&
      sameSession(other.resource.session, resource.session) &&
      sameTarget(other.resource, resource)
    ) {
      other.status = 'superseded';
    }
  }
  records.set(token, { resource, issued, status: 'active' });
  return { ok: true, grant: issued };
}

function sameTarget(a: GrantedResource, b: GrantedResource): boolean {
  if (a.target.type !== b.target.type) return false;
  if (a.target.type === 'existing' && b.target.type === 'existing') {
    return a.target.canonicalPath === b.target.canonicalPath;
  }
  if (a.target.type === 'creation' && b.target.type === 'creation') {
    return (
      a.target.canonicalParent === b.target.canonicalParent &&
      a.target.fileName === b.target.fileName
    );
  }
  return false;
}

// --- world verification ---

async function verifyExisting(resource: GrantedResource): Promise<WorldVerification> {
  const expected = resource.target;
  if (expected.type !== 'existing' || resource.baseline.type !== 'sha256') {
    // A hand-built incoherent resource (a creation target under a
    // sha256 contract, or vice versa) fails closed rather than being read.
    return failure('changed-baseline');
  }
  let canonical: string;
  try {
    canonical = await realpath(expected.canonicalPath);
  } catch {
    return failure('target-absent');
  }
  if (
    canonical !== expected.canonicalPath ||
    !isCanonicalDescendant(resource.canonicalRoot, canonical)
  ) {
    return failure('target-moved');
  }
  const info = await lstat(canonical);
  if (!info.isFile()) return failure('not-a-file');
  if (info.nlink > 1) return failure('hard-linked-target');
  const bytes = await readFile(canonical);
  if (sha256Hex(bytes) !== resource.baseline.sha256) return failure('changed-baseline');
  return { ok: true, text: bytes.toString('utf8') };
}

async function verifyCreation(resource: GrantedResource): Promise<WorldVerification> {
  const expected = resource.target;
  if (expected.type !== 'creation' || resource.baseline.type !== 'expected-absent') {
    return failure('changed-baseline');
  }
  let parent: string;
  try {
    parent = await realpath(expected.canonicalParent);
  } catch {
    return failure('parent-absent');
  }
  if (
    parent !== expected.canonicalParent ||
    !isCreationParent(resource.canonicalRoot, parent) ||
    !(await lstat(parent)).isDirectory()
  ) {
    return failure('target-moved');
  }
  try {
    await lstat(join(parent, expected.fileName));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, text: null };
    throw error;
  }
  return failure('target-exists');
}

// --- small pure helpers ---

function operationsAreSubset(
  species: readonly EditOperationKind[],
  requested: readonly EditOperationKind[],
): boolean {
  // A subset is non-empty and duplicate-free — a repeated operation is a
  // caller bug, not a wider permission, but it still fails validation.
  return (
    requested.length > 0 &&
    new Set(requested).size === requested.length &&
    requested.every((operation) => species.includes(operation))
  );
}

/** A creation file name is exactly one path segment — never traversal, separators, or dot names. */
function isFileNameSegment(fileName: string): boolean {
  return (
    fileName.length > 0 &&
    !fileName.includes('/') &&
    !fileName.includes('\\') &&
    !fileName.includes('\0') &&
    fileName !== '.' &&
    fileName !== '..'
  );
}

function failure(code: GrantFailureCode): { ok: false; code: GrantFailureCode; message: string } {
  return { ok: false, code, message: FAILURE_MESSAGES[code] };
}
