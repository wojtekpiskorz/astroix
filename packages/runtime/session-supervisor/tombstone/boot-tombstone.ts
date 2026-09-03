import type { ProjectKey } from '@wojciechpiskorz/astroix-protocol';
import type { SupervisionCloseReport } from '../../project-plane/supervision/close-report.ts';
import {
  classifyTombstoneDocument,
  TOMBSTONE_SCHEMA_VERSION,
  type TombstoneRecord,
  tombstoneDocumentSchema,
} from './tombstone-document.ts';
import type { TombstoneStore } from './tombstone-store.ts';

// The seam entry's own contract (the #305 re-export idiom): a consumer of
// `session-supervisor/tombstone` names the whole public vocabulary — the
// record, the admission verdicts, the lease proof, the recovery outcome —
// without reaching around the exports map.
export {
  classifyTombstoneDocument,
  TOMBSTONE_SCHEMA_VERSION,
  type TombstoneClassification,
  type TombstoneDocument,
  type TombstoneRecord,
  type TombstoneUnusableReason,
  tombstoneDocumentSchema,
} from './tombstone-document.ts';
export { openTombstoneStore, TOMBSTONE_FILE, type TombstoneStore } from './tombstone-store.ts';

/**
 * The boot-scoped incomplete-cleanup tombstone (#239, F7; ADR-0006 §4
 * step 4 and §8 — the machine behind "the boot-scoped tombstone survives
 * relaunch"): the durable record an incomplete forced reap leaves
 * standing, the activation gate it blocks, and the two structural ways it
 * clears.
 *
 * The laws this machine holds:
 *
 * - **Boot-scoped by injected token**: the machine-boot identity is an
 *   opaque scoped token the host composition injects (`bootScope` — the
 *   host lanes carry the real machine boot id; a fresh token cannot
 *   equal a previous boot's). Staleness is therefore BY CONSTRUCTION: a
 *   persisted token that does not equal the live one can only be from a
 *   later machine boot, so clearing it is a scope comparison — never a
 *   clock, never process liveness.
 * - **Same-boot blocking**: while a tombstone with the LIVE boot's scope
 *   stands, activation is refused. The only recovery is the exclusive
 *   edit-writer-lease acquisition proof (the D3 kernel-lease vocabulary,
 *   CONTEXT.md "kernel lease": successful exclusive acquisition is the
 *   only same-boot proof no live holder remains): the injected
 *   {@link EditLeaseAcquisition} seam resolves `exclusive` only when no
 *   old executor retains the lease, and only that proof clears.
 * - **The persisted PID is never cleanup authority** (§8, the AC's law):
 *   `recordedPid` is recorded diagnostic evidence — no decision path in
 *   this machine reads it, so a matching live PID authorizes nothing
 *   (pinned by the focused tests: a same-boot tombstone whose recorded
 *   PID is alive AND matches stays blocked until the lease proof).
 * - **Fail-closed on unreadable bytes**: a tombstone that cannot be
 *   parsed cannot prove its scope, so it blocks exactly like a live
 *   one — the lease proof (which needs no parsing) is its only
 *   clearing, and a later boot with an unparseable scope cannot be
 *   proven stale, so it blocks too. No guessing, no auto-clear.
 *
 * Deterministic by construction: the one external dependency — the
 * exclusive-lease probe — is an injected seam; the store is real
 * filesystem IO over an injected directory (the registry-store
 * discipline), deterministic in the focused tests over temp directories.
 */
/** What one incomplete reap records — the machine adds its own boot scope. */
export interface IncompleteReapRecordInput {
  readonly projectKey: ProjectKey;
  /** Recorded diagnostic evidence ONLY — never cleanup authority (§8). */
  readonly recordedPid: number | null;
  /** The supervisor's reap accounting as observed at record time; `null` when none had arrived. */
  readonly closeReport: SupervisionCloseReport | null;
}

/**
 * The D3 kernel-lease vocabulary as this machine consumes it: the proof
 * seam whose production composition attempts the exclusive edit-writer
 * acquisition (a disposable probe — process exit is the lease's release
 * boundary, so the probe acquires, reports, and exits). `exclusive` is
 * the only same-boot proof no live executor remains; `contended` means a
 * live holder still owns the lease.
 */
export type EditLeaseAcquisition = () => Promise<EditLeaseProof>;

export type EditLeaseProof = { readonly kind: 'exclusive' } | { readonly kind: 'contended' };

/** The activation gate's answer (§8: "activation stays blocked until …"). */
export type ActivationAdmission =
  | {
      readonly kind: 'admitted';
      /** A tombstone from a later-boot-writable scope was cleared by construction on this admission. */
      readonly clearedStaleTombstone: boolean;
    }
  | {
      readonly kind: 'blocked';
      /** A live same-boot tombstone, or bytes whose scope cannot be proven (fail closed). */
      readonly reason: 'incomplete-cleanup-tombstone' | 'tombstone-unreadable';
    };

/** The recovery attempt's answer. */
export type LeaseRecoveryOutcome =
  /** The exclusive acquisition proved no live executor remains (or nothing stood) — cleared. */
  | { readonly kind: 'recovered' }
  /** The lease is held: a live executor remains — still blocked. */
  | { readonly kind: 'still-blocked' };

/** The tombstone machine's surface. */
export interface BootTombstone {
  /** Persists the boot-scoped tombstone — the durable-first step of the incomplete-reap aftermath. */
  recordIncompleteReap(record: IncompleteReapRecordInput): Promise<void>;
  /** The activation gate: admitted (clearing a stale-by-construction record), or blocked. */
  admitActivation(): Promise<ActivationAdmission>;
  /** The only same-boot recovery: the exclusive edit-writer-lease acquisition proof. */
  recoverByLeaseProof(): Promise<LeaseRecoveryOutcome>;
}

/** Construction options — the store, the boot scope token, and the lease-proof seam. */
export interface BootTombstoneOptions {
  readonly store: TombstoneStore;
  /** The machine-boot identity token the host injected — the whole staleness discipline's key. */
  readonly bootScope: string;
  /** The exclusive edit-writer-lease acquisition probe (D3 vocabulary; the host/integration lane wires the real probe). */
  readonly acquireExclusiveEditLease: EditLeaseAcquisition;
}

/** What a read found: absent, unusable bytes, or the record. */
type TombstoneRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'present'; readonly record: TombstoneRecord };

/** Builds the boot-scoped tombstone machine. */
export function createBootTombstone(options: BootTombstoneOptions): BootTombstone {
  const readCurrent = async (): Promise<TombstoneRead> => {
    const text = await options.store.read();
    if (text === null) return { kind: 'absent' };
    const classified = classifyTombstoneDocument(text);
    if (classified.status !== 'ok') return { kind: 'unreadable' };
    return { kind: 'present', record: classified.document.tombstone };
  };

  /** The stale-by-construction test — a scope token that cannot match this boot. */
  const isStale = (record: TombstoneRecord): boolean => record.bootScope !== options.bootScope;

  /** The proof-and-clear tail: the lease decides; only exclusivity clears. */
  const proveAndClear = async (): Promise<LeaseRecoveryOutcome> => {
    const proof = await options.acquireExclusiveEditLease();
    if (proof.kind !== 'exclusive') return { kind: 'still-blocked' };
    await options.store.delete();
    return { kind: 'recovered' };
  };

  return {
    recordIncompleteReap: async (record) => {
      // The parse is the write-side canonicalization: it adapts the
      // supervisor's close-report shape onto the persisted mirror and
      // validates exactly what becomes durable (defense, never a guess).
      const document = tombstoneDocumentSchema.parse({
        schemaVersion: TOMBSTONE_SCHEMA_VERSION,
        tombstone: { bootScope: options.bootScope, ...record },
      });
      await options.store.writeAtomically(JSON.stringify(document));
    },

    admitActivation: async () => {
      const read = await readCurrent();
      if (read.kind === 'absent') return { kind: 'admitted', clearedStaleTombstone: false };
      if (read.kind === 'unreadable') return { kind: 'blocked', reason: 'tombstone-unreadable' };
      if (isStale(read.record)) {
        // Stale by construction: the scope token cannot match this boot.
        // Clearing here is structural — no clock, no PID, no liveness.
        await options.store.delete();
        return { kind: 'admitted', clearedStaleTombstone: true };
      }
      return { kind: 'blocked', reason: 'incomplete-cleanup-tombstone' };
    },

    recoverByLeaseProof: async () => {
      const read = await readCurrent();
      if (read.kind === 'absent') return { kind: 'recovered' };
      if (read.kind === 'present' && isStale(read.record)) {
        // A stale record needs no proof at all — it cannot name this boot.
        await options.store.delete();
        return { kind: 'recovered' };
      }
      // Same-boot or unreadable: the lease proof is the only clearing —
      // and it needs no parsing, which is exactly why it can clear the
      // unreadable shape too.
      return await proveAndClear();
    },
  };
}
