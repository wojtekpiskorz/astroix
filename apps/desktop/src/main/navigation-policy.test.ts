import { describe, expect, it } from 'vitest';
import { createNavigationPolicy, NEUTRAL_DOCUMENT_URL } from './navigation-policy.ts';

/** The top-level navigation policy (#243 focused units): exact-origin membership, never substring. */
describe('createNavigationPolicy', () => {
  it('allows the neutral document unconditionally', () => {
    const policy = createNavigationPolicy([]);
    expect(policy.decideNavigation(NEUTRAL_DOCUMENT_URL)).toBe('allow');
  });

  it('denies everything while no origin is approved', () => {
    const policy = createNavigationPolicy([]);
    expect(policy.decideNavigation('https://astroix.invalid/')).toBe('deny');
    expect(policy.decideNavigation('file:///etc/passwd')).toBe('deny');
    expect(policy.decideNavigation('http://127.0.0.1:4311/')).toBe('deny');
    expect(policy.decideNavigation('http://launcher.localhost:4430/__astroix/app/')).toBe('deny');
  });

  it('allows an approved origin and its paths, denies everything else', () => {
    const policy = createNavigationPolicy(['http://launcher.localhost:4430']);
    expect(policy.decideNavigation('http://launcher.localhost:4430')).toBe('allow');
    expect(policy.decideNavigation('http://launcher.localhost:4430/__astroix/app/')).toBe('allow');
    expect(policy.decideNavigation('http://launcher.localhost:4430/anything?x=1')).toBe('allow');
    expect(policy.decideNavigation('http://launcher.localhost:4431/')).toBe('deny');
    expect(policy.decideNavigation('https://launcher.localhost:4430/')).toBe('deny');
    expect(policy.decideNavigation('http://other.localhost:4430/')).toBe('deny');
  });

  it('never approves by prefix — a lookalike origin is a different origin', () => {
    const policy = createNavigationPolicy(['http://abc.localhost:4430']);
    expect(policy.decideNavigation('http://abcd.localhost:4430/')).toBe('deny');
    expect(policy.decideNavigation('http://abc.localhost.evil.example/4430')).toBe('deny');
  });

  it('grants and revokes origins over the composition lifetime', () => {
    const policy = createNavigationPolicy(['http://launcher.localhost:4430']);
    policy.approveOrigin('http://project.localhost:4430');
    expect(policy.decideNavigation('http://project.localhost:4430/')).toBe('allow');
    expect(policy.approvedOrigins()).toEqual([
      'http://launcher.localhost:4430',
      'http://project.localhost:4430',
    ]);
    policy.revokeOrigin('http://project.localhost:4430');
    expect(policy.decideNavigation('http://project.localhost:4430/')).toBe('deny');
  });

  it('denies exotic schemes outright', () => {
    const policy = createNavigationPolicy(['http://launcher.localhost:4430']);
    expect(policy.decideNavigation('chrome://version')).toBe('deny');
    expect(policy.decideNavigation('data:text/html,hello')).toBe('deny');
    expect(policy.decideNavigation('javascript:1')).toBe('deny');
  });
});
