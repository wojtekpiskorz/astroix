import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findDisclosure } from '@wojciechpiskorz/astroix-protocol';
import { describe, expect, it } from 'vitest';
import { dispatchApiRequest } from '../../api/http/api-dispatch.ts';
import { CAPABILITY_COOKIE_NAME } from '../../api/http/host-capability.ts';
import {
  type AuthorityFixture,
  activateEnvelope,
  applyEditEnvelope,
  createAuthorityFixture,
  deactivateEnvelope,
  inspectEnvelope,
  launcherHeaders,
  listProjectsEnvelope,
  NEXT_SESSION,
  projectHeaders,
} from './fixtures.ts';

/**
 * Output hygiene over the whole F2 surface (#234; ADR-0006 §3 cookie
 * law, §7 output hygiene; ADR-0007 "authorization material never
 * appears in public responses, events, errors, logs, or reports"):
 * across every refusal class — with VALID secrets riding the request —
 * no response byte carries a capability, a client capability, or any
 * disclosure shape; and the surface's own sources contain no logging
 * and exactly one cookie-issuance construction point.
 */

const URL = '/__astroix/api/v1/';

describe('no capability ever answers', () => {
  it('across every refusal class: the response bytes never contain the host capability, the client capability, or the cookie name', async () => {
    const fixture: AuthorityFixture = createAuthorityFixture();
    fixture.failExecutor(new Error(`secret ${fixture.launcherCapability} leaked`));
    const legs: Array<[string, string, string[]]> = [
      ['stale session', inspectEnvelope(NEXT_SESSION), projectHeaders(fixture, 'editor')],
      ['missing capability', listProjectsEnvelope(), launcherHeaders(fixture, { Cookie: true })],
      [
        'stale capability',
        listProjectsEnvelope(),
        launcherHeaders(fixture, { Cookie: `__astroix_host=${'0'.repeat(64)}` }),
      ],
      [
        'missing binding',
        listProjectsEnvelope(),
        launcherHeaders(fixture, { 'X-Astroix-Client': true }),
      ],
      [
        'wrong origin',
        activateEnvelope(),
        launcherHeaders(fixture, { Origin: 'http://evil.example' }, 'mutation'),
      ],
      [
        'missing fetch metadata',
        listProjectsEnvelope(),
        launcherHeaders(fixture, { 'Sec-Fetch-Site': true }),
      ],
      ['wrong role', applyEditEnvelope(), projectHeaders(fixture, 'diagnostic', {}, 'mutation')],
      ['unknown route', listProjectsEnvelope(), launcherHeaders(fixture)],
      ['malformed body', 'not json at all', launcherHeaders(fixture)],
      ['unknown field', listProjectsEnvelope({ rogue: true }), launcherHeaders(fixture)],
      [
        'duplicate header',
        listProjectsEnvelope(),
        [...launcherHeaders(fixture), 'Origin', 'a', 'Origin', 'b'],
      ],
      [
        'wrong content type',
        listProjectsEnvelope(),
        launcherHeaders(fixture, { 'Content-Type': 'text/plain' }),
      ],
      ['executor threw', listProjectsEnvelope(), launcherHeaders(fixture)],
      [
        'deactivate stale',
        deactivateEnvelope(NEXT_SESSION),
        projectHeaders(fixture, 'editor', {}, 'mutation'),
      ],
    ];
    for (const [name, body, headers] of legs) {
      const url = name === 'unknown route' ? '/__astroix/api/v1/none' : URL;
      const draft = await dispatchApiRequest(
        { method: 'POST', url, rawHeaders: headers, body },
        fixture.authority,
      );
      const wire = JSON.stringify({
        status: draft.status,
        headers: draft.headers,
        body: draft.body,
      });
      expect(draft.status, name).toBeGreaterThanOrEqual(400);
      expect(wire, name).not.toContain(fixture.launcherCapability);
      expect(wire, name).not.toContain(fixture.projectCapability);
      expect(wire, name).not.toContain(fixture.launcherClient);
      expect(wire, name).not.toContain(fixture.editorClient);
      expect(wire, name).not.toContain(fixture.diagnosticClient);
      expect(wire, name).not.toContain(CAPABILITY_COOKIE_NAME);
      expect(findDisclosure(draft.body), name).toBeNull();
    }
    // the one leg that reached the executor recorded only the parsed
    // envelope — admission itself admits nothing else out
    expect(fixture.executed).toHaveLength(1);
    expect(fixture.executed[0]?.command.kind).toBe('list-projects');
  });
});

describe('the surface sources (the structural law)', () => {
  const API_ROOT = join(import.meta.dirname, '../../api');
  const sources: Array<{ file: string; text: string }> = [];
  for (const tree of ['http', 'errors']) {
    for (const name of readdirSync(join(API_ROOT, tree))) {
      if (!name.endsWith('.ts')) continue;
      const file = `api/${tree}/${name}`;
      sources.push({ file, text: readFileSync(join(API_ROOT, tree, name), 'utf8') });
    }
  }

  it('contains no logging and no direct output writes — a capability cannot be logged where no log exists', () => {
    expect(sources.length).toBeGreaterThanOrEqual(9); // non-vacuous: every product file is scanned
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/console\./);
      expect(text, file).not.toMatch(/process\.stdout/);
      expect(text, file).not.toMatch(/process\.stderr/);
    }
  });

  it('builds the Set-Cookie shape in exactly one place — host-capability.ts, the single issuance point', () => {
    for (const { file, text } of sources) {
      if (file === 'api/http/host-capability.ts') {
        expect(text).toContain('Path=/; HttpOnly');
        continue;
      }
      expect(text, file).not.toContain('Path=/');
      expect(text, file).not.toMatch(/set-cookie/i);
    }
  });

  it('never places the capability into a URL or a query — no concatenation of the cookie name into a path exists', () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(new RegExp(`${CAPABILITY_COOKIE_NAME}[}]*\\s*\\+`));
      expect(text, file).not.toContain(`?${CAPABILITY_COOKIE_NAME}`);
    }
  });
});
