import { describe, expect, it } from 'vitest';
import { findDisclosure, sanitizedTextSchema } from './sanitization';

/**
 * Output hygiene (#220 AC: public errors are a closed sanitized union and
 * cannot expose roots, ports, PIDs, environment, capabilities, or stacks —
 * the structural half of that guarantee lives in errors.test.ts; this file
 * exercises the free-text disclosure guard that backs it).
 */
describe('findDisclosure', () => {
  it('flags leaked absolute filesystem roots (macOS and Linux shapes)', () => {
    expect(findDisclosure('/Users/owner/projects/site')).toBe('absolute-path');
    expect(findDisclosure('root at /home/owner/site is gone')).toBe('absolute-path');
    expect(findDisclosure('see /private/var/folders/xyz')).toBe('absolute-path');
    expect(findDisclosure('/tmp/build')).toBe('absolute-path');
  });

  it('flags Windows drive paths', () => {
    expect(findDisclosure('C:\\Users\\owner\\site')).toBe('windows-path');
    expect(findDisclosure('config D:/dev/site')).toBe('windows-path');
  });

  it('flags stack frames and node internals', () => {
    expect(findDisclosure('Error: boom\n    at write (/app/out.js:12:9)')).toBe('stack-frame');
    expect(findDisclosure('at Object.<anonymous> (internal)).js:1:1)')).toBe('stack-frame');
    expect(findDisclosure('threw in node:internal/process/task_queues')).toBe('node-internal');
  });

  it('flags PID references', () => {
    expect(findDisclosure('child pid 4242 exited')).toBe('pid');
    expect(findDisclosure('PID: 17')).toBe('pid');
  });

  it('passes sanitized prose', () => {
    expect(findDisclosure('the project root is unavailable')).toBe(null);
    expect(findDisclosure('candidate startup exceeded its deadline')).toBe(null);
    expect(findDisclosure('the route did not render this entry')).toBe(null);
  });
});

describe('sanitizedTextSchema', () => {
  it('accepts non-empty sanitized text', () => {
    expect(sanitizedTextSchema.safeParse('candidate rolled back cleanly').success).toBe(true);
  });

  it('rejects empty text and disclosures with the finding named, not echoed', () => {
    const empty = sanitizedTextSchema.safeParse('');
    expect(empty.success).toBe(false);

    const leaked = sanitizedTextSchema.safeParse('failed under /Users/owner/site');
    expect(leaked.success).toBe(false);
    if (!leaked.success) {
      const messages = JSON.stringify(leaked.error.issues);
      expect(messages).toContain('absolute-path');
      expect(messages).not.toContain('/Users/owner/site');
    }
  });
});
