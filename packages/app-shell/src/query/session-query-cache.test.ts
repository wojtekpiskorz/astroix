import { describe, expect, it } from 'vitest';
import {
  isSessionQueryKey,
  removeSessionQueries,
  sessionQueryCount,
} from './session-query-cache.ts';
import { createShellQueryClient } from './shell-query-client.ts';

/**
 * The generation-scoped cache discipline's focused lane (#241's AC):
 * every session query key begins with the `['astroix', runtimeEpoch,
 * generation]` triple, and the reset's removal takes exactly the
 * session-scoped entries — the whole cache dies with the session.
 */

const EPOCH = 'epoch-fixture';
const G1 = ['astroix', EPOCH, 1] as const;
const G2 = ['astroix', EPOCH, 2] as const;

describe('isSessionQueryKey', () => {
  it('accepts the generation-scoped triple plus scope', () => {
    expect(isSessionQueryKey([...G1, 'project'])).toBe(true);
    expect(isSessionQueryKey([...G2, 'content', 3])).toBe(true);
  });

  it('rejects wrong roots and malformed pairs — fail closed', () => {
    expect(isSessionQueryKey(['other', EPOCH, 1, 'project'])).toBe(false);
    expect(isSessionQueryKey(['astroix', EPOCH])).toBe(false);
    expect(isSessionQueryKey(['astroix', EPOCH, 'not-a-generation', 'project'])).toBe(false);
    expect(isSessionQueryKey([])).toBe(false);
  });
});

describe('removeSessionQueries', () => {
  it('removes every session-scoped entry when no next pair is kept — the deactivation reset', () => {
    const client = createShellQueryClient();
    client.setQueryData([...G1, 'project'], { revision: 1 });
    client.setQueryData([...G1, 'content'], { revision: 2 });
    client.setQueryData(['unrelated'], { safe: true });
    expect(sessionQueryCount(client)).toBe(2);

    removeSessionQueries(client);
    expect(sessionQueryCount(client)).toBe(0);
    expect(client.getQueryCache().find({ queryKey: ['unrelated'] })).toBeDefined();
  });

  it('keeps exactly the kept pair under a switch — old generations die', () => {
    const client = createShellQueryClient();
    client.setQueryData([...G1, 'project'], { revision: 1 });
    client.setQueryData([...G2, 'project'], { revision: 2 });
    client.setQueryData([...G2, 'routes'], { revision: 3 });

    removeSessionQueries(client, { runtimeEpoch: EPOCH, generation: 2 });
    expect(client.getQueryCache().find({ queryKey: [...G1, 'project'] })).toBeUndefined();
    expect(sessionQueryCount(client)).toBe(2);
  });
});

describe('createShellQueryClient', () => {
  it('builds the doctrine defaults — no blind retries, no focus refetch', () => {
    const client = createShellQueryClient();
    expect(client.getDefaultOptions().queries?.retry).toBe(false);
    expect(client.getDefaultOptions().queries?.refetchOnWindowFocus).toBe(false);
    expect(client.getDefaultOptions().mutations?.retry).toBe(false);
  });
});
