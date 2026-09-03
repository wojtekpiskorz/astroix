/**
 * The fresh nonpersistent editing partition (#247, H5; ADR-0009 "the
 * authoritative BrowserWindow and its same-origin canvas are created in
 * a fresh non-persistent Electron partition"): mints the partition
 * identity each authoritative editing target is created in. Electron's
 * law this module encodes: a partition name WITHOUT the `persist:`
 * prefix is an in-memory session — no cookie jar, no storage, no
 * Service Worker registrations survive the session object's death — so
 * every authoritative editing target starts with storage that no
 * previous target (and no previously registered Service Worker) ever
 * touched.
 *
 * The freshness law is uniqueness, minted never-reused: a minter that
 * hands out one name twice has silently aliased two editing targets
 * into one partition, so a collision refuses (fail closed) instead.
 * A persistent partition is refused outright — the ticket's bounded
 * solution names it: never a persistent partition for the editing
 * target.
 *
 * Electron-free: the composition passes the minted name to
 * `session.fromPartition(name)` and the window's `webPreferences.partition`;
 * the real-partition truth is the `e2e/desktop` lane.
 */

/** The prefix of every editing partition name — never `persist:`-prefixed. */
export const EDITING_PARTITION_PREFIX = 'astroix-editing-';

/** One minted partition identity — nonpersistent by construction. */
export interface EditingPartition {
  /** The partition name handed to `session.fromPartition` / `webPreferences.partition`. */
  readonly name: string;
  /** Always false — the type carries the nonpersistent law. */
  readonly persistent: false;
}

/** Mints fresh partition identities — one per authoritative editing target. */
export interface EditingPartitionMinter {
  /** Mints the next never-before-used partition name; a collision refuses (fail closed). */
  mint(): EditingPartition;
  /** Every minted name, in mint order (evidence for the focused lanes). */
  minted(): readonly string[];
}

/** True when a partition name is nonpersistent under Electron's naming law. */
export function isNonPersistentPartitionName(name: string): boolean {
  return !name.startsWith('persist:');
}

/**
 * Wraps a caller-supplied name as an editing partition identity,
 * refusing persistent names fail-closed. The product path always mints
 * (`createEditingPartitionMinter`); this exists for the composition's
 * tests and diagnostics that must address an EXISTING partition by name.
 */
export function editingPartitionFromName(name: string): EditingPartition {
  if (!isNonPersistentPartitionName(name)) {
    throw new Error(
      `editing-partition: refusing a persistent partition for an editing target (name begins with "persist:")`,
    );
  }
  return { name, persistent: false };
}

/**
 * Builds the minter over an injected entropy source (the composition
 * passes crypto-grade randomness; the units pin the laws with
 * deterministic sources). One mint per authoritative editing target.
 */
export function createEditingPartitionMinter(randomSuffix: () => string): EditingPartitionMinter {
  const minted: string[] = [];
  return {
    mint: () => {
      const name = `${EDITING_PARTITION_PREFIX}${randomSuffix()}`;
      if (minted.includes(name)) {
        // Never silently alias two editing targets into one partition.
        throw new Error(
          `editing-partition: the entropy source repeated a partition suffix — refusing to reuse a partition`,
        );
      }
      minted.push(name);
      return { name, persistent: false };
    },
    minted: () => [...minted],
  };
}
