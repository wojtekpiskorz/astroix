import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The candidate-comparison manifest (#245, H3; ADR-0008 minimal
 * qualification): the normalized payload inventory and immutable hashes
 * two clean builds are compared by, plus the artifact checksum data the
 * L1/L2 qualification lanes consume.
 *
 * The comparison contract, exactly as ADR-0008 states it — "compares two
 * clean builds by normalized payload inventory and immutable hashes;
 * version 1 makes no byte-identical-ZIP claim":
 *
 * - **Normalized payload inventory** — every file in the `.app`, keyed by
 *   its bundle-relative posix path and sorted: same path set, same
 *   sizes, same executable bits. Two clean builds MUST produce
 *   identical inventories.
 * - **Immutable hashes** — the SHA-256 of every file whose bytes the
 *   build does not legitimately vary: the asar payload, the `Info.plist`
 *   files, and the immutable runtime resources under
 *   `Contents/Resources/`. Files whose bytes embed an ad-hoc code
 *   signature (every Mach-O the pipeline re-signs, and the
 *   `_CodeSignature` seals) are classified `sealed`: present in the
 *   inventory, deliberately OUTSIDE the byte-identity claim.
 * - **ZIP bytes** — recorded (name, bytes, SHA-256) as checksum data for
 *   later exact-candidate comparison, never compared for equality: the
 *   ZIP is not claimed reproducible.
 */

/** How one payload file participates in the two-build comparison. */
export type PayloadClass = 'immutable' | 'sealed';

/** One inventoried payload file. */
export interface PayloadEntry {
  /** Bundle-relative posix path (`Contents/Resources/node/bin/node`). */
  readonly path: string;
  readonly bytes: number;
  readonly executable: boolean;
  readonly sha256: string;
  readonly class: PayloadClass;
}

/** The candidate manifest a package run emits. */
export interface CandidateManifest {
  readonly schema: 1;
  readonly product: string;
  readonly version: string;
  readonly platform: 'darwin';
  readonly arch: 'arm64';
  readonly sourceCommit: string;
  readonly electron: string;
  readonly forge: string;
  readonly node: string;
  readonly minimumSystemVersion: string;
  readonly fuseStates: Readonly<Record<string, string>>;
  /** The ZIP artifact facts — checksum data, never a byte-identity claim. */
  readonly zip: { readonly file: string; readonly bytes: number; readonly sha256: string };
  readonly payload: readonly PayloadEntry[];
}

/** The two-manifest comparison verdict. */
export interface CandidateComparison {
  readonly inventoriesMatch: boolean;
  readonly immutableHashesMatch: boolean;
  readonly identityMatches: boolean;
  /** Inventory rows that differ (path, size, or executable bit). */
  readonly inventoryDiffs: readonly string[];
  /** Immutable rows whose SHA-256 differs. */
  readonly immutableHashDiffs: readonly string[];
  /** Identity fields (commit, pins, fuses) that differ. */
  readonly identityDiffs: readonly string[];
}

/**
 * Classifies one bundle-relative payload path for the comparison. Pure
 * and shared by the walker: `_CodeSignature` seal directories and the
 * loose Mach-O executables the pipeline re-signs are `sealed`; every
 * other file is `immutable` (its bytes are the build's own content).
 */
export function classifyPayload(relPath: string, isMachO: boolean): PayloadClass {
  if (isMachO) return 'sealed';
  return relPath.split('/').includes('_CodeSignature') ? 'sealed' : 'immutable';
}

/** The facts the manifest builder needs besides the walked payload. */
export interface CandidateManifestInput {
  readonly product: string;
  readonly version: string;
  readonly sourceCommit: string;
  readonly electron: string;
  readonly forge: string;
  readonly node: string;
  readonly minimumSystemVersion: string;
  readonly fuseStates: Readonly<Record<string, string>>;
  readonly zip: { readonly file: string; readonly bytes: number; readonly sha256: string };
  readonly payload: readonly PayloadEntry[];
}

/** Builds the manifest with its payload normalized (sorted by path) for comparison. */
export function buildCandidateManifest(input: CandidateManifestInput): CandidateManifest {
  const payload = [...input.payload].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  return {
    schema: 1,
    product: input.product,
    version: input.version,
    platform: 'darwin',
    arch: 'arm64',
    sourceCommit: input.sourceCommit,
    electron: input.electron,
    forge: input.forge,
    node: input.node,
    minimumSystemVersion: input.minimumSystemVersion,
    fuseStates: input.fuseStates,
    zip: input.zip,
    payload,
  };
}

/** The manifest's byte form: fixed key order, two-space indent, one trailing newline. */
export function serializeCandidateManifest(manifest: CandidateManifest): string {
  const ordered = {
    schema: manifest.schema,
    product: manifest.product,
    version: manifest.version,
    platform: manifest.platform,
    arch: manifest.arch,
    sourceCommit: manifest.sourceCommit,
    electron: manifest.electron,
    forge: manifest.forge,
    node: manifest.node,
    minimumSystemVersion: manifest.minimumSystemVersion,
    fuseStates: manifest.fuseStates,
    zip: manifest.zip,
    payload: manifest.payload.map((entry) => ({
      path: entry.path,
      bytes: entry.bytes,
      executable: entry.executable,
      sha256: entry.sha256,
      class: entry.class,
    })),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * Walks the packaged `.app` and inventories every regular file: path,
 * size, executable bit, SHA-256 (streamed — the payload is hundreds of
 * megabytes), and comparison class. Mach-O detection is injected so the
 * walk stays deterministic in tests (fake executables by path decision).
 */
export async function buildPayloadInventory(
  appPath: string,
  isMachO: (relPath: string) => Promise<boolean>,
): Promise<PayloadEntry[]> {
  const entries: PayloadEntry[] = [];
  await walkPayload(appPath, '', entries, isMachO);
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The two-build comparison: identical inventories (path set, sizes,
 * executable bits) and identical immutable hashes, with every difference
 * named. Sealed rows are compared for inventory facts only — their
 * bytes are outside the claim by design. ZIP bytes are never compared.
 */
export function compareCandidateManifests(
  a: CandidateManifest,
  b: CandidateManifest,
): CandidateComparison {
  const inventoryDiffs: string[] = [];
  const immutableHashDiffs: string[] = [];
  const rowsA = new Map(a.payload.map((entry) => [entry.path, entry]));
  const rowsB = new Map(b.payload.map((entry) => [entry.path, entry]));
  for (const path of new Set([...rowsA.keys(), ...rowsB.keys()])) {
    const rowA = rowsA.get(path);
    const rowB = rowsB.get(path);
    if (rowA === undefined || rowB === undefined) {
      inventoryDiffs.push(`${path}: ${rowA === undefined ? 'missing in A' : 'missing in B'}`);
      continue;
    }
    if (rowA.bytes !== rowB.bytes || rowA.executable !== rowB.executable) {
      inventoryDiffs.push(
        `${path}: ${rowA.bytes}/${rowA.executable} vs ${rowB.bytes}/${rowB.executable}`,
      );
    }
    if (rowA.class === 'immutable' && rowA.sha256 !== rowB.sha256) {
      immutableHashDiffs.push(path);
    }
  }
  const identityDiffs: string[] = [];
  const identities: ReadonlyArray<readonly [string, string, string]> = [
    ['sourceCommit', a.sourceCommit, b.sourceCommit],
    ['electron', a.electron, b.electron],
    ['forge', a.forge, b.forge],
    ['node', a.node, b.node],
    ['minimumSystemVersion', a.minimumSystemVersion, b.minimumSystemVersion],
    ['fuseStates', JSON.stringify(a.fuseStates), JSON.stringify(b.fuseStates)],
  ];
  for (const [field, valueA, valueB] of identities) {
    if (valueA !== valueB) identityDiffs.push(`${field}: ${valueA} vs ${valueB}`);
  }
  return {
    inventoriesMatch: inventoryDiffs.length === 0,
    immutableHashesMatch: immutableHashDiffs.length === 0,
    identityMatches: identityDiffs.length === 0,
    inventoryDiffs,
    immutableHashDiffs,
    identityDiffs,
  };
}

/** The streamed SHA-256 of one file — payload files are large, never buffered whole. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

async function walkPayload(
  root: string,
  relPath: string,
  entries: PayloadEntry[],
  isMachO: (relPath: string) => Promise<boolean>,
): Promise<void> {
  const children = await readdir(join(root, ...relPath.split('/').filter(Boolean)), {
    withFileTypes: true,
  });
  for (const child of children) {
    const childRel = relPath === '' ? child.name : `${relPath}/${child.name}`;
    if (child.isDirectory()) {
      await walkPayload(root, childRel, entries, isMachO);
      continue;
    }
    if (!child.isFile()) continue; // symlinks and specials: the packaged tree has none; skipped, not invented
    const absolute = join(root, ...childRel.split('/'));
    const info = await stat(absolute);
    entries.push({
      path: childRel,
      bytes: info.size,
      executable: (info.mode & 0o111) !== 0,
      sha256: await sha256File(absolute),
      class: classifyPayload(childRel, await isMachO(childRel)),
    });
  }
}
