import { createHash } from 'node:crypto';
import { createReadStream, type Dirent } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  CERTIFIED_PAIRS,
  type ExactPair,
  isCertifiedPair,
} from '../../astro-project-adapter/certified-pair.ts';
import { QUALIFIED_NODE_VERSION } from '../../kernel-lease/kernel-lease.ts';

/**
 * The internal packaged-asset adapter (#244, H2; ADR-0008 packaged-runtime
 * layout): the ONE seam that names and verifies the immutable resources a
 * packaged app resolves its runtime spawns from — the exact stock Node
 * executable under `Contents/Resources/node/` and the built control-plane
 * runtime under `Contents/Resources/astroix-runtime/`, both as real files
 * outside `app.asar`.
 *
 * What lives here and nowhere else:
 *
 * - **The ratified resource layout vocabulary** — the relative resource
 *   ids (`node/bin/node`, `astroix-runtime/control-plane/child.js`, the
 *   build manifest). Absolute packaged paths are derived, never stored.
 * - **The pin table** — the exact Node pin is the kernel lease's qualified
 *   pin (one source of truth, #209), the Electron pin is ADR-0008's, the
 *   Astro/Vite pin is the certified pair (ADR-0005), and Forge is
 *   ADR-0008's exact pin (the Forge wiring itself is H3 #245).
 * - **The build manifest** — schema, builder, and serializer. The
 *   assembler (`apps/desktop/scripts/assemble-runtime.mjs`) and the
 *   deterministic tests share this code; the serializer's fixed key
 *   order + sorted inventory make same-input manifests byte-identical.
 * - **Verification** — before private boot or project activation the app
 *   verifies every immutable resource: existence, regular-file type, the
 *   symlink policy (leaves AND intermediate directories — the build
 *   manifest leaf included, so the trust anchor sits under the same law
 *   it enforces — plus the kernel-lease hard-link discipline `nlink =
 *   1`), containment inside the resources root, executable identity (the
 *   exec bit on the Node executable, plus the byte hash that pins its
 *   exact identity), the size, and the SHA-256 of every inventoried file
 *   against the manifest. The layout laws run both ways: the manifest
 *   must inventory the required facts (the Node executable, the entry,
 *   the ESM module-type marker the packaged child cannot load without),
 *   and the two ratified subtrees may hold NOTHING the manifest does not
 *   name — unlisted files reject, they never ride along silently.
 *
 * Fail-closed law (ADR-0008): there is no fallback. Missing, altered,
 * symlinked, wrong-version, wrong-architecture, or wrong-Electron
 * resources reject — nothing searches PATH, developer Node, Electron
 * RunAsNode, or any other substitute. The rejection vocabulary is
 * sanitized: codes and relative resource ids only, never absolute
 * packaged paths or hashes — packaged paths stay behind this adapter and
 * never reach ProjectRuntime, protocol responses, public errors, or
 * renderer state.
 *
 * This module is internal by name and by consumers: the desktop host's
 * runtime-assets resolver and the assembly/verification scripts. It is
 * deterministic real-filesystem code (temp directories, real files) —
 * covered tier like the registry seam (#221), never spawned process IO.
 */

// ——— the ratified resource layout (ADR-0008) ———

/** The built runtime subtree: real immutable files outside `app.asar`. */
export const RUNTIME_RESOURCE_DIR = 'astroix-runtime';
/** The bundled stock Node subtree. */
export const NODE_RESOURCE_DIR = 'node';
/** The stock Node executable, at the official distribution's relative position. */
export const NODE_EXECUTABLE_RESOURCE_PATH = 'node/bin/node';
/** The rebased control-plane child entry (plain ECMAScript — no dev loaders needed). */
export const CONTROL_PLANE_ENTRY_RESOURCE_PATH = 'astroix-runtime/control-plane/child.js';
/**
 * The module-type marker: the rebased entry is ESM by import syntax, and
 * the packaged `Contents/Resources` tree has no ancestor package.json —
 * the child cannot load without this marker, so the verifier requires it
 * as a layout fact, not an assembly nicety.
 */
export const MODULE_TYPE_MARKER_RESOURCE_PATH = 'astroix-runtime/package.json';
/** The build manifest — the inventory the app verifies before any spawn. */
export const BUILD_MANIFEST_RESOURCE_PATH = 'astroix-runtime/build-manifest.json';

/**
 * One relative resource id — a posix relative path whose segments are
 * file-name-safe (`.`/`..`-free by first-character class, no absolute
 * form, no backslash): the shape containment is provable over.
 */
const RESOURCE_PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/** Lower-case hex SHA-256. */
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** A git commit sha (the manifest's `sourceCommit`). */
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/**
 * The containment join: validates the resource id's shape, then resolves
 * it under the resources root. `null` means the id escapes (or is not a
 * resource id at all) — the caller fails closed, never guesses.
 */
export function resourceAbsolutePath(resourcesRoot: string, resourcePath: string): string | null {
  if (!RESOURCE_PATH_PATTERN.test(resourcePath)) return null;
  const absolute = resolve(join(resolve(resourcesRoot), resourcePath));
  const root = resolve(resourcesRoot);
  // the validated shape cannot produce `..` segments, so this is the
  // belt-and-braces half: the resolved path must sit under the root
  return absolute === root || absolute.startsWith(`${root}${sep}`) ? absolute : null;
}

// ——— the pin table ———

/** The exact stock Node pin — the kernel lease's qualified pin, one source of truth (#209). */
export const PACKAGED_NODE_PIN: string = QUALIFIED_NODE_VERSION;
/** The exact Electron pin (ADR-0008; the installed dev dependency mirrors it). */
export const PACKAGED_ELECTRON_PIN = '44.1.0';
/** The exact Electron Forge pin (ADR-0008; the Forge wiring is H3 #245). */
export const PACKAGED_FORGE_PIN = '7.11.2';

/** The one certified Astro/Vite pair a packaged runtime is assembled against (ADR-0005). */
export const PACKAGED_CERTIFIED_PAIR: ExactPair = requireCertifiedPair();

function requireCertifiedPair(): ExactPair {
  const pair = CERTIFIED_PAIRS[0];
  if (pair === undefined) {
    throw new Error('packaged-assets: no certified pair exists to pin a manifest against');
  }
  return pair;
}

// ——— the build manifest ———

/** One inventoried immutable resource: content-addressed by SHA-256. */
const manifestResourceSchema = z.strictObject({
  path: z.string().regex(RESOURCE_PATH_PATTERN),
  sha256: z.string().regex(SHA256_PATTERN),
  bytes: z.number().int().nonnegative(),
  executable: z.boolean(),
});

/** The build manifest: ADR-0008's record of source commit, architecture, pins, inventory, hashes. */
export const buildManifestSchema = z.strictObject({
  schema: z.literal(1),
  sourceCommit: z.string().regex(COMMIT_PATTERN),
  architecture: z.string().min(1),
  electron: z.string().min(1),
  forge: z.string().min(1),
  node: z.string().min(1),
  pair: z.strictObject({ astro: z.string().min(1), vite: z.string().min(1) }),
  resources: z.array(manifestResourceSchema).min(1),
});

/** The parsed build manifest (the schema's own shape). */
export type BuildManifest = z.infer<typeof buildManifestSchema>;

/** One inventoried resource, as the assembler reports it. */
export interface ManifestResourceFacts {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly executable: boolean;
}

/** What the assembler supplies: the source commit, the target architecture, and the hashed inventory. */
export interface BuildManifestInput {
  readonly sourceCommit: string;
  readonly architecture: string;
  readonly resources: readonly ManifestResourceFacts[];
}

/**
 * Builds one manifest from assembly facts: the pin table fills every
 * pinned field (a manifest never records an unpinned value), and the
 * inventory is sorted by resource id so identical inputs build identical
 * manifests. Throws on facts the schema would reject — the assembler is
 * upstream of correctness, never downstream of a bad manifest.
 */
export function buildManifest(input: BuildManifestInput): BuildManifest {
  const resources = [...input.resources]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((facts) => ({
      bytes: facts.bytes,
      executable: facts.executable,
      path: facts.path,
      sha256: facts.sha256,
    }));
  const manifest: BuildManifest = {
    schema: 1,
    sourceCommit: input.sourceCommit,
    architecture: input.architecture,
    electron: PACKAGED_ELECTRON_PIN,
    forge: PACKAGED_FORGE_PIN,
    node: PACKAGED_NODE_PIN,
    pair: { astro: PACKAGED_CERTIFIED_PAIR.astro, vite: PACKAGED_CERTIFIED_PAIR.vite },
    resources,
  };
  const parsed = buildManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    throw new Error(
      `packaged-assets: assembly facts do not form a manifest (${parsed.error.message})`,
    );
  }
  return manifest;
}

/**
 * The manifest's byte form: fixed alphabetical key order, two-space
 * indent, one trailing newline — same input, same bytes, always.
 */
export function serializeManifest(manifest: BuildManifest): string {
  const ordered = {
    architecture: manifest.architecture,
    electron: manifest.electron,
    forge: manifest.forge,
    node: manifest.node,
    pair: { astro: manifest.pair.astro, vite: manifest.pair.vite },
    resources: manifest.resources.map((resource) => ({
      bytes: resource.bytes,
      executable: resource.executable,
      path: resource.path,
      sha256: resource.sha256,
    })),
    schema: manifest.schema,
    sourceCommit: manifest.sourceCommit,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

// ——— verification ———

/** Why packaged resource verification failed — sanitized, never a path or hash. */
export type PackagedAssetFailureCode =
  | 'manifest-missing'
  | 'manifest-unreadable'
  | 'manifest-invalid'
  | 'pin-mismatch'
  | 'layout-missing'
  | 'layout-unlisted'
  | 'resource-escape'
  | 'resource-missing'
  | 'resource-inaccessible'
  | 'resource-symlink'
  | 'resource-type'
  | 'executable-not-executable'
  | 'resource-tampered';

/** One sanitized verification rejection: a code, the relative resource id, and pin-level detail only. */
export interface PackagedAssetFailure {
  readonly code: PackagedAssetFailureCode;
  /** The relative resource id the failure names — never an absolute packaged path. */
  readonly resource?: string;
  /** Pin-level detail (field and the declared/expected versions) — version strings, never paths. */
  readonly detail?: Readonly<Record<string, string>>;
}

/** The verified packaged assets — the resolved absolute spawn ingredients (internal, never public). */
export interface PackagedAssets {
  /** The bundled stock Node executable — the absolute executable every runtime spawn uses. */
  readonly nodeExecutable: string;
  /** The rebased control-plane child entry (plain ECMAScript). */
  readonly controlPlaneEntry: string;
  /** Node CLI flags before the entry — none: the packaged entry needs no dev loaders. */
  readonly execArgv: readonly string[];
}

/** What the app brings to verification: its resources root and its own runtime identity. */
export interface VerifyPackagedAssetsInput {
  readonly resourcesRoot: string;
  /** The running host's architecture (`process.arch`) the manifest must match. */
  readonly architecture: string;
  /** The running Electron's version the manifest must match. */
  readonly electronVersion: string;
}

/** A bound on the manifest read — an oversized manifest is drift, not an inventory. */
const MAX_MANIFEST_BYTES = 1 << 20;

/**
 * Verifies every immutable packaged resource against the build manifest
 * and resolves the spawn ingredients. The one entry the app calls before
 * private boot or project activation; every failure is a sanitized
 * {@link PackagedAssetFailure} — there is no fallback resolution, ever.
 */
export async function verifyPackagedAssets(
  input: VerifyPackagedAssetsInput,
): Promise<PackagedAssets | PackagedAssetFailure> {
  const manifestOutcome = await readManifest(input.resourcesRoot);
  if ('failure' in manifestOutcome) return manifestOutcome.failure;
  const manifest = manifestOutcome.manifest;

  const pinFailure = checkPins(manifest, input);
  if (pinFailure !== null) return pinFailure;

  const layoutFailure = checkRequiredLayout(manifest);
  if (layoutFailure !== null) return layoutFailure;

  for (const resource of manifest.resources) {
    const failure = await verifyResource(input.resourcesRoot, resource);
    if (failure !== null) return failure;
  }

  const unlistedFailure = await verifyInventoryCompleteness(input.resourcesRoot, manifest);
  if (unlistedFailure !== null) return unlistedFailure;

  const nodeExecutable = resourceAbsolutePath(input.resourcesRoot, NODE_EXECUTABLE_RESOURCE_PATH);
  const controlPlaneEntry = resourceAbsolutePath(
    input.resourcesRoot,
    CONTROL_PLANE_ENTRY_RESOURCE_PATH,
  );
  // checkRequiredLayout already proved both ids are inventoried, and the
  // ids are this module's own validated constants — this cannot trip
  if (nodeExecutable === null || controlPlaneEntry === null) {
    return { code: 'layout-missing' };
  }
  return { nodeExecutable, controlPlaneEntry, execArgv: [] };
}

/**
 * Reads and parses the build manifest; IO/JSON/schema failures stay distinct and sanitized.
 * The manifest leaf itself sits under the same symlink/type/nlink policy as
 * every inventoried resource — the trust anchor of the whole verification
 * is never the one file exempt from it: a symlinked, non-regular, or
 * hard-linked manifest rejects before a byte of it is parsed (a hostile
 * or drifted manifest never gets to speak).
 */
async function readManifest(
  resourcesRoot: string,
): Promise<{ manifest: BuildManifest } | { failure: PackagedAssetFailure }> {
  const manifestPath = resourceAbsolutePath(resourcesRoot, BUILD_MANIFEST_RESOURCE_PATH);
  if (manifestPath === null) {
    return { failure: { code: 'resource-escape', resource: BUILD_MANIFEST_RESOURCE_PATH } };
  }
  const leaf = await lstatSafe(manifestPath);
  if (typeof leaf === 'string') {
    return {
      failure: {
        code: leaf === 'resource-missing' ? 'manifest-missing' : 'resource-inaccessible',
        resource: BUILD_MANIFEST_RESOURCE_PATH,
      },
    };
  }
  if (leaf.isSymbolicLink()) {
    return { failure: { code: 'resource-symlink', resource: BUILD_MANIFEST_RESOURCE_PATH } };
  }
  if (!leaf.isFile() || leaf.nlink !== 1) {
    return { failure: { code: 'resource-type', resource: BUILD_MANIFEST_RESOURCE_PATH } };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(manifestPath);
  } catch (error) {
    // The same missing/inaccessible split the leaf lstat above already
    // made for this file: a mode-0o000 manifest leaf stats fine (nothing
    // above reads the mode bits) and then fails to open — an operator
    // told "missing" hunts a lost file instead of permissions.
    const code = (error as NodeJS.ErrnoException).code;
    return {
      failure: {
        code:
          code === 'ENOENT' || code === 'ENOTDIR' ? 'manifest-missing' : 'resource-inaccessible',
        resource: BUILD_MANIFEST_RESOURCE_PATH,
      },
    };
  }
  if (bytes.byteLength > MAX_MANIFEST_BYTES) {
    return { failure: { code: 'manifest-invalid', resource: BUILD_MANIFEST_RESOURCE_PATH } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { failure: { code: 'manifest-unreadable', resource: BUILD_MANIFEST_RESOURCE_PATH } };
  }
  const manifest = buildManifestSchema.safeParse(parsed);
  if (!manifest.success) {
    return { failure: { code: 'manifest-invalid', resource: BUILD_MANIFEST_RESOURCE_PATH } };
  }
  return { manifest: manifest.data };
}

/** The manifest must record the pin table exactly and match the running host's own identity. */
function checkPins(
  manifest: BuildManifest,
  input: VerifyPackagedAssetsInput,
): PackagedAssetFailure | null {
  const declared: ReadonlyArray<[field: string, declared: string, expected: string]> = [
    ['node', manifest.node, PACKAGED_NODE_PIN],
    ['electron', manifest.electron, PACKAGED_ELECTRON_PIN],
    ['electron-running', manifest.electron, input.electronVersion],
    ['forge', manifest.forge, PACKAGED_FORGE_PIN],
    ['architecture', manifest.architecture, input.architecture],
  ];
  for (const [field, value, expected] of declared) {
    if (value !== expected) return pinFailure(field, value, expected);
  }
  if (!isCertifiedPair(manifest.pair)) {
    return pinFailure(
      'pair',
      `${manifest.pair.astro} + ${manifest.pair.vite}`,
      'the certified pair',
    );
  }
  return null;
}

function pinFailure(field: string, declaredValue: string, expected: string): PackagedAssetFailure {
  return {
    code: 'pin-mismatch',
    detail: { field, declared: declaredValue, expected },
  };
}

/**
 * The manifest must inventory the three required layout facts — the Node
 * executable (marked executable), the rebased entry, and the module-type
 * marker the packaged child cannot load without (a manifest omitting the
 * marker would verify green and die later at ESM load; the verifier owns
 * that failure, not the boot).
 */
function checkRequiredLayout(manifest: BuildManifest): PackagedAssetFailure | null {
  const inventoried = new Map(manifest.resources.map((resource) => [resource.path, resource]));
  const nodeExecutable = inventoried.get(NODE_EXECUTABLE_RESOURCE_PATH);
  if (nodeExecutable === undefined) {
    return { code: 'layout-missing', resource: NODE_EXECUTABLE_RESOURCE_PATH };
  }
  if (!nodeExecutable.executable) {
    return { code: 'executable-not-executable', resource: NODE_EXECUTABLE_RESOURCE_PATH };
  }
  if (!inventoried.has(CONTROL_PLANE_ENTRY_RESOURCE_PATH)) {
    return { code: 'layout-missing', resource: CONTROL_PLANE_ENTRY_RESOURCE_PATH };
  }
  if (!inventoried.has(MODULE_TYPE_MARKER_RESOURCE_PATH)) {
    return { code: 'layout-missing', resource: MODULE_TYPE_MARKER_RESOURCE_PATH };
  }
  return null;
}

/** One inventoried resource as the manifest carries it. */
type ManifestResource = BuildManifest['resources'][number];

/**
 * Verifies one inventoried resource: ancestry, leaf type, symlink and
 * hard-link policy, exec bit, size, hash. Every IO failure stays inside
 * the sanitized vocabulary — including the hash read itself: a leaf that
 * `lstat`s fine but cannot be opened (mode 0o000 under a searchable
 * directory) or that vanishes between the stat and the open rejects as a
 * coded failure, never as a thrown error whose message would carry the
 * absolute path into a public surface.
 */
async function verifyResource(
  resourcesRoot: string,
  resource: ManifestResource,
): Promise<PackagedAssetFailure | null> {
  const absolute = resourceAbsolutePath(resourcesRoot, resource.path);
  // The resource-escape arm here is dead by construction and stays that
  // way on purpose: the manifest schema's path pattern and this
  // containment check share one escape definition (the same regex
  // validates the id before the join), so a manifest row cannot name an
  // escaping path. The branch is the belt to the schema's braces — if
  // the two patterns ever diverge, this closes the gap instead of
  // trusting the parser (the E6 weighed-not-raised precedent).
  if (absolute === null) return { code: 'resource-escape', resource: resource.path };

  const ancestry = await verifyAncestry(resourcesRoot, resource.path);
  if (ancestry !== null) return ancestry;

  const leaf = await lstatSafe(absolute);
  if (typeof leaf === 'string') return { code: leaf, resource: resource.path };
  if (leaf.isSymbolicLink()) return { code: 'resource-symlink', resource: resource.path };
  if (!leaf.isFile()) return { code: 'resource-type', resource: resource.path };
  if (leaf.nlink !== 1) return { code: 'resource-type', resource: resource.path };
  if (resource.executable && (leaf.mode & 0o111) === 0) {
    return { code: 'executable-not-executable', resource: resource.path };
  }
  if (leaf.size !== resource.bytes) return { code: 'resource-tampered', resource: resource.path };
  const hashed = await sha256FileSanitized(absolute);
  if (typeof hashed === 'string') return { code: hashed, resource: resource.path };
  if (hashed.value !== resource.sha256) {
    return { code: 'resource-tampered', resource: resource.path };
  }
  return null;
}

/**
 * The hash read with the failure vocabulary: an open/read error at hash
 * time — EACCES on a mode-0o000 leaf `lstat` could still stat, a file
 * gone between the stat and the open — is a sanitized coded failure,
 * never a thrown message carrying the absolute path.
 */
async function sha256FileSanitized(
  absolute: string,
): Promise<{ value: string } | 'resource-missing' | 'resource-inaccessible'> {
  try {
    return { value: await sha256File(absolute) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'resource-missing' : 'resource-inaccessible';
  }
}

/**
 * The symlink policy on intermediate directories: every directory from
 * the resources root down to the resource must be a real directory — a
 * symlinked hop is how a regular-looking leaf would resolve outside the
 * root, so it rejects before the leaf is even read.
 */
async function verifyAncestry(
  resourcesRoot: string,
  resourcePath: string,
): Promise<PackagedAssetFailure | null> {
  const segments = resourcePath.split('/');
  let current = resolve(resourcesRoot);
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    const stat = await lstatSafe(current);
    if (typeof stat === 'string') return { code: stat, resource: resourcePath };
    if (stat.isSymbolicLink()) return { code: 'resource-symlink', resource: resourcePath };
    if (!stat.isDirectory()) return { code: 'resource-type', resource: resourcePath };
  }
  return null;
}

/**
 * The inventory is complete in the other direction too: the two ratified
 * subtrees hold EXACTLY the inventoried files (plus the manifest, which
 * never inventories itself). A file on disk that no manifest names —
 * dropped in, swapped in, or left behind — is drift a verifier must own,
 * not a silent extra the spawn might later load; symlinks among the
 * unlisted die here as well (an inventoried symlink already died in
 * {@link verifyResource}). A subtree the walk cannot even list rejects
 * as inaccessible — only a MISSING subtree is left to the required-fact
 * checks above (every inventoried file under it already died there).
 */
async function verifyInventoryCompleteness(
  resourcesRoot: string,
  manifest: BuildManifest,
): Promise<PackagedAssetFailure | null> {
  const inventoried = new Set(manifest.resources.map((resource) => resource.path));
  for (const subtree of [RUNTIME_RESOURCE_DIR, NODE_RESOURCE_DIR]) {
    const failure = await walkForUnlisted(resourcesRoot, subtree, inventoried);
    if (failure !== null) return failure;
  }
  return null;
}

/** One subtree walk: recurses real directories, rejects any non-inventoried entry (the manifest excepted). */
async function walkForUnlisted(
  resourcesRoot: string,
  directoryPath: string,
  inventoried: ReadonlySet<string>,
): Promise<PackagedAssetFailure | null> {
  const directory = resourceAbsolutePath(resourcesRoot, directoryPath);
  // directoryPath is this module's own constant or built from readdir names
  // under a constant — this cannot trip; failing closed regardless
  if (directory === null) return { code: 'layout-missing', resource: directoryPath };
  let entries: ReadonlyArray<Dirent>;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    // A MISSING subtree is owned elsewhere: every inventoried file under
    // it already died in the per-resource loop, and a subtree holding no
    // inventoried resource names nothing the required facts check. An
    // UNREADABLE subtree is owned by nobody else — a directory this walk
    // cannot list is exactly where unlisted files would ride along
    // silently, so it rejects here. The lstatSafe split, one function
    // up: ENOENT/ENOTDIR is absence, anything else is inaccessibility.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    return { code: 'resource-inaccessible', resource: directoryPath };
  }
  for (const entry of entries) {
    const entryPath = `${directoryPath}/${entry.name}`;
    if (entry.isDirectory()) {
      const nested = await walkForUnlisted(resourcesRoot, entryPath, inventoried);
      if (nested !== null) return nested;
      continue;
    }
    if (entryPath !== BUILD_MANIFEST_RESOURCE_PATH && !inventoried.has(entryPath)) {
      return { code: 'layout-unlisted', resource: entryPath };
    }
  }
  return null;
}

/** lstat with the failure vocabulary: missing vs inaccessible, never a thrown path. */
async function lstatSafe(absolute: string): Promise<
  | {
      isSymbolicLink(): boolean;
      isFile(): boolean;
      isDirectory(): boolean;
      nlink: number;
      size: number;
      mode: number;
    }
  | 'resource-missing'
  | 'resource-inaccessible'
> {
  try {
    return await lstat(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'resource-missing' : 'resource-inaccessible';
  }
}

/** The streamed SHA-256 of one file — the Node executable is ~100 MB, so the hash never buffers it whole. */
async function sha256File(absolute: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(absolute)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}
