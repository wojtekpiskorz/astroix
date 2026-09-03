import { describe, expect, it } from 'vitest';
import {
  createEditingPartitionMinter,
  EDITING_PARTITION_PREFIX,
  editingPartitionFromName,
  isNonPersistentPartitionName,
} from './editing-partition.ts';

/**
 * The editing-partition laws (#247, H5): fresh never-reused names,
 * nonpersistent by construction, persistent names refused fail-closed.
 * Deterministic entropy sources pin the minter's own decisions; the
 * real in-memory-session truth is the `e2e/desktop` lane.
 */

describe('createEditingPartitionMinter — the fresh nonpersistent partition', () => {
  it('mints distinct prefixed names across targets', () => {
    const minter = createEditingPartitionMinter(() => Math.random().toString(16).slice(2));
    const first = minter.mint();
    const second = minter.mint();
    expect(first.name).not.toBe(second.name);
    expect(first.name.startsWith(EDITING_PARTITION_PREFIX)).toBe(true);
    expect(second.name.startsWith(EDITING_PARTITION_PREFIX)).toBe(true);
    expect(first.persistent).toBe(false);
    expect(second.persistent).toBe(false);
    expect(minter.minted()).toEqual([first.name, second.name]);
  });

  it('refuses (never reuses) when the entropy source repeats a suffix', () => {
    const minter = createEditingPartitionMinter(() => 'fixed-suffix');
    expect(minter.mint().name).toBe(`${EDITING_PARTITION_PREFIX}fixed-suffix`);
    expect(() => minter.mint()).toThrowError(/refusing to reuse a partition/);
    // The refused mint minted nothing — the record still holds exactly one.
    expect(minter.minted()).toHaveLength(1);
  });
});

describe('isNonPersistentPartitionName — Electron naming law', () => {
  it('accepts plain names and refuses every persist: spelling', () => {
    expect(isNonPersistentPartitionName(`${EDITING_PARTITION_PREFIX}abc`)).toBe(true);
    expect(isNonPersistentPartitionName('persist:astroix')).toBe(false);
    expect(isNonPersistentPartitionName('persist:')).toBe(false);
  });
});

describe('editingPartitionFromName — addressing an existing partition', () => {
  it('wraps a nonpersistent name with the identity intact', () => {
    const partition = editingPartitionFromName(`${EDITING_PARTITION_PREFIX}reuse`);
    expect(partition).toEqual({ name: `${EDITING_PARTITION_PREFIX}reuse`, persistent: false });
  });

  it('refuses a persistent partition fail-closed', () => {
    expect(() => editingPartitionFromName('persist:astroix-editing')).toThrowError(
      /refusing a persistent partition/,
    );
  });
});
