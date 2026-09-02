import { describe, expect, it } from 'vitest';
import { CLIENT_CAPABILITY_HEADER, createClientBindings } from '../../api/http/client-bindings.ts';
import { NEXT_SESSION, SESSION } from './fixtures.ts';

/**
 * The document-bound client authority table (#234; ADR-0006 §3): one
 * editor, up to three diagnostics, server-enforced; resolve is
 * capability-exact; unbinding is revocation. WHEN bindings exist is the
 * Electron host lane's (#246) — THIS table is what the dispatch
 * validates against.
 */

describe('the client binding table', () => {
  it('names the injected header — the contract the Electron host lane implements', () => {
    expect(CLIENT_CAPABILITY_HEADER).toBe('x-astroix-client');
  });

  it('binds and resolves: role, host, and the exact SessionRef come back with the capability', () => {
    const bindings = createClientBindings();
    const bound = bindings.bind({
      role: 'editor',
      host: 'project',
      sessionRef: SESSION,
      capability: 'client-one',
    });
    expect(bound).toEqual({ kind: 'bound', capability: 'client-one' });
    expect(bindings.resolve('client-one')).toEqual({
      role: 'editor',
      host: 'project',
      sessionRef: SESSION,
    });
  });

  it('enforces the server-side role caps: exactly one editor, at most three diagnostics (ADR-0006 §3)', () => {
    const bindings = createClientBindings();
    expect(
      bindings.bind({ role: 'editor', host: 'project', sessionRef: SESSION, capability: 'e1' })
        .kind,
    ).toBe('bound');
    const second = bindings.bind({
      role: 'editor',
      host: 'project',
      sessionRef: SESSION,
      capability: 'e2',
    });
    expect(second).toEqual({ kind: 'refused', reason: 'second-editor' });
    for (const capability of ['d1', 'd2', 'd3']) {
      expect(
        bindings.bind({ role: 'diagnostic', host: 'project', sessionRef: SESSION, capability })
          .kind,
      ).toBe('bound');
    }
    expect(
      bindings.bind({ role: 'diagnostic', host: 'project', sessionRef: SESSION, capability: 'd4' }),
    ).toEqual({ kind: 'refused', reason: 'fourth-diagnostic' });
    expect(bindings.counts()).toEqual({ editor: 1, diagnostic: 3, launcher: 0 });
  });

  it('unbind is revocation: the capability resolves to nothing afterwards — the stale document shape', () => {
    const bindings = createClientBindings();
    bindings.bind({
      role: 'editor',
      host: 'project',
      sessionRef: SESSION,
      capability: 'client-one',
    });
    bindings.unbind('client-one');
    expect(bindings.resolve('client-one')).toBeNull();
    bindings.unbind('client-one'); // idempotent
    expect(bindings.counts().editor).toBe(0);
    // a freed editor seat can be re-bound — the cap counts live bindings
    expect(
      bindings.bind({
        role: 'editor',
        host: 'project',
        sessionRef: NEXT_SESSION,
        capability: 'client-two',
      }).kind,
    ).toBe('bound');
  });

  it('fails closed for missing, empty, and unknown capabilities — including near-miss values', () => {
    const bindings = createClientBindings();
    bindings.bind({
      role: 'editor',
      host: 'project',
      sessionRef: SESSION,
      capability: 'client-one',
    });
    expect(bindings.resolve(undefined)).toBeNull();
    expect(bindings.resolve('')).toBeNull();
    expect(bindings.resolve('client-on')).toBeNull();
    expect(bindings.resolve('client-onee')).toBeNull();
  });

  it('binds the launcher role session-less — the launcher document spans sessions', () => {
    const bindings = createClientBindings();
    bindings.bind({
      role: 'launcher',
      host: 'launcher',
      sessionRef: null,
      capability: 'client-launcher',
    });
    expect(bindings.resolve('client-launcher')).toEqual({
      role: 'launcher',
      host: 'launcher',
      sessionRef: null,
    });
  });

  it('a binding never crosses hosts — the table stores the host the document lives on', () => {
    const bindings = createClientBindings();
    bindings.bind({
      role: 'editor',
      host: 'project',
      sessionRef: SESSION,
      capability: 'client-one',
    });
    const resolved = bindings.resolve('client-one');
    expect(resolved?.host).toBe('project');
    expect(resolved?.host).not.toBe('launcher');
  });
});
