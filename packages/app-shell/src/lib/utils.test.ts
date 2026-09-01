import { describe, expect, it } from 'vitest';
import { cn } from './utils';

describe('cn', () => {
  it('joins conditional class values and drops falsy ones', () => {
    expect(cn('a', false && 'b', undefined, 'c')).toBe('a c');
    expect(cn('a', 'b')).toBe('a b');
  });

  it('dedupes conflicting tailwind utilities — the last one wins', () => {
    expect(cn('px-2', 'px-3')).toBe('px-3');
    expect(cn('flex', 'px-2', 'block')).toBe('px-2 block');
  });
});
