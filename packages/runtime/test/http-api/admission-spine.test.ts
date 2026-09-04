import { describe, expect, it } from 'vitest';
import {
  admitHeadersAndHost,
  checkReadTransportMarkers,
  claimReservedPath,
  malformedTargetRefusal,
  type SessionStateView,
} from '../../api/http/admission-spine.ts';
import { headerEvidence } from '../../api/http/security-headers.ts';
import { createAuthorityFixture, KEY_A, rawPairs } from './fixtures.ts';

/**
 * The shared admission spine's focused legs (#321): the stages the
 * command dispatch and the SSE admission both run, pinned here at their
 * single home — the reserved-path claim head, the rejected-target
 * refusal mapping, the header/host/capability admission, and the reads
 * transport law. The deep matrix legs (every command, every role, the
 * socket truth) stay in the consumers' batteries; these legs pin the
 * spine contract itself so a later consumer inherits it knowingly.
 */

describe('claimReservedPath', () => {
  it('slices the literal pre-query path and reports whether a query rode along', () => {
    expect(claimReservedPath('/__astroix/api/v1')).toEqual({
      kind: 'reserved-path',
      path: '/__astroix/api/v1',
      hasQuery: false,
    });
    expect(claimReservedPath('/__astroix/events?runtimeEpoch=e&generation=1')).toEqual({
      kind: 'reserved-path',
      path: '/__astroix/events',
      hasQuery: true,
    });
    // A bare '?' is no query — nothing follows it.
    expect(claimReservedPath('/__astroix/events?')).toEqual({
      kind: 'reserved-path',
      path: '/__astroix/events',
      hasQuery: false,
    });
  });

  it("re-runs the listener's target classification — absolute-form and ambiguous encodings rejected", () => {
    expect(claimReservedPath('http://launcher.localhost:4321/__astroix/api/v1')).toEqual({
      kind: 'rejected-target',
      reason: 'absolute-form-target',
    });
    expect(claimReservedPath('/__astroix%2Fapi/v1')).toEqual({
      kind: 'rejected-target',
      reason: 'ambiguous-reserved-encoding',
    });
    expect(claimReservedPath(undefined)).toEqual({
      kind: 'rejected-target',
      reason: 'malformed-target',
    });
  });

  it('answers not-reserved for every path outside the namespace', () => {
    expect(claimReservedPath('/')).toEqual({ kind: 'not-reserved' });
    expect(claimReservedPath('/src/pages/index.astro')).toEqual({ kind: 'not-reserved' });
  });
});

describe('malformedTargetRefusal', () => {
  it('maps the ambiguous and invalid target rejections to the two malformed details', async () => {
    const ambiguous = malformedTargetRefusal('ambiguous-reserved-encoding');
    const invalid = malformedTargetRefusal('malformed-target');
    expect(ambiguous.kind).toBe('refused');
    expect(JSON.parse(ambiguous.response.body).error.details).toEqual({
      issue: 'ambiguous-encoding',
    });
    expect(JSON.parse(invalid.response.body).error.details).toEqual({ issue: 'invalid-shape' });
  });
});

describe('admitHeadersAndHost', () => {
  it('admits the launcher host under its capability and derives the expected origin', () => {
    const fixture = createAuthorityFixture();
    const admission = admitHeadersAndHost(
      rawPairs({
        Host: `launcher.localhost:${fixture.port}`,
        Cookie: `__astroix_host=${fixture.launcherCapability}`,
      }),
      fixture.authority,
    );
    expect(admission.kind).toBe('admitted');
    if (admission.kind !== 'admitted') return;
    expect(admission.host).toEqual({
      hostClass: 'launcher',
      capabilityHost: { host: 'launcher' },
      expectedOrigin: `http://launcher.localhost:${fixture.port}`,
    });
  });

  it('admits the one exact active project-key hostname and nothing else on that port', () => {
    const fixture = createAuthorityFixture();
    const admitted = admitHeadersAndHost(
      rawPairs({
        Host: `${KEY_A}.localhost:${fixture.port}`,
        Cookie: `__astroix_host=${fixture.projectCapability}`,
      }),
      fixture.authority,
    );
    expect(admitted.kind).toBe('admitted');
    const other = admitHeadersAndHost(
      rawPairs({
        Host: 'not-the-active-key.localhost:4321',
        Cookie: `__astroix_host=${fixture.launcherCapability}`,
      }),
      fixture.authority,
    );
    expect(other.kind).toBe('refused');
    if (other.kind !== 'refused') return;
    expect(JSON.parse(other.response.body).error.code).toBe('resource-not-found');
  });

  it('refuses a duplicated security-relevant header before any value is read', () => {
    const fixture = createAuthorityFixture();
    const admission = admitHeadersAndHost(
      rawPairs({
        Host: [`launcher.localhost:${fixture.port}`, `launcher.localhost:${fixture.port}`],
        Cookie: `__astroix_host=${fixture.launcherCapability}`,
      }),
      fixture.authority,
    );
    expect(admission.kind).toBe('refused');
    if (admission.kind !== 'refused') return;
    expect(JSON.parse(admission.response.body).error.code).toBe('malformed-request');
  });

  it('refuses a missing or wrong-host capability as unauthorized', () => {
    const fixture = createAuthorityFixture();
    for (const headers of [
      rawPairs({ Host: `launcher.localhost:${fixture.port}` }),
      rawPairs({
        Host: `launcher.localhost:${fixture.port}`,
        Cookie: `__astroix_host=${fixture.projectCapability}`,
      }),
    ]) {
      const admission = admitHeadersAndHost(headers, fixture.authority);
      expect(admission.kind).toBe('refused');
      if (admission.kind !== 'refused') continue;
      expect(JSON.parse(admission.response.body).error.code).toBe('unauthorized');
    }
  });

  it('reads the session state through the injected view — a null projectKey serves no project host', () => {
    const fixture = createAuthorityFixture();
    const state: SessionStateView = fixture.authority.sessionState();
    expect(state.projectKey).toBe(KEY_A);
    fixture.setState({ sessionRef: null, projectKey: null });
    const admission = admitHeadersAndHost(
      rawPairs({
        Host: `${KEY_A}.localhost:${fixture.port}`,
        Cookie: `__astroix_host=${fixture.projectCapability}`,
      }),
      fixture.authority,
    );
    expect(admission.kind).toBe('refused');
  });
});

describe('checkReadTransportMarkers', () => {
  const origin = 'http://launcher.localhost:4321';

  it('admits same-origin Fetch Metadata with or without Origin', () => {
    expect(
      checkReadTransportMarkers(
        headerEvidence(rawPairs({ 'Sec-Fetch-Site': 'same-origin' })),
        origin,
      ),
    ).toBeNull();
    expect(
      checkReadTransportMarkers(
        headerEvidence(rawPairs({ 'Sec-Fetch-Site': 'same-origin', Origin: origin })),
        origin,
      ),
    ).toBeNull();
  });

  it('refuses a cross-site Fetch Metadata, an absent marker set, and a disagreeing Origin — unauthorized', () => {
    for (const headers of [
      rawPairs({ 'Sec-Fetch-Site': 'cross-site' }),
      rawPairs({ Origin: origin }),
      rawPairs({ 'Sec-Fetch-Site': 'same-origin', Origin: 'http://evil.example' }),
    ]) {
      const refusal = checkReadTransportMarkers(headerEvidence(headers), origin);
      expect(refusal?.kind, JSON.stringify(headers)).toBe('refused');
      if (refusal?.kind !== 'refused') continue;
      expect(JSON.parse(refusal.response.body).error.code).toBe('unauthorized');
    }
  });

  it('refuses a read carrying the mutation marker as contradictory evidence — malformed', () => {
    const refusal = checkReadTransportMarkers(
      headerEvidence(rawPairs({ 'Sec-Fetch-Site': 'same-origin', 'X-Astroix-Request': '1' })),
      origin,
    );
    expect(refusal?.kind).toBe('refused');
    if (refusal?.kind !== 'refused') return;
    expect(JSON.parse(refusal.response.body).error.code).toBe('malformed-request');
  });
});
