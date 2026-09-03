import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyTombstoneDocument,
  createBootTombstone,
  type TombstoneDocument,
} from '../../session-supervisor/tombstone/boot-tombstone.ts';
import {
  openTombstoneStore,
  TOMBSTONE_FILE,
} from '../../session-supervisor/tombstone/tombstone-store.ts';
import {
  cleanupScratch,
  completeCloseReport,
  incompleteCloseReport,
  makeStateDir,
  manualLeaseProbe,
  PROJECT_A,
} from './completion-harness.ts';

/**
 * The #239 focused tests, part 2 — the boot-scoped incomplete-cleanup
 * tombstone (ADR-0006 §4 step 4 and §8): the durable record, the
 * same-boot activation denial, the exclusive edit-writer-lease recovery
 * (the D3 proof), the later-boot clearing that is stale BY CONSTRUCTION
 * (a scope-token comparison, never a clock), the persisted-PID-is-never-
 * cleanup-authority law, and the fail-closed unreadable shapes — over
 * REAL temp directories (the registry-store test discipline), with the
 * lease proof a manual probe.
 */

afterEach(async () => {
  await cleanupScratch();
});

/** One machine over a fresh temp dir and the given boot scope. */
async function machineFor(
  bootScope: string,
  probe: ReturnType<typeof manualLeaseProbe>,
  directory?: string,
) {
  const dir = directory ?? (await makeStateDir());
  const store = await openTombstoneStore(dir);
  return {
    machine: createBootTombstone({ store, bootScope, acquireExclusiveEditLease: probe.acquire }),
    dir,
  };
}

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

async function readTombstoneFile(dir: string): Promise<TombstoneDocument> {
  const text = await readFile(join(dir, TOMBSTONE_FILE), 'utf8');
  return JSON.parse(text) as TombstoneDocument;
}

describe('the durable record (§4 step 4 "atomically persist")', () => {
  it('persists the boot-scoped record: scope, project, recorded PID, and the close-report evidence verbatim', async () => {
    const probe = manualLeaseProbe('contended');
    const { machine, dir } = await machineFor('boot-1', probe);

    await machine.recordIncompleteReap({
      projectKey: PROJECT_A,
      recordedPid: 4242,
      closeReport: incompleteCloseReport('stopped'),
    });

    const document = await readTombstoneFile(dir);
    expect(document.schemaVersion).toBe(1);
    expect(document.tombstone.bootScope).toBe('boot-1');
    expect(document.tombstone.projectKey).toBe(PROJECT_A);
    expect(document.tombstone.recordedPid).toBe(4242);
    // The supervisor's reap accounting, honest about the unobserved shape (#326's context):
    expect(document.tombstone.closeReport).toEqual(incompleteCloseReport('stopped'));
    // The private-state file discipline (the registry-store idiom): 0600 file.
    expect(await modeOf(join(dir, TOMBSTONE_FILE))).toBe(0o600);
    expect(await modeOf(dir)).toBe(0o700);
  });

  it('persists the observed close-report shape verbatim too — both shapes are honest', async () => {
    const probe = manualLeaseProbe('contended');
    const { machine, dir } = await machineFor('boot-1', probe);

    await machine.recordIncompleteReap({
      projectKey: PROJECT_A,
      recordedPid: null,
      closeReport: completeCloseReport('stopped'),
    });

    const document = await readTombstoneFile(dir);
    expect(document.tombstone.closeReport).toEqual(completeCloseReport('stopped'));
    expect(document.tombstone.recordedPid).toBe(null);
  });

  it('the close-report evidence carries no PID — the PID lives only in its own recorded-evidence field', async () => {
    const probe = manualLeaseProbe('contended');
    const { machine, dir } = await machineFor('boot-1', probe);

    await machine.recordIncompleteReap({
      projectKey: PROJECT_A,
      recordedPid: 4242,
      closeReport: incompleteCloseReport('stopped'),
    });

    const document = await readTombstoneFile(dir);
    // The sanitized-evidence law (§8): the report's own shape holds
    // categories and accounting only — the PID is the record's separate
    // diagnostic field, never part of the report the app discloses.
    expect(document.tombstone.closeReport).not.toBeNull();
    expect(Object.keys(document.tombstone.closeReport ?? {})).not.toContain('pid');
    expect(JSON.stringify(document.tombstone.closeReport)).not.toContain('4242');
  });
});

describe('the store file discipline (the registry-store idiom, mirrored)', () => {
  it('creates the directory recursive and 0700, and tightens a pre-existing loose directory and files', async () => {
    const base = await makeStateDir();
    const dir = join(base, 'nested', 'tombstone-dir');
    await mkdir(dir, { recursive: true, mode: 0o777 });
    await chmod(dir, 0o755);
    await writeFile(join(dir, TOMBSTONE_FILE), '{}');
    await chmod(join(dir, TOMBSTONE_FILE), 0o644);

    await openTombstoneStore(dir);

    expect(await modeOf(dir)).toBe(0o700);
    expect(await modeOf(join(dir, TOMBSTONE_FILE))).toBe(0o600);
  });

  it('deleting an absent tombstone never throws — the clearing is idempotent', async () => {
    const dir = await makeStateDir();
    const store = await openTombstoneStore(dir);

    await expect(store.delete()).resolves.toBeUndefined();
    await expect(store.delete()).resolves.toBeUndefined();
  });

  it('a second record replaces the first whole — one tombstone stands at a time', async () => {
    const dir = await makeStateDir();
    const store = await openTombstoneStore(dir);
    const machine = createBootTombstone({
      store,
      bootScope: 'boot-1',
      acquireExclusiveEditLease: manualLeaseProbe('contended').acquire,
    });
    await machine.recordIncompleteReap({
      projectKey: PROJECT_A,
      recordedPid: 111,
      closeReport: null,
    });
    await machine.recordIncompleteReap({
      projectKey: PROJECT_A,
      recordedPid: 222,
      closeReport: incompleteCloseReport('stopped'),
    });

    const document = await readTombstoneFile(dir);
    expect(document.tombstone.recordedPid).toBe(222); // the later event is the live truth
  });
});

describe('the same-boot activation denial (§8 "activation stays blocked")', () => {
  it('blocks activation while the live boot-scope tombstone stands — and keeps blocking', async () => {
    const probe = manualLeaseProbe('contended');
    const { machine } = await machineFor('boot-1', probe);
    await machine.recordIncompleteReap({
      projectKey: PROJECT_A,
      recordedPid: null,
      closeReport: null,
    });

    expect(await machine.admitActivation()).toEqual({
      kind: 'blocked',
      reason: 'incomplete-cleanup-tombstone',
    });
    expect(await machine.admitActivation()).toEqual({
      kind: 'blocked',
      reason: 'incomplete-cleanup-tombstone',
    });
  });

  it('admits with nothing standing', async () => {
    const probe = manualLeaseProbe('contended');
    const { machine } = await machineFor('boot-1', probe);

    expect(await machine.admitActivation()).toEqual({
      kind: 'admitted',
      clearedStaleTombstone: false,
    });
  });

  it('the persisted PID is never cleanup authority: a live, matching PID alone authorizes nothing', async () => {
    const probe = manualLeaseProbe('contended'); // the lease is held — a live executor remains
    const { machine } = await machineFor('boot-1', probe);
    // The recorded PID IS alive and IS this very process — if a PID could
    // authorize anything, this record would be the one that clears.
    await machine.recordIncompleteReap({
      projectKey: PROJECT_A,
      recordedPid: process.pid,
      closeReport: null,
    });

    expect(await machine.admitActivation()).toEqual({
      kind: 'blocked',
      reason: 'incomplete-cleanup-tombstone',
    });
    expect(await machine.recoverByLeaseProof()).toEqual({ kind: 'still-blocked' });
    expect(await machine.admitActivation()).toEqual({
      kind: 'blocked',
      reason: 'incomplete-cleanup-tombstone',
    });
  });
});

describe('the lease-proven recovery (§8 "until exclusive edit-writer-lease acquisition proves")', () => {
  it('a contended lease keeps the block — a live executor remains, the tombstone stands', async () => {
    const probe = manualLeaseProbe('contended');
    const { machine, dir } = await machineFor('boot-1', probe);
    await machine.recordIncompleteReap({
      projectKey: PROJECT_A,
      recordedPid: null,
      closeReport: null,
    });

    expect(await machine.recoverByLeaseProof()).toEqual({ kind: 'still-blocked' });
    expect(probe.probes).toBe(1);
    expect(await machine.admitActivation()).toEqual({
      kind: 'blocked',
      reason: 'incomplete-cleanup-tombstone',
    });
    // The durable record survived the failed proof.
    expect(await readTombstoneFile(dir)).toBeDefined();
  });

  it('an exclusive acquisition proves no live executor remains — the only same-boot clearing', async () => {
    const probe = manualLeaseProbe('exclusive');
    const { machine, dir } = await machineFor('boot-1', probe);
    await machine.recordIncompleteReap({
      projectKey: PROJECT_A,
      recordedPid: null,
      closeReport: null,
    });

    expect(await machine.recoverByLeaseProof()).toEqual({ kind: 'recovered' });
    expect(await machine.admitActivation()).toEqual({
      kind: 'admitted',
      clearedStaleTombstone: false,
    });
    // The clearing is durable: the tombstone file is gone.
    await expect(readTombstoneFile(dir)).rejects.toThrow();
  });

  it('nothing standing: the recovery answers recovered without probing', async () => {
    const probe = manualLeaseProbe('contended');
    const { machine } = await machineFor('boot-1', probe);

    expect(await machine.recoverByLeaseProof()).toEqual({ kind: 'recovered' });
    expect(probe.probes).toBe(0);
  });
});

describe('the later-boot clearing (§8 "stale by construction")', () => {
  it('a scope token that cannot match clears on admission — structural, never time-based', async () => {
    const probe = manualLeaseProbe('contended');
    const dir = await makeStateDir();
    const first = await machineFor('boot-1', probe, dir);
    await first.machine.recordIncompleteReap({
      projectKey: PROJECT_A,
      recordedPid: 4242,
      closeReport: null,
    });

    // The relaunch on a LATER machine boot: a fresh scope token cannot
    // equal the persisted one — clearing is the comparison, no clock.
    const probe2 = manualLeaseProbe('contended');
    const second = await machineFor('boot-2', probe2, dir);
    expect(await second.machine.admitActivation()).toEqual({
      kind: 'admitted',
      clearedStaleTombstone: true,
    });
    expect(probe2.probes).toBe(0); // stale needs no proof at all
    await expect(readTombstoneFile(dir)).rejects.toThrow();

    // And the relaunch on the SAME machine boot still blocks: the token matches.
    const probe3 = manualLeaseProbe('contended');
    const third = await machineFor('boot-1', probe3, dir);
    await third.machine.recordIncompleteReap({
      projectKey: PROJECT_A,
      recordedPid: null,
      closeReport: null,
    });
    expect(await third.machine.admitActivation()).toEqual({
      kind: 'blocked',
      reason: 'incomplete-cleanup-tombstone',
    });
  });

  it('the recovery path clears a stale record without probing', async () => {
    const probe = manualLeaseProbe('contended');
    const dir = await makeStateDir();
    const first = await machineFor('boot-1', probe, dir);
    await first.machine.recordIncompleteReap({
      projectKey: PROJECT_A,
      recordedPid: null,
      closeReport: null,
    });

    const probe2 = manualLeaseProbe('contended');
    const second = await machineFor('boot-2', probe2, dir);
    expect(await second.machine.recoverByLeaseProof()).toEqual({ kind: 'recovered' });
    expect(probe2.probes).toBe(0);
    await expect(readTombstoneFile(dir)).rejects.toThrow();
  });
});

describe('the fail-closed unreadable shapes', () => {
  it('unparseable bytes block: the scope cannot be proven, the lease proof still clears', async () => {
    const dir = await makeStateDir();
    const store = await openTombstoneStore(dir);
    await store.writeAtomically('{ this is not json');
    const probe = manualLeaseProbe('exclusive');
    const machine = createBootTombstone({
      store,
      bootScope: 'boot-1',
      acquireExclusiveEditLease: probe.acquire,
    });

    expect(await machine.admitActivation()).toEqual({
      kind: 'blocked',
      reason: 'tombstone-unreadable',
    });
    // The proof needs no parsing — that is exactly why it can clear this shape.
    expect(await machine.recoverByLeaseProof()).toEqual({ kind: 'recovered' });
    expect(await machine.admitActivation()).toEqual({
      kind: 'admitted',
      clearedStaleTombstone: false,
    });
  });

  it('a contended proof keeps even the unreadable tombstone blocked', async () => {
    const dir = await makeStateDir();
    const store = await openTombstoneStore(dir);
    await store.writeAtomically('{ this is not json');
    const probe = manualLeaseProbe('contended');
    const machine = createBootTombstone({
      store,
      bootScope: 'boot-1',
      acquireExclusiveEditLease: probe.acquire,
    });

    expect(await machine.recoverByLeaseProof()).toEqual({ kind: 'still-blocked' });
    expect(await machine.admitActivation()).toEqual({
      kind: 'blocked',
      reason: 'tombstone-unreadable',
    });
  });

  it('an unsupported future schema blocks the same way — no downgrade guess', async () => {
    const dir = await makeStateDir();
    const store = await openTombstoneStore(dir);
    await store.writeAtomically(JSON.stringify({ schemaVersion: 2, tombstone: null }));
    const probe = manualLeaseProbe('contended');
    const machine = createBootTombstone({
      store,
      bootScope: 'boot-1',
      acquireExclusiveEditLease: probe.acquire,
    });

    expect(await machine.admitActivation()).toEqual({
      kind: 'blocked',
      reason: 'tombstone-unreadable',
    });
  });
});

describe('the document classification (the registry-document idiom, mirrored)', () => {
  it('classifies a valid document as ok', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      tombstone: {
        bootScope: 'boot-1',
        projectKey: PROJECT_A,
        recordedPid: null,
        closeReport: null,
      },
    });
    const classified = classifyTombstoneDocument(text);
    expect(classified.status).toBe('ok');
  });

  it('classifies corrupt bytes: unparseable JSON, wrong shapes, non-integer PIDs, bad project keys', () => {
    expect(classifyTombstoneDocument('not json').status).toBe('unusable');
    expect(classifyTombstoneDocument('null').status).toBe('unusable');
    expect(classifyTombstoneDocument('{}').status).toBe('unusable');
    expect(classifyTombstoneDocument('[]').status).toBe('unusable');
    expect(
      classifyTombstoneDocument(
        JSON.stringify({
          schemaVersion: 1,
          tombstone: { bootScope: '', projectKey: PROJECT_A, recordedPid: null, closeReport: null },
        }),
      ).status,
    ).toBe('unusable'); // an empty scope token cannot name a boot
    expect(
      classifyTombstoneDocument(
        JSON.stringify({
          schemaVersion: 1,
          tombstone: {
            bootScope: 'boot-1',
            projectKey: 'not-a-key',
            recordedPid: null,
            closeReport: null,
          },
        }),
      ).status,
    ).toBe('unusable');
    expect(
      classifyTombstoneDocument(
        JSON.stringify({
          schemaVersion: 1,
          tombstone: {
            bootScope: 'boot-1',
            projectKey: PROJECT_A,
            recordedPid: 1.5,
            closeReport: null,
          },
        }),
      ).status,
    ).toBe('unusable');
    // An unknown field — a `kill` command, a lease — is corruption, not authority.
    expect(
      classifyTombstoneDocument(
        JSON.stringify({
          schemaVersion: 1,
          tombstone: {
            bootScope: 'boot-1',
            projectKey: PROJECT_A,
            recordedPid: null,
            closeReport: null,
            kill: true,
          },
        }),
      ).status,
    ).toBe('unusable');
  });

  it('classifies a numeric future version as unsupported-future, a below-v1 version as corrupt', () => {
    expect(classifyTombstoneDocument(JSON.stringify({ schemaVersion: 2 }))).toMatchObject({
      status: 'unusable',
      reason: 'unsupported-future',
    });
    expect(classifyTombstoneDocument(JSON.stringify({ schemaVersion: 0 }))).toMatchObject({
      status: 'unusable',
      reason: 'corrupt',
    });
    expect(classifyTombstoneDocument(JSON.stringify({ schemaVersion: '1' }))).toMatchObject({
      status: 'unusable',
      reason: 'corrupt',
    });
  });

  it('a strictness drift between the persisted mirror and the E7 unions classifies as corrupt — fail closed', () => {
    const drifted = JSON.stringify({
      schemaVersion: 1,
      tombstone: {
        bootScope: 'boot-1',
        projectKey: PROJECT_A,
        recordedPid: null,
        closeReport: {
          reason: 'not-a-stop-reason',
          outcome: 'complete',
          failures: [],
          accounting: {
            workerReportReceived: true,
            workerCleanupComplete: true,
            workerReaped: true,
            managedAstroReaped: true,
            probesSettled: true,
            killEscalations: [],
          },
        },
      },
    });
    expect(classifyTombstoneDocument(drifted)).toMatchObject({
      status: 'unusable',
      reason: 'corrupt',
    });
  });
});
