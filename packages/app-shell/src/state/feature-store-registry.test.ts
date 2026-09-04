import { afterEach, describe, expect, it } from 'vitest';
import {
  clearRegisteredFeatureStores,
  type FeatureStoreResetHandle,
  registeredFeatureStoreKeys,
  registerFeatureStoreReset,
} from './feature-store-registry.ts';

/**
 * The feature-store reset registry's focused lane (#372): the
 * registration lifecycle — register, walk, unregister, replace — and
 * the census, over the registry's own module state (the five real
 * feature-store registrations live in the sequencer's integration
 * lane, `app-shell/shell-reset.test.ts`, where the composed reset is
 * the judge).
 */

const handles: FeatureStoreResetHandle[] = [];

/** Registers and remembers the handle — every test unwinds what it registered. */
function register(key: string, reset: () => void): FeatureStoreResetHandle {
  const handle = registerFeatureStoreReset(key, reset);
  handles.push(handle);
  return handle;
}

afterEach(() => {
  for (const handle of handles.splice(0)) handle.unregister();
});

describe('the feature-store reset registry', () => {
  it('runs a registered reset on the walk — and KEEPS the registration for the next commit', () => {
    const clears: string[] = [];
    register('test:keeps', () => clears.push('test:keeps'));
    clearRegisteredFeatureStores();
    clearRegisteredFeatureStores();
    expect(clears).toEqual(['test:keeps', 'test:keeps']);
  });

  it('walks in registration order — the deterministic commit-order', () => {
    const order: string[] = [];
    register('test:order-two', () => order.push('two'));
    register('test:order-one', () => order.push('one'));
    clearRegisteredFeatureStores();
    // insertion order, not key order: two registered first, clears first
    expect(order).toEqual(['two', 'one']);
  });

  it('unregister removes the registration — the walk no longer clears it', () => {
    let cleared = 0;
    const handle = register('test:gone', () => (cleared += 1));
    handle.unregister();
    clearRegisteredFeatureStores();
    expect(cleared).toBe(0);
    expect(registeredFeatureStoreKeys()).not.toContain('test:gone');
  });

  it('a same-key registration REPLACES the earlier one (idempotent module scope)', () => {
    const calls: string[] = [];
    register('test:replace', () => calls.push('first'));
    register('test:replace', () => calls.push('second'));
    clearRegisteredFeatureStores();
    expect(calls).toEqual(['second']);
    expect(registeredFeatureStoreKeys().filter((key) => key === 'test:replace')).toHaveLength(1);
  });

  it('a superseded handle cannot unregister its successor', () => {
    const stale = registerFeatureStoreReset('test:superseded', () => {});
    register('test:superseded', () => {});
    stale.unregister(); // the successor still stands
    expect(registeredFeatureStoreKeys()).toContain('test:superseded');
  });

  it('censuses the registered keys, sorted', () => {
    register('test:census-b', () => {});
    register('test:census-a', () => {});
    const keys = registeredFeatureStoreKeys();
    expect(keys.indexOf('test:census-a')).toBeLessThan(keys.indexOf('test:census-b'));
    expect(keys).toContain('test:census-b');
  });
});
