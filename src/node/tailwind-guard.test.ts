import { describe, expect, it } from 'vitest';
import { hostRegistersTailwind } from './tailwind-guard';

describe('hostRegistersTailwind', () => {
  it('is false without vite plugins', () => {
    expect(hostRegistersTailwind(undefined)).toBe(false);
    expect(hostRegistersTailwind({})).toBe(false);
  });

  it('is false for unrelated plugins', () => {
    expect(
      hostRegistersTailwind({ plugins: [{ name: 'vite:react-babel' }, { name: 'astroix' }] }),
    ).toBe(false);
  });

  it('detects a host tailwind plugin by name prefix, nested arrays included', () => {
    expect(
      hostRegistersTailwind({ plugins: [[{ name: '@tailwindcss/vite:scan' }, { name: 'other' }]] }),
    ).toBe(true);
  });
});
