import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  expectedReleaseFuseStates,
  fuseStateViolations,
  RELEASE_FUSE_CONFIG,
  readFuseStates,
  V1_FUSE_NAMES,
} from '../../src/forge/release-fuses.ts';

/**
 * The fuse-wire reader (#245, H3): the verification law's eyes. These
 * units drive the reader over SYNTHETIC binaries — the real Electron
 * sentinel followed by a hand-built V1 wire — so the parse is pinned
 * deterministically; the real-packaged-binary fuse-state inspection is
 * the local packaging lane's leg (`packaged-app.test.ts`, self-skipping
 * without a local package, the certify:adapter precedent).
 */

/** The @electron/fuses V1 sentinel — the public wire marker in every Electron 12+ binary. */
const FUSE_SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
const DISABLE = 48;
const ENABLE = 49;

/** The release wire: eight settable fuses + the riding ninth (WasmTrapHandlers, Electron 44's slot 8). */
const RELEASE_WIRE = [DISABLE, DISABLE, DISABLE, DISABLE, ENABLE, ENABLE, DISABLE, DISABLE, ENABLE];

let scratch: string | undefined;

async function syntheticBinary(
  wire: readonly number[],
  version = 0x01,
  length = wire.length,
): Promise<string> {
  scratch ??= await mkdtemp(join(tmpdir(), 'astroix-fuses-test-'));
  const path = join(scratch, `binary-${Math.random().toString(36).slice(2)}`);
  const bytes = Buffer.from(FUSE_SENTINEL, 'latin1');
  const payload = Buffer.from([version, length, ...wire]);
  await writeFile(path, Buffer.concat([bytes, payload]));
  return path;
}

describe('the release fuse law (#245, ADR-0008)', () => {
  it('rules on EVERY wire fuse explicitly — nothing rides along unnamed', () => {
    expect(V1_FUSE_NAMES).toHaveLength(9);
    expect(Object.keys(expectedReleaseFuseStates()).sort()).toEqual([...V1_FUSE_NAMES].sort());
  });

  it('disables RunAsNode, NODE_OPTIONS, and command-line inspection; enables ASAR integrity and only-load-from-ASAR', () => {
    const expected = expectedReleaseFuseStates();
    expect(expected.RunAsNode).toBe('disable');
    expect(expected.EnableNodeOptionsEnvironmentVariable).toBe('disable');
    expect(expected.EnableNodeCliInspectArguments).toBe('disable');
    expect(expected.EnableEmbeddedAsarIntegrityValidation).toBe('enable');
    expect(expected.OnlyLoadAppFromAsar).toBe('enable');
  });

  it('rules the riding ninth fuse (WasmTrapHandlers) at its Electron-shipped state', () => {
    expect(expectedReleaseFuseStates().WasmTrapHandlers).toBe('enable');
  });

  it('is strict-complete within the peer-pinned toolchain and does not let the FusesPlugin re-sign', () => {
    // strictlyRequireAllFuses is false of necessity: Forge 7.11.2's
    // plugin accepts @electron/fuses 1.x only, which cannot express
    // Electron 44's ninth fuse. The completeness law is the read-back —
    // all nine names, asserted above.
    expect(RELEASE_FUSE_CONFIG.strictlyRequireAllFuses).toBe(false);
    expect(RELEASE_FUSE_CONFIG.resetAdHocDarwinSignature).toBe(false);
  });
});

describe('the fuse-wire reader over synthetic binaries (#245)', () => {
  it('reads the release wire back state by state', async () => {
    const states = await readFuseStates(await syntheticBinary(RELEASE_WIRE));
    expect(states).toEqual(expectedReleaseFuseStates());
  });

  it('reads a differently-set wire without bending toward the law', async () => {
    const states = await readFuseStates(
      await syntheticBinary([
        ENABLE,
        DISABLE,
        ENABLE,
        ENABLE,
        DISABLE,
        DISABLE,
        ENABLE,
        ENABLE,
        DISABLE,
      ]),
    );
    expect(states).toMatchObject({
      RunAsNode: 'enable',
      EnableEmbeddedAsarIntegrityValidation: 'disable',
      GrantFileProtocolExtraPrivileges: 'enable',
      WasmTrapHandlers: 'disable',
    });
  });

  it('reports a binary without the sentinel as sentinel-missing', async () => {
    scratch ??= await mkdtemp(join(tmpdir(), 'astroix-fuses-test-'));
    const path = join(scratch, 'no-sentinel');
    await writeFile(path, Buffer.from('just an ordinary mach-o-looking blob'));
    const read = await readFuseStates(path);
    expect(read).toEqual({ code: 'sentinel-missing' });
  });

  it('reports an unreadable path as binary-unreadable', async () => {
    const read = await readFuseStates(join(tmpdir(), 'astroix-no-such-binary'));
    expect(read).toEqual({ code: 'binary-unreadable' });
  });

  it('reports a wire shorter than the V1 law as a rejection, never as silent states', async () => {
    const read = await readFuseStates(await syntheticBinary([ENABLE, ENABLE, ENABLE], 0x01, 3));
    expect('code' in read && read.code).toBe('wire-unknown-state');
  });

  it('reports a non-V1 wire version as a version mismatch', async () => {
    const read = await readFuseStates(await syntheticBinary(RELEASE_WIRE, 0x02));
    expect(read).toEqual({ code: 'wire-version-mismatch', found: '2' });
  });

  it('rejects a LONGER wire — a tenth fuse is an unruled fuse, never a silent ride-along (#245 review finding)', async () => {
    const read = await readFuseStates(await syntheticBinary([...RELEASE_WIRE, ENABLE]));
    expect(read).toEqual({ code: 'wire-too-long', found: 10, expected: 9 });
  });

  it('names exactly the offending fuses when a wire violates the law', () => {
    const expected = expectedReleaseFuseStates();
    const flipped: Record<string, 'enable' | 'disable'> = {
      ...expected,
      RunAsNode: 'enable',
      OnlyLoadAppFromAsar: 'disable',
    };
    const violations = fuseStateViolations(flipped, expected);
    expect(violations).toEqual([
      { fuse: 'RunAsNode', actual: 'enable', expected: 'disable' },
      { fuse: 'OnlyLoadAppFromAsar', actual: 'disable', expected: 'enable' },
    ]);
  });

  it('treats a fuse MISSING from the actual map as a violation — partial actuals never pass vacuously (#245 review finding)', () => {
    const expected = expectedReleaseFuseStates();
    const partial = { ...expected };
    delete partial.WasmTrapHandlers;
    const violations = fuseStateViolations(partial, expected);
    expect(violations).toEqual([
      { fuse: 'WasmTrapHandlers', actual: 'absent', expected: 'enable' },
    ]);
  });
});

it('cleans the synthetic-binary scratch root', async () => {
  if (scratch !== undefined) {
    await rm(scratch, { recursive: true, force: true });
    scratch = undefined;
  }
});
