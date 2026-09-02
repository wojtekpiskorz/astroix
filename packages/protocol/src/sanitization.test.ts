import { describe, expect, it } from 'vitest';
import { findDisclosure, sanitizedTextSchema } from './sanitization';

/**
 * Output hygiene (#220 AC: public errors are a closed sanitized union and
 * cannot expose roots, ports, PIDs, environment, capabilities, or stacks —
 * the structural half of that guarantee lives in errors.test.ts; this file
 * exercises the free-text disclosure guard that backs it).
 */
describe('findDisclosure', () => {
  it('flags leaked absolute filesystem paths — any slash-rooted segment pair', () => {
    expect(findDisclosure('/Users/owner/projects/site')?.id).toBe('absolute-path');
    expect(findDisclosure('root at /home/owner/site is gone')?.id).toBe('absolute-path');
    expect(findDisclosure('see /private/var/folders/xyz')?.id).toBe('absolute-path');
    expect(findDisclosure('see:/Users/owner/site')?.id).toBe('absolute-path');
    expect(findDisclosure('root:/srv/app failed')?.id).toBe('absolute-path');
    expect(findDisclosure('prefix:~/notes')?.id).toBe('home-relative-path');
    expect(findDisclosure('/tmp/build')?.id).toBe('absolute-path');
    expect(findDisclosure('mounted under /srv/site')?.id).toBe('absolute-path');
    expect(findDisclosure('staged from /mnt/data/site')?.id).toBe('absolute-path');
  });

  it('flags home-relative and Windows paths (drive and UNC)', () => {
    expect(findDisclosure('~/projects/site')?.id).toBe('home-relative-path');
    expect(findDisclosure('built from ~/dev/site')?.id).toBe('home-relative-path');
    expect(findDisclosure('C:\\Users\\owner\\site')?.id).toBe('windows-path');
    expect(findDisclosure('config D:/dev/site')?.id).toBe('windows-path');
    expect(findDisclosure('resided on \\\\server\\share\\site')?.id).toBe('unc-path');
  });

  it('flags stack frames and node internals', () => {
    expect(findDisclosure('Error: boom\n    at write (/app/out.js:12:9)')?.id).toBe('stack-frame');
    expect(findDisclosure('at Object.<anonymous> (internal)).js:1:1)')?.id).toBe('stack-frame');
    expect(findDisclosure('threw in node:internal/process/task_queues')?.id).toBe('node-internal');
  });

  it('flags PID references', () => {
    expect(findDisclosure('child pid 4242 exited')?.id).toBe('pid');
    expect(findDisclosure('PID: 17')?.id).toBe('pid');
  });

  it('passes sanitized prose — including slash-bearing prose without an absolute shape', () => {
    expect(findDisclosure('the project root is unavailable')).toBe(null);
    expect(findDisclosure('candidate startup exceeded its deadline')).toBe(null);
    expect(findDisclosure('the route did not render this entry')).toBe(null);
    expect(findDisclosure('either/or is prose, not a path')).toBe(null);
    expect(findDisclosure('a 1/2 ratio is fine')).toBe(null);
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

describe('findDisclosure port and env anchoring', () => {
  it('flags keyword-anchored ports and SCREAMING_SNAKE env values', () => {
    expect(findDisclosure('dev server failed: port 4321 already in use')?.id).toBe('port');
    expect(findDisclosure('bound to PORT=4314')?.id).toBe('port');
    expect(findDisclosure('failed with ASTRO_TELEMETRY_DISABLED=1 set')?.id).toBe('env-value');
    expect(findDisclosure('NODE_ENV=production leaked')?.id).toBe('env-value');
    expect(findDisclosure('aspect ratio 16:9 and time 10:30 are prose')).toBeNull();
    expect(findDisclosure('the equation ID=5 is prose')).toBeNull();
  });
  it('names the finding and its shape in the rejection message', () => {
    const result = sanitizedTextSchema.safeParse('root:/srv/app failed');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('an absolute filesystem path');
      expect(result.error.issues[0]?.message).toContain('absolute-path');
    }
  });
});
