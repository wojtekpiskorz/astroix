import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROJECT_KEY_LENGTH } from '@wojciechpiskorz/astroix-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  allocateProjectKey,
  canonicalizeRoot,
  defaultDisplayName,
  encodeProjectKey,
  RootUnavailableError,
} from '../../registry/identity';

/**
 * Registry identity (#221): ProjectKey allocation (random 128-bit
 * lowercase Base32, DNS-safe, unique) and canonical root resolution
 * (realpath, filesystem case semantics, no arbitrary lowercasing).
 * Tests run over real temp directories — identity is a filesystem
 * behavior, not a string transform.
 */

const scratchDirs: string[] = [];

/** A realpath'd temp base: /tmp is itself a symlink on darwin, and canonical roots must never carry one. */
async function makeTempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'astroix-identity-')));
  scratchDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('encodeProjectKey', () => {
  it('renders 128 zero bits as 26 base32 "a" chars', () => {
    expect(encodeProjectKey(new Uint8Array(16))).toBe('a'.repeat(PROJECT_KEY_LENGTH));
  });

  it('renders all-ones bytes with only alphabet characters and exact length', () => {
    const key = encodeProjectKey(new Uint8Array(16).fill(0xff));
    expect(key).toHaveLength(PROJECT_KEY_LENGTH);
    expect(key).toMatch(/^[a-z2-7]+$/);
    // 25 full 5-bit groups of 31 then the padded tail: 11111...111 11100 -> '7'*25 + '4'
    expect(key).toBe(`${'7'.repeat(25)}4`);
  });

  it('decodes back to the same 128 bits (bijective rendering)', () => {
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i += 1) bytes[i] = (i * 17 + 3) % 256;
    const key = encodeProjectKey(bytes);
    let value = 0n;
    for (const char of key) {
      value = (value << 5n) | BigInt('abcdefghijklmnopqrstuvwxyz234567'.indexOf(char));
    }
    const original =
      bytes.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n) & ((1n << 128n) - 1n);
    // 26 chars of 5 bits = 130 bits: the 128 data bits plus 2 zero pad
    // bits at the bottom, so the shift recovers the original exactly.
    expect(value >> 2n).toBe(original);
  });

  it('rejects any other entropy width', () => {
    expect(() => encodeProjectKey(new Uint8Array(15))).toThrow();
    expect(() => encodeProjectKey(new Uint8Array(17))).toThrow();
  });
});

describe('allocateProjectKey', () => {
  it('allocates unique DNS-safe keys across many draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const key = allocateProjectKey(seen);
      expect(key).toMatch(/^[a-z2-7]{26}$/);
      seen.add(key);
    }
    expect(seen.size).toBe(1000);
  });

  it('never returns a taken key', () => {
    const taken = new Set([allocateProjectKey(new Set())]);
    for (let i = 0; i < 50; i += 1) {
      expect(taken.has(allocateProjectKey(taken))).toBe(false);
    }
  });
});

describe('canonicalizeRoot', () => {
  it('returns the realpath of the exact-case input — never an arbitrary lowercasing', async () => {
    const base = await makeTempDir();
    await mkdir(join(base, 'MySite-Upper'));
    const canonical = await canonicalizeRoot(join(base, 'MySite-Upper'));
    expect(canonical).toBe(join(base, 'MySite-Upper'));
    expect(canonical).toContain('MySite-Upper');
  });

  it('resolves a root symlink to the real directory', async () => {
    const base = await makeTempDir();
    await mkdir(join(base, 'real-site'));
    await symlink(join(base, 'real-site'), join(base, 'alias-site'));
    expect(await canonicalizeRoot(join(base, 'alias-site'))).toBe(join(base, 'real-site'));
  });

  it('resolves intermediate symlinks too', async () => {
    const base = await makeTempDir();
    await mkdir(join(base, 'deep', 'real-parent', 'site'), { recursive: true });
    await symlink(join(base, 'deep', 'real-parent'), join(base, 'linked-parent'));
    expect(await canonicalizeRoot(join(base, 'linked-parent', 'site'))).toBe(
      join(base, 'deep', 'real-parent', 'site'),
    );
  });

  it('follows the filesystem’s own case semantics — a case variant aliases or fails, never invents', async () => {
    const base = await makeTempDir();
    await mkdir(join(base, 'CaseSite'));
    const variant = join(base, 'casesite');
    const variantResolves = await realpath(variant)
      .then(() => true)
      .catch(() => false);
    if (variantResolves) {
      // Case-insensitive filesystem (darwin APFS default): the variant is
      // an alias of the on-disk-case record, exactly as realpath answers.
      expect(await canonicalizeRoot(variant)).toBe(join(base, 'CaseSite'));
    } else {
      // Case-sensitive filesystem (Linux CI): the variant does not exist.
      await expect(canonicalizeRoot(variant)).rejects.toBeInstanceOf(RootUnavailableError);
    }
  });

  it('throws RootUnavailableError for a missing root, with a path-free message', async () => {
    const base = await makeTempDir();
    const error = await canonicalizeRoot(join(base, 'missing')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RootUnavailableError);
    expect((error as Error).message).not.toContain(base);
  });

  it('throws RootUnavailableError for a file (registration accepts a directory grant)', async () => {
    const base = await makeTempDir();
    const file = join(base, 'not-a-dir');
    await writeFile(file, 'x');
    await expect(canonicalizeRoot(file)).rejects.toBeInstanceOf(RootUnavailableError);
  });
});

describe('defaultDisplayName', () => {
  it('is the canonical root’s basename', () => {
    expect(defaultDisplayName('/srv/sites/my-site')).toBe('my-site');
    expect(defaultDisplayName('/srv/sites/my-site/')).toBe('my-site');
  });
});
