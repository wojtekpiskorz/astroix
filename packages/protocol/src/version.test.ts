import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  API_V1_PREFIX,
  CACHE_CONTROL_NO_STORE,
  EVENTS_PATH,
  MUTATION_HEADER_NAME,
  MUTATION_HEADER_VALUE,
  PROTOCOL_VERSION,
  protocolVersionSchema,
  RESERVED_NAMESPACE,
} from './index';
import { protocolVersionSchema as localSchema } from './version';

/**
 * Protocol version and wire constants (#220 AC: all wire schemas use
 * direct zod@4 with no zod 3 compatibility layer; unsupported protocol
 * versions are rejected; the constants trace to ADR-0006 §7, ADR-0005,
 * ADR-0009).
 */
describe('protocol version and wire constants', () => {
  it('is version 1, exported and re-exported identically', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(protocolVersionSchema).toBe(localSchema);
  });

  it('accepts only the literal 1 — unsupported versions, strings, and absence are rejected', () => {
    expect(protocolVersionSchema.safeParse(1).success).toBe(true);
    expect(protocolVersionSchema.safeParse(2).success).toBe(false);
    expect(protocolVersionSchema.safeParse('1').success).toBe(false);
    expect(protocolVersionSchema.safeParse(undefined).success).toBe(false);
  });

  it('carries the ADR-0006 §7 / ADR-0005 / ADR-0009 wire constants unchanged', () => {
    expect(RESERVED_NAMESPACE).toBe('/__astroix');
    expect(API_V1_PREFIX).toBe('/__astroix/api/v1');
    expect(EVENTS_PATH).toBe('/__astroix/events');
    expect(MUTATION_HEADER_NAME).toBe('X-Astroix-Request');
    expect(MUTATION_HEADER_VALUE).toBe('1');
    expect(CACHE_CONTROL_NO_STORE).toBe('no-store');
  });
});

describe('direct zod 4, no compatibility layer', () => {
  it('resolves a zod 4 API surface (treeifyError exists only in zod 4)', () => {
    expect(typeof z.treeifyError).toBe('function');
  });

  it('declares a zod 4 range in the package manifest', () => {
    // happy-dom patches the global URL, so file paths go through
    // fileURLToPath — never through a URL object into node:fs.
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies.zod).toMatch(/^\^4\./);
  });

  it('imports only the zod root — no zod/v3 or zod/v4 subpath compatibility layer', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sources = readdirSync(here)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => [name, readFileSync(join(here, name), 'utf8')] as const);
    const offenders = sources.filter(([, source]) => /from 'zod\//.test(source));
    expect(offenders.map(([name]) => name)).toEqual([]);
  });
});
