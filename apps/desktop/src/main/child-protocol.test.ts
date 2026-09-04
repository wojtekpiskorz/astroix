import { describe, expect, it } from 'vitest';
import {
  activateRequest,
  authorityObservationRequest,
  authorityObservationResultReport,
  bootedReport,
  deactivateRequest,
  documentCapabilityReport,
  hostObservationResultRequest,
  listProjectsRequest,
  observeDocumentRequest,
  parseDesktopChildReport,
  parseDesktopChildRequest,
  projectsResultReport,
  registerResultReport,
  registerRootRequest,
  replaceTopLevelRequest,
  sessionStateReport,
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
    expect(parseDesktopChildRequest(listProjectsRequest(4))).toEqual({
      astroix: 'astroix.desktop-private-channel',
      kind: 'list-projects',
      requestId: 4,
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
    // an extra top-level field is a drifted envelope — the closed shape
    // fences the whole message, not just the nested result shapes
    expect(
      parseDesktopChildRequest({
        ...registerRootRequest(1, '/a/root'),
        evil: true,
      } as never),
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
    expect(parseDesktopChildReport(bootedReport(4426))).toMatchObject({
      kind: 'booted',
      port: 4426,
    });
    // The booted port is closed vocabulary: zero, non-integers, and
    // out-of-range values are drifted, never parsed.
    expect(
      parseDesktopChildReport({
        astroix: 'astroix.desktop-private-channel',
        kind: 'booted',
        port: 0,
      }),
    ).toBeNull();
    expect(
      parseDesktopChildReport({
        astroix: 'astroix.desktop-private-channel',
        kind: 'booted',
        port: 65536,
      }),
    ).toBeNull();
    expect(parseDesktopChildReport(bootedReport(1))).toMatchObject({ kind: 'booted', port: 1 });
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

  it('lifts the H7 composition vocabulary — the handshake asks, the observation replies, the capability feed', () => {
    // The adoption handshake: the child asks (reports), main replies (requests).
    expect(parseDesktopChildReport(observeDocumentRequest(11))).toMatchObject({
      kind: 'observe-document',
      requestId: 11,
    });
    expect(
      parseDesktopChildReport(
        replaceTopLevelRequest({
          requestId: 12,
          sessionRef: SESSION_REF,
          projectKey: 'key123',
          origin: 'http://key123.localhost:4426',
        }),
      ),
    ).toMatchObject({ kind: 'replace-top-level', requestId: 12 });
    expect(
      parseDesktopChildReport(
        replaceTopLevelRequest({
          requestId: 12,
          sessionRef: SESSION_REF,
          projectKey: 'key123',
          origin: 'file:///etc',
        }),
      ),
    ).toBeNull(); // the origin vocabulary is loopback http, never a file target
    expect(
      parseDesktopChildRequest(
        hostObservationResultRequest(11, true, { webContentsId: 3, navigationId: 2 }),
      ),
    ).toMatchObject({
      kind: 'host-observation-result',
      requestId: 11,
      observed: true,
      document: { webContentsId: 3, navigationId: 2 },
    });
    expect(parseDesktopChildRequest(hostObservationResultRequest(12, false, null))).toMatchObject({
      kind: 'host-observation-result',
      requestId: 12,
      observed: false,
    });
    expect(
      parseDesktopChildRequest({
        astroix: 'astroix.desktop-private-channel',
        kind: 'host-observation-result',
        requestId: 13,
        observed: true,
        document: null,
      }),
    ).toBeNull(); // an observed reply without a document is drift, never a guess
    expect(() => hostObservationResultRequest(13, true, null)).toThrow(); // the builder never launders the defect
    // The authority observations: main forwards, the child acknowledges.
    expect(
      parseDesktopChildRequest(
        authorityObservationRequest(14, { kind: 'revoked', capability: 'cap-1' }),
      ),
    ).toMatchObject({ kind: 'authority-observation', requestId: 14 });
    expect(
      parseDesktopChildRequest(
        authorityObservationRequest(14, {
          kind: 'document-navigated',
          webContentsId: 3,
          navigationId: 0,
        }),
      ),
    ).toBeNull(); // the navigation counter is monotonic from 1
    expect(parseDesktopChildReport(authorityObservationResultReport(14))).toMatchObject({
      kind: 'authority-observation-result',
      requestId: 14,
    });
    // The capability feed: the live value, and the clear.
    expect(parseDesktopChildReport(documentCapabilityReport(3, 'cap-1'))).toMatchObject({
      kind: 'document-capability',
      webContentsId: 3,
      capability: 'cap-1',
    });
    expect(parseDesktopChildReport(documentCapabilityReport(3, null))).toMatchObject({
      kind: 'document-capability',
      capability: null,
    });
    expect(parseDesktopChildReport(documentCapabilityReport(0, 'cap-1'))).toBeNull();
    // The session-state report builder round-trips.
    expect(parseDesktopChildReport(sessionStateReport(SESSION_REF))).toMatchObject({
      kind: 'session-state',
      sessionRef: SESSION_REF,
    });
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
    // extra top-level fields on otherwise-valid envelopes drop too
    expect(
      parseDesktopChildReport({
        astroix: 'astroix.desktop-private-channel',
        kind: 'booted',
        extra: true,
      }),
    ).toBeNull();
    expect(
      parseDesktopChildReport({
        ...registerResultReport(1, { ok: false, code: 'root-unavailable' }),
        surplus: 'field',
      } as never),
    ).toBeNull();
  });

  it('lifts the boot-time listing ask and its sanitized answer (#367)', () => {
    // The ask: main requests the registry's persisted records.
    expect(
      parseDesktopChildRequest({ ...listProjectsRequest(4), extra: true } as never),
    ).toBeNull();
    expect(
      parseDesktopChildRequest({
        astroix: 'astroix.desktop-private-channel',
        kind: 'list-projects',
        requestId: 0,
      }),
    ).toBeNull();
    // The answer: the sanitized summaries lift; one drifted entry drops
    // the whole reply, never a partial parse.
    const summaries = [
      { projectKey: 'key1', displayName: 'site', availability: 'available' },
      { projectKey: 'key2', displayName: 'gone', availability: 'unavailable' },
    ] as const;
    expect(parseDesktopChildReport(projectsResultReport(5, { ok: true, summaries }))).toMatchObject(
      { kind: 'projects-result', requestId: 5 },
    );
    expect(
      parseDesktopChildReport(
        projectsResultReport(5, {
          ok: true,
          summaries: [
            ...summaries,
            { projectKey: 'key3', displayName: 'x', availability: 'maybe' },
          ],
        } as never),
      ),
    ).toBeNull();
    expect(
      parseDesktopChildReport(
        projectsResultReport(5, { ok: true, summaries: { not: 'an-array' } } as never),
      ),
    ).toBeNull();
    expect(
      parseDesktopChildReport(
        projectsResultReport(5, { ok: false, code: 'control-plane-unavailable' }),
      ),
    ).toMatchObject({ kind: 'projects-result', requestId: 5 });
    expect(
      parseDesktopChildReport(projectsResultReport(5, { ok: false, code: 'made-up' } as never)),
    ).toBeNull();
    expect(
      parseDesktopChildReport({
        ...projectsResultReport(5, { ok: true, summaries }),
        surplus: 'field',
      } as never),
    ).toBeNull();
  });
});
