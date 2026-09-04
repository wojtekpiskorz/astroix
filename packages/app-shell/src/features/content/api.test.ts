import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { AppClientError, createAppClient } from '../../app-client.ts';
import { inspectionFixture } from '../../presentation/fixtures.ts';
import { bindContentInspection, bindRoutesInspection } from './api.ts';
import { contentPayload, routesPayload, scriptDiscoveryWire } from './discovery/test-wire.ts';

/**
 * The Content feature's AppClient contract lane (#251's focused tests):
 * the discovery and route inspection exchanges over the REAL AppClient
 * against a scripted wire — the exact session pair on the wire (the
 * server's freshness input), the stale-generation refusal surfaced as
 * the sanitized protocol error for BOTH families (the executor's
 * `stale-session` — a moved-past generation never delivers a payload),
 * and the fail-closed payload binding (a drifted interior is a
 * compatibility event, never a heuristic parse).
 */

const ORIGIN = 'http://project.localhost:4426';
const CAPABILITY = 'client-capability-fixture';
const PAIR: SessionRef = { runtimeEpoch: 'epoch-fixture', generation: 4 };

const realFetch = globalThis.fetch;
let wire = scriptDiscoveryWire();

afterEach(() => {
  globalThis.fetch = realFetch;
  wire = scriptDiscoveryWire();
});

/** The client over the scripted wire at the fixture pair. */
function client() {
  globalThis.fetch = wire.fetch;
  return createAppClient({ clientCapability: CAPABILITY, origin: ORIGIN });
}

describe('the discovery exchanges carry the exact session pair', () => {
  it('the content inspection posts one inspect envelope with the pair and no mutation marker', async () => {
    const session = client().forSession(PAIR);
    const pending = session.inspect({ kind: 'content' });
    wire.resolveInspect('content', contentPayload({ collections: [] }));
    await pending;
    expect(wire.captured).toHaveLength(1);
    const body = JSON.parse(wire.captured[0]?.body ?? '{}') as {
      protocolVersion: number;
      requestId: string;
      session: SessionRef;
      command: { kind: string; request: { kind: string } };
    };
    expect(body.command).toEqual({ kind: 'inspect', request: { kind: 'content' } });
    expect(body.session).toEqual(PAIR);
    expect(body.protocolVersion).toBe(1);
  });

  it('the routes inspection posts the same envelope shape for its family', async () => {
    const session = client().forSession(PAIR);
    const pending = session.inspect({ kind: 'routes' });
    wire.resolveInspect('routes', routesPayload([]));
    await pending;
    const body = JSON.parse(wire.captured[0]?.body ?? '{}') as {
      command: { request: { kind: string } };
    };
    expect(body.command.request).toEqual({ kind: 'routes' });
  });
});

describe('stale-generation responses are rejected for both families', () => {
  it('a stale-generation content discovery settles the sanitized stale-session protocol error', async () => {
    const session = client().forSession(PAIR);
    const outcome = session.inspect({ kind: 'content' });
    wire.failInspect('content', 'stale-session');
    const error = await outcome.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AppClientError);
    expect((error as AppClientError).kind).toBe('protocol');
    expect((error as AppClientError).envelope?.error.code).toBe('stale-session');
  });

  it('a stale-generation route response settles the same sanitized refusal', async () => {
    const session = client().forSession(PAIR);
    const outcome = session.inspect({ kind: 'routes' });
    wire.failInspect('routes', 'stale-session');
    const error = await outcome.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AppClientError);
    expect((error as AppClientError).envelope?.error.code).toBe('stale-session');
  });
});

describe('the payload binders are fail-closed', () => {
  it('binds the E4 interior and drops every field the discovery UI never reads', () => {
    const collections = inspectionFixture('collections.json');
    const bound = bindContentInspection(
      contentPayload({
        collections: collections.collections.map((collection) => ({
          name: collection.name,
          entries: collection.entries.map((entry) => ({ id: entry.id, filePath: entry.filePath })),
        })),
      }),
    );
    expect(bound?.collections.map((collection) => collection.name)).toEqual([
      'blog',
      'gallery',
      'homepage',
      'notes',
    ]);
    expect(bound?.collections[0]?.entryIds).toEqual([
      '2024/post',
      '2025/release-notes',
      'hello-builder',
    ]);
    // no projected field can carry a path — the projection has none
    expect(JSON.stringify(bound)).not.toContain('src/content');
  });

  it('rejects a drifted content interior — never a heuristic parse', () => {
    expect(bindContentInspection({ collections: 'nope', diagnostics: [] })).toBeNull();
    expect(
      bindContentInspection({ collections: [{ name: '', entries: [] }], diagnostics: [] }),
    ).toBeNull();
    expect(
      bindContentInspection({
        collections: [{ name: 'a', entries: [{ id: 7 }] }],
        diagnostics: [],
      }),
    ).toBeNull();
    expect(
      bindContentInspection({
        collections: [],
        diagnostics: [
          {
            code: 'unknown-loader',
            collection: 'x',
            expected: 'glob()',
            observed: 3 as unknown as string,
          },
        ],
      }),
    ).toBeNull();
    expect(bindContentInspection(null)).toBeNull();
  });

  it('binds the E5 interior to the pure resolver shape — segments, rendering, renders', () => {
    const routes = inspectionFixture('routes.json');
    const bound = bindRoutesInspection(routesPayload(routes.routes));
    expect(bound?.map((route) => route.pattern)).toEqual(['/blog/[slug]', '/blog/[...slug]', '/']);
    expect(bound?.[0]?.rendering).toBe('prerendered');
    expect(bound?.[0]?.renders).toEqual(['hello-builder']);
    expect(bound?.[2]?.renders).toBeUndefined();
    expect(bound?.[1]?.segments[1]?.[0]?.spread).toBe(true);
  });

  it('rejects a drifted routes interior', () => {
    expect(bindRoutesInspection({ revision: 1 })).toBeNull();
    expect(
      bindRoutesInspection(
        routesPayload([{ pattern: 'no-slash', segments: [], params: [], rendering: 'on-demand' }]),
      ),
    ).toBeNull();
    expect(
      bindRoutesInspection(
        routesPayload([
          { pattern: '/a', segments: [], params: [], rendering: 'sometimes' as 'on-demand' },
        ]),
      ),
    ).toBeNull();
    expect(
      bindRoutesInspection(
        routesPayload([
          {
            pattern: '/a/[x]',
            segments: [
              [
                { content: 'a', dynamic: false, spread: false },
                { content: 'x', dynamic: true, spread: 'no' as unknown as boolean },
              ],
            ],
            params: ['x'],
            rendering: 'on-demand',
          },
        ]),
      ),
    ).toBeNull();
    expect(
      bindRoutesInspection(
        routesPayload([
          {
            pattern: '/a',
            segments: [],
            params: [],
            rendering: 'on-demand',
            renders: [3 as unknown as string],
          },
        ]),
      ),
    ).toBeNull();
  });
});
