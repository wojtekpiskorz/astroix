import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { describe, expect, it } from 'vitest';
import {
  type ClientDocument,
  createSessionClients,
} from '../../session-supervisor/clients/session-clients.ts';

/**
 * The #236 focused tests, part 2 — the document-bound client registry
 * (ADR-0006 §3): the server-enforced role caps (one authoritative
 * editor, up to three read-only diagnostics), separately minted
 * capabilities bound to the exact webContents, top-level navigation,
 * and SessionRef, the revocation laws (navigation, renderer loss,
 * session replacement), and every sanitized rejection reason.
 */

const REF_1: SessionRef = { runtimeEpoch: 'epoch-236', generation: 1 };
const REF_2: SessionRef = { runtimeEpoch: 'epoch-236', generation: 2 };
const REF_NEXT_EPOCH: SessionRef = { runtimeEpoch: 'epoch-restart', generation: 1 };

/** The authoritative document under test — webContents 7 at its first navigation. */
const DOC: ClientDocument = { webContentsId: 7, navigationId: 1 };

function bind(
  clients: ReturnType<typeof createSessionClients>,
  role: 'editor' | 'diagnostic',
  document: ClientDocument = DOC,
  sessionRef: SessionRef = REF_1,
): string {
  const result = clients.bind({ role, document, sessionRef });
  if (result.kind !== 'bound')
    throw new Error(`expected the ${role} binding, refused: ${result.reason}`);
  return result.capability;
}

describe('the server-enforced role caps', () => {
  it('binds exactly one editor; a second is refused outright', () => {
    const clients = createSessionClients();
    expect(clients.bind({ role: 'editor', document: DOC, sessionRef: REF_1 }).kind).toBe('bound');
    const second = clients.bind({
      role: 'editor',
      document: { webContentsId: 9, navigationId: 1 },
      sessionRef: REF_2,
    });
    expect(second).toEqual({ kind: 'refused', reason: 'editor-already-bound' });
    expect(clients.counts()).toEqual({ editor: 1, diagnostic: 0 });
  });

  it('binds up to three diagnostics; the fourth is refused outright', () => {
    const clients = createSessionClients();
    for (const webContentsId of [11, 12, 13]) {
      const bound = clients.bind({
        role: 'diagnostic',
        document: { webContentsId, navigationId: 1 },
        sessionRef: REF_1,
      });
      expect(bound.kind).toBe('bound');
    }
    const fourth = clients.bind({
      role: 'diagnostic',
      document: { webContentsId: 14, navigationId: 1 },
      sessionRef: REF_1,
    });
    expect(fourth).toEqual({ kind: 'refused', reason: 'diagnostics-full' });
    expect(clients.counts()).toEqual({ editor: 0, diagnostic: 3 });
  });

  it('revoked bindings free their caps — one editor and three diagnostics are LIVE counts', () => {
    const clients = createSessionClients();
    const first = bind(clients, 'editor');
    clients.revoke(first);
    expect(clients.bind({ role: 'editor', document: DOC, sessionRef: REF_1 }).kind).toBe('bound');
  });
});

describe('separately bound read-only authority', () => {
  it('editor and diagnostic capabilities are distinct minted secrets', () => {
    const clients = createSessionClients();
    const editor = bind(clients, 'editor');
    const diagnostic = bind(clients, 'diagnostic');
    expect(editor).not.toBe(diagnostic);
    expect(editor).toHaveLength(64); // 256-bit hex, the protocol's request-authority species
    expect(diagnostic).toHaveLength(64);
  });

  it('a diagnostic capability never authorizes the editor role — no upgrade path exists', () => {
    const clients = createSessionClients();
    const diagnostic = bind(clients, 'diagnostic');
    expect(
      clients.authorize({
        capability: diagnostic,
        document: DOC,
        sessionRef: REF_1,
        role: 'editor',
      }),
    ).toEqual({ kind: 'rejected', reason: 'wrong-role' });
    // role-agnostic authorization still names the binding's own role
    expect(clients.authorize({ capability: diagnostic, document: DOC, sessionRef: REF_1 })).toEqual(
      {
        kind: 'authorized',
        role: 'diagnostic',
      },
    );
  });

  it('an editor capability authorizes the editor role and the diagnostic read alike', () => {
    const clients = createSessionClients();
    const editor = bind(clients, 'editor');
    for (const role of ['editor', 'diagnostic'] as const) {
      expect(
        clients.authorize({ capability: editor, document: DOC, sessionRef: REF_1, role }),
      ).toEqual({
        kind: 'authorized',
        role: 'editor',
      });
    }
  });
});

describe('exact-triple authorization — the sanitized rejections', () => {
  it('a missing, unknown, or revoked capability is no-binding', () => {
    const clients = createSessionClients();
    const editor = bind(clients, 'editor');
    expect(clients.authorize({ document: DOC, sessionRef: REF_1 })).toEqual({
      kind: 'rejected',
      reason: 'no-binding',
    });
    expect(
      clients.authorize({ capability: 'f'.repeat(64), document: DOC, sessionRef: REF_1 }),
    ).toEqual({
      kind: 'rejected',
      reason: 'no-binding',
    });
    clients.revoke(editor);
    expect(clients.authorize({ capability: editor, document: DOC, sessionRef: REF_1 })).toEqual({
      kind: 'rejected',
      reason: 'no-binding',
    });
  });

  it('a capability never crosses documents: another webContents is wrong-document', () => {
    const clients = createSessionClients();
    const editor = bind(clients, 'editor');
    expect(
      clients.authorize({
        capability: editor,
        document: { webContentsId: 99, navigationId: 1 },
        sessionRef: REF_1,
      }),
    ).toEqual({ kind: 'rejected', reason: 'wrong-document' });
  });

  it('a binding is its exact navigation: a stale navigation of the same webContents is rejected', () => {
    const clients = createSessionClients();
    const editor = bind(clients, 'editor');
    expect(
      clients.authorize({
        capability: editor,
        document: { webContentsId: 7, navigationId: 2 },
        sessionRef: REF_1,
      }),
    ).toEqual({ kind: 'rejected', reason: 'stale-navigation' });
  });

  it('a binding is its exact SessionRef: another generation is stale-session', () => {
    const clients = createSessionClients();
    const editor = bind(clients, 'editor');
    expect(clients.authorize({ capability: editor, document: DOC, sessionRef: REF_2 })).toEqual({
      kind: 'rejected',
      reason: 'stale-session',
    });
    // another epoch (an app restart) is stale the same way
    expect(
      clients.authorize({ capability: editor, document: DOC, sessionRef: REF_NEXT_EPOCH }),
    ).toEqual({
      kind: 'rejected',
      reason: 'stale-session',
    });
  });
});

describe('the revocation laws (ADR-0006 §3)', () => {
  it('a new top-level navigation revokes that webContents\u2019 older bindings only', () => {
    const clients = createSessionClients();
    const editor = bind(clients, 'editor');
    const otherWindow = bind(clients, 'diagnostic', { webContentsId: 21, navigationId: 5 });

    clients.navigated({ webContentsId: 7, navigationId: 2 });

    expect(clients.authorize({ capability: editor, document: DOC, sessionRef: REF_1 })).toEqual({
      kind: 'rejected',
      reason: 'no-binding',
    });
    expect(clients.counts()).toEqual({ editor: 0, diagnostic: 1 });
    // the other webContents' binding survived untouched
    expect(
      clients.authorize({
        capability: otherWindow,
        document: { webContentsId: 21, navigationId: 5 },
        sessionRef: REF_1,
      }),
    ).toEqual({ kind: 'authorized', role: 'diagnostic' });
  });

  it('re-navigating to the same navigation id is a no-op — a document is its exact navigation', () => {
    const clients = createSessionClients();
    const editor = bind(clients, 'editor');
    clients.navigated(DOC);
    expect(clients.authorize({ capability: editor, document: DOC, sessionRef: REF_1 })).toEqual({
      kind: 'authorized',
      role: 'editor',
    });
  });

  it('renderer loss revokes every binding of that webContents', () => {
    const clients = createSessionClients();
    const editor = bind(clients, 'editor');
    const diagnostic = bind(clients, 'diagnostic', { webContentsId: 7, navigationId: 3 });
    clients.rendererLost(7);
    expect(clients.counts()).toEqual({ editor: 0, diagnostic: 0 });
    expect(clients.authorize({ capability: editor, document: DOC, sessionRef: REF_1 }).kind).toBe(
      'rejected',
    );
    void diagnostic;
  });

  it('session replacement revokes exactly that session\u2019s bindings', () => {
    const clients = createSessionClients();
    const ref1Editor = bind(clients, 'editor', DOC, REF_1);
    const ref1Diagnostic = bind(
      clients,
      'diagnostic',
      { webContentsId: 8, navigationId: 1 },
      REF_1,
    );
    const ref2Diagnostic = bind(
      clients,
      'diagnostic',
      { webContentsId: 9, navigationId: 1 },
      REF_2,
    );

    clients.revokeSession(REF_1);

    expect(
      clients.authorize({ capability: ref1Editor, document: DOC, sessionRef: REF_1 }).kind,
    ).toBe('rejected');
    expect(
      clients.authorize({
        capability: ref1Diagnostic,
        document: { webContentsId: 8, navigationId: 1 },
        sessionRef: REF_1,
      }).kind,
    ).toBe('rejected');
    expect(
      clients.authorize({
        capability: ref2Diagnostic,
        document: { webContentsId: 9, navigationId: 1 },
        sessionRef: REF_2,
      }),
    ).toEqual({ kind: 'authorized', role: 'diagnostic' });
    expect(clients.counts()).toEqual({ editor: 0, diagnostic: 1 });
  });
});
