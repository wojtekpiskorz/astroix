import { describe, expect, it } from 'vitest';
import { isSmokeGateOpen } from './gate';

describe('isSmokeGateOpen', () => {
  it('opens only on the exact astroix_smoke=1 param', () => {
    expect(isSmokeGateOpen('?astroix_smoke=1')).toBe(true);
    expect(isSmokeGateOpen('?astroix_smoke=1&builder=0')).toBe(true);
    expect(isSmokeGateOpen('?builder=0&astroix_smoke=1')).toBe(true);
  });

  it('stays closed without the param or with any other value', () => {
    expect(isSmokeGateOpen('')).toBe(false);
    expect(isSmokeGateOpen('?astroix_smoke=0')).toBe(false);
    expect(isSmokeGateOpen('?astroix_smoke=true')).toBe(false);
    // the prototype-era unprefixed name does not open the gate
    expect(isSmokeGateOpen('?smoke=1')).toBe(false);
  });
});
