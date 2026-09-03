import { describe, expect, it } from 'vitest';
import {
  activateRequest,
  bootedReport,
  deactivateRequest,
  parseDesktopChildReport,
  parseDesktopChildRequest,
  registerResultReport,
  registerRootRequest,
  transitionResultReport,
} from './child-protocol.ts';

/**
 * The private channel vocabulary's focused units (#243): closed unions —
 * valid messages lift, drifted or hostile shapes drop (`null`), never a
 * heuristic parse. The fail-closed law at the protocol boundary.
 */

const SESSION_REF = { runtimeEpoch: 'epoch-1', generation: 2 };

describe('parseDesktopChildRequest', () => {
  it('lifts each valid request kind', () => {
    expect(parseDesktopChildRequest(registerRootRequest(1, '/a/root'))).toEqual({
      astroix: 'astroix.desktop-private-channel',
      kind: 'register-root',
      requestId: 1,
      root: '/a/root',
    });
    expect(parseDesktopChildRequest(activateRequest(2, 'key123'))).toMatchObject({
      kind: 'activate',
      requestId: 2,
      projectKey: 'key123',
    });
    expect(parseDesktopChildRequest(deactivateRequest(3, SESSION_REF))).toMatchObject({
      kind: 'deactivate',
      requestId: 3,
    });
  });

  it('drops unknown kinds, wrong tags, and garbage', () => {
    expect(parseDesktopChildRequest({ astroix: 'other-tag', kind: 'register-root' })).toBeNull();
    expect(parseDesktopChildRequest('a string')).toBeNull();
    expect(parseDesktopChildRequest(null)).toBeNull();
    expect(
      parseDesktopChildRequest({
        astroix: 'astroix.desktop-private-channel',
        kind: 'unknown-kind',
        requestId: 1,
      }),
    ).toBeNull();
    expect(
      parseDesktopChildRequest({
        astroix: 'astroix.desktop-private-channel',
        kind: 'register-root',
        requestId: 0,
        root: '/a/root',
      }),
    ).toBeNull();
  });

  it('drops a register-root without a root and a deactivate without a valid reference', () => {
    expect(
      parseDesktopChildRequest({
        astroix: 'astroix.desktop-private-channel',
        kind: 'register-root',
        requestId: 1,
        root: '',
      }),
    ).toBeNull();
    expect(
      parseDesktopChildRequest({
        astroix: 'astroix.desktop-private-channel',
        kind: 'deactivate',
        requestId: 1,
        sessionRef: { runtimeEpoch: '', generation: 2 },
      }),
    ).toBeNull();
    expect(
      parseDesktopChildRequest({
        astroix: 'astroix.desktop-private-channel',
        kind: 'deactivate',
        requestId: 1,
        sessionRef: { runtimeEpoch: 'epoch-1', generation: 0 },
      }),
    ).toBeNull();
  });
});

describe('parseDesktopChildReport', () => {
  it('lifts the booted and session-state reports', () => {
    expect(parseDesktopChildReport(bootedReport())).toMatchObject({ kind: 'booted' });
    expect(
      parseDesktopChildReport({
        astroix: 'astroix.desktop-private-channel',
        kind: 'session-state',
        sessionRef: SESSION_REF,
      }),
    ).toMatchObject({ kind: 'session-state', sessionRef: SESSION_REF });
    expect(
      parseDesktopChildReport({
        astroix: 'astroix.desktop-private-channel',
        kind: 'session-state',
        sessionRef: null,
      }),
    ).toMatchObject({ kind: 'session-state', sessionRef: null });
  });

  it('lifts correlated register and transition results', () => {
    const summary = {
      projectKey: 'key123',
      displayName: 'site',
      availability: 'available',
    } as const;
    expect(parseDesktopChildReport(registerResultReport(7, { ok: true, summary }))).toMatchObject({
      kind: 'register-result',
      requestId: 7,
    });
    expect(
      parseDesktopChildReport(registerResultReport(8, { ok: false, code: 'root-unavailable' })),
    ).toMatchObject({ kind: 'register-result', requestId: 8 });
    expect(
      parseDesktopChildReport(
        registerResultReport(8, { ok: false, code: 'made-up-code' } as never),
      ),
    ).toBeNull();
    expect(
      parseDesktopChildReport(
        transitionResultReport(9, { kind: 'refused', reason: 'stale-session' }),
      ),
    ).toMatchObject({ kind: 'transition-result', requestId: 9 });
    expect(
      parseDesktopChildReport(
        transitionResultReport(9, { kind: 'completed', sessionRef: SESSION_REF }),
      ),
    ).toMatchObject({ kind: 'transition-result' });
  });

  it('drops drifted reports — unknown fields on closed codes fail closed', () => {
    expect(
      parseDesktopChildReport(
        transitionResultReport(9, { kind: 'refused', reason: 'not-a-reason' } as never),
      ),
    ).toBeNull();
    expect(
      parseDesktopChildReport({
        astroix: 'astroix.desktop-private-channel',
        kind: 'register-result',
        requestId: 1,
        result: { ok: true, summary: { projectKey: 'k', displayName: 'd', availability: 'maybe' } },
      }),
    ).toBeNull();
    expect(parseDesktopChildReport({ kind: 'booted' })).toBeNull();
  });
});
