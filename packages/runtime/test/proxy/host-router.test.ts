import { describe, expect, it } from 'vitest';
import { createHostRouter } from '../../origin/host-router.ts';
import { KEY_A, KEY_B } from './stand-ins.ts';

/**
 * The routing state machine's focused tests (#233): exact-hostname
 * routing with ONE active lease, retired hosts staying retired for the
 * router's lifetime, grant refusal while occupied, and the refusal
 * order the ADR-0006 switch protocol forces (revoke before re-grant).
 */

const PORT = 4405;

describe('createHostRouter', () => {
  it('routes the launcher host always, with or without the port, case-insensitively', () => {
    const router = createHostRouter({ expectedPort: PORT });
    expect(router.resolve({ hostValue: 'launcher.localhost', hostHeaderCount: 1 })).toEqual({
      kind: 'launcher',
    });
    expect(router.resolve({ hostValue: `LAUNCHER.localhost:${PORT}`, hostHeaderCount: 1 })).toEqual(
      {
        kind: 'launcher',
      },
    );
  });

  it('refuses unknown and malformed Host evidence before any route exists', () => {
    const router = createHostRouter({ expectedPort: PORT });
    expect(router.resolve({ hostValue: 'nobody.localhost', hostHeaderCount: 1 })).toEqual({
      kind: 'unknown-host',
    });
    expect(router.resolve({ hostValue: 'rebind.example', hostHeaderCount: 1 })).toEqual({
      kind: 'unknown-host',
    });
    expect(router.resolve({ hostValue: undefined, hostHeaderCount: 0 })).toEqual({
      kind: 'rejected',
      reason: 'missing-host',
    });
    expect(router.resolve({ hostValue: 'a', hostHeaderCount: 2 })).toEqual({
      kind: 'rejected',
      reason: 'duplicate-host',
    });
  });

  it('routes the exact active project hostname and nothing adjacent', () => {
    const router = createHostRouter({ expectedPort: PORT });
    expect(router.grant(KEY_A)).toEqual({ kind: 'granted', hostname: `${KEY_A}.localhost` });
    expect(router.activeProjectKey).toBe(KEY_A);
    expect(router.resolve({ hostValue: `${KEY_A}.localhost`, hostHeaderCount: 1 })).toEqual({
      kind: 'project',
      projectKey: KEY_A,
    });
    // adjacent names — suffix, prefix, sub-domain, foreign — never route
    expect(router.resolve({ hostValue: `x${KEY_A}.localhost`, hostHeaderCount: 1 })).toEqual({
      kind: 'unknown-host',
    });
    expect(
      router.resolve({ hostValue: `${KEY_A}.localhost.evil.example`, hostHeaderCount: 1 }),
    ).toEqual({
      kind: 'unknown-host',
    });
    expect(router.resolve({ hostValue: `${KEY_B}.localhost`, hostHeaderCount: 1 })).toEqual({
      kind: 'unknown-host',
    });
  });

  it('answers retired-host for a revoked lease and keeps answering it after a successor', () => {
    const router = createHostRouter({ expectedPort: PORT });
    router.grant(KEY_A);
    expect(router.revoke(KEY_A)).toBe(true);
    expect(router.resolve({ hostValue: `${KEY_A}.localhost`, hostHeaderCount: 1 })).toEqual({
      kind: 'retired-host',
    });
    router.grant(KEY_B);
    expect(router.resolve({ hostValue: `${KEY_A}.localhost`, hostHeaderCount: 1 })).toEqual({
      kind: 'retired-host',
    });
    expect(router.resolve({ hostValue: `${KEY_B}.localhost`, hostHeaderCount: 1 })).toEqual({
      kind: 'project',
      projectKey: KEY_B,
    });
  });

  it('re-admits a previously retired host as a fresh lease (the A-to-B-to-A shape)', () => {
    const router = createHostRouter({ expectedPort: PORT });
    router.grant(KEY_A);
    router.revoke(KEY_A);
    router.grant(KEY_B);
    router.revoke(KEY_B);
    expect(router.grant(KEY_A)).toEqual({ kind: 'granted', hostname: `${KEY_A}.localhost` });
    expect(router.resolve({ hostValue: `${KEY_A}.localhost`, hostHeaderCount: 1 })).toEqual({
      kind: 'project',
      projectKey: KEY_A,
    });
  });

  it('refuses a second grant while a lease is active and invalid keys outright', () => {
    const router = createHostRouter({ expectedPort: PORT });
    router.grant(KEY_A);
    expect(router.grant(KEY_B)).toEqual({ kind: 'refused', reason: 'lease-occupied' });
    expect(router.grant(KEY_A)).toEqual({ kind: 'refused', reason: 'lease-occupied' });
    expect(router.grant('0abcdefghijklmnopqrstuvw')).toEqual({
      kind: 'refused',
      reason: 'invalid-project-key',
    });
    expect(router.grant('short')).toEqual({ kind: 'refused', reason: 'invalid-project-key' });
    router.revoke(KEY_A);
    expect(router.grant(KEY_B)).toEqual({ kind: 'granted', hostname: `${KEY_B}.localhost` });
  });

  it('revoke is idempotent and only the active lease retires', () => {
    const router = createHostRouter({ expectedPort: PORT });
    expect(router.revoke(KEY_A)).toBe(false);
    router.grant(KEY_A);
    expect(router.revoke(KEY_B)).toBe(false);
    expect(router.activeProjectKey).toBe(KEY_A);
    expect(router.revoke(KEY_A)).toBe(true);
    expect(router.activeProjectKey).toBeNull();
    expect(router.revoke(KEY_A)).toBe(false);
  });
});
