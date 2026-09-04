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

describe('findDisclosure composed-text embedding (#352)', () => {
  it('flags path-shaped strings composed after a version', () => {
    expect(findDisclosure('astro@7.2.10/Users/you/dev/project')?.id).toBe('absolute-path');
    expect(findDisclosure('vite@8.3.0/Users/secret')?.id).toBe('absolute-path');
    expect(findDisclosure('detected astro@7.3.0 + vite@8.3.0/Users/secret')?.id).toBe(
      'absolute-path',
    );
    expect(findDisclosure('7.3.0/Users/secret')?.id).toBe('absolute-path');
    expect(findDisclosure('astro@24/bin/node')?.id).toBe('absolute-path');
  });

  it('flags path-shaped strings composed directly after a package handle, no version', () => {
    expect(findDisclosure('astro@/Users/you/dev/project')?.id).toBe('absolute-path');
    expect(findDisclosure('vite@/home/o/site')?.id).toBe('absolute-path');
    expect(findDisclosure('rejects astro@/srv/app')?.id).toBe('absolute-path');
  });

  it('flags home-relative paths composed after a version or package handle', () => {
    expect(findDisclosure('7.2.10~/dev/project')?.id).toBe('home-relative-path');
    expect(findDisclosure('8.2.2~/secret')?.id).toBe('home-relative-path');
    expect(findDisclosure('astro@~/dev/project')?.id).toBe('home-relative-path');
  });

  it('keeps catching path-first compositions (version tail does not mask the path)', () => {
    expect(findDisclosure('/Users/owner/site7.3.0 is gone')?.id).toBe('absolute-path');
    expect(findDisclosure('root at /home/owner/site7.3.0')?.id).toBe('absolute-path');
    expect(findDisclosure('~/dev/site7.3.0')?.id).toBe('home-relative-path');
  });

  it('keeps digit-led dates and single-slash fractions safe (calibration)', () => {
    expect(findDisclosure('the date 2026/09/03 is fine')).toBeNull();
    expect(findDisclosure('logged 2026/09/03')).toBeNull();
    expect(findDisclosure('open 24/7')).toBeNull();
    expect(findDisclosure('ratio 1/2 and 3/4')).toBeNull();
    expect(findDisclosure('a 10/10 build')).toBeNull();
    expect(findDisclosure('graded 9/10 on 2026/09/03')).toBeNull();
  });

  it('keeps the version/pair fact vocabulary safe when the facts are clean', () => {
    // the benign corpus for the vocabulary the anchors now admit: plain
    // semver facts, contract ranges, scoped package handles, and
    // email-shaped prose — none of them path-shaped
    expect(findDisclosure('detected astro@7.3.0 + vite@8.3.0')).toBeNull();
    expect(findDisclosure('certified pairs: astro@7.2.10 + vite@8.2.2')).toBeNull();
    expect(findDisclosure('rejected contract: ^7.0.0 || ^8.0.0')).toBeNull();
    expect(findDisclosure('scoped @astrojs/node adapter')).toBeNull();
    expect(findDisclosure('team@astro/builds fast')).toBeNull();
    expect(findDisclosure('astro@7.2.10')).toBeNull();
  });
});

describe('sanitizedTextSchema composed-text embedding (#352)', () => {
  it('rejects a composed message whose embedded version carries a path', () => {
    const composed = sanitizedTextSchema.safeParse(
      'the pair is uncertified (detected astro@7.3.0/Users/secret + vite@8.3.0)',
    );
    expect(composed.success).toBe(false);
    if (!composed.success) {
      expect(JSON.stringify(composed.error.issues)).toContain('absolute-path');
      expect(JSON.stringify(composed.error.issues)).not.toContain('/Users/secret');
    }
  });

  it('accepts a composed message over clean version facts', () => {
    const composed = sanitizedTextSchema.safeParse(
      'the pair is uncertified (detected astro@7.3.0 + vite@8.3.0; certified pairs: astro@7.2.10 + vite@8.2.2)',
    );
    expect(composed.success).toBe(true);
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
