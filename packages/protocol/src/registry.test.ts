import { describe, expect, it } from 'vitest';
import {
  PROJECT_KEY_LENGTH,
  projectAvailabilitySchema,
  projectKeySchema,
  projectSummarySchema,
} from './registry';

/**
 * Registry wire records (ADR-0006 §1): the browser-visible summary is
 * exactly project key, display name, and sanitized availability — roots
 * and process details stay in the control plane.
 */
/** 26 lowercase base32 chars (a-z are all in the base32 alphabet). */
const key = 'abcdefghijklmnopqrstuvwxyz';

describe('projectKeySchema', () => {
  it('is 26 lowercase base32 chars — 128 bits (ceil(128/5)) of entropy', () => {
    expect(PROJECT_KEY_LENGTH).toBe(26);
    expect(projectKeySchema.safeParse(key).success).toBe(true);
    expect(projectKeySchema.safeParse('abcdefghijklmnopqrstuvwxyz'.slice(0, 26)).success).toBe(
      true,
    );
  });

  it('rejects wrong length, uppercase, digits 0/1/8/9, and non-strings', () => {
    expect(projectKeySchema.safeParse(key.slice(1)).success).toBe(false);
    expect(projectKeySchema.safeParse(`${key}a`).success).toBe(false);
    expect(projectKeySchema.safeParse(key.toUpperCase()).success).toBe(false);
    expect(projectKeySchema.safeParse(`0${key.slice(1)}`).success).toBe(false);
    expect(projectKeySchema.safeParse(`1${key.slice(1)}`).success).toBe(false);
    expect(projectKeySchema.safeParse(`8${key.slice(1)}`).success).toBe(false);
    expect(projectKeySchema.safeParse(123).success).toBe(false);
  });
});

describe('projectSummarySchema', () => {
  it('parses the three sanitized fields', () => {
    const summary = {
      projectKey: key,
      displayName: 'site',
      availability: 'available',
    };
    expect(projectSummarySchema.safeParse(summary)).toEqual({ success: true, data: summary });
    expect(projectAvailabilitySchema.safeParse('unavailable').success).toBe(true);
  });

  it('rejects the control-plane facts the browser must never see', () => {
    const base = { projectKey: key, displayName: 'site', availability: 'available' };
    for (const leak of [
      { root: '/Users/owner/site' },
      { path: '/Users/owner/site' },
      { pid: 4242 },
      { port: 4314 },
      { env: { HOME: '/Users/owner' } },
      { process: 'node' },
    ]) {
      expect(projectSummarySchema.safeParse({ ...base, ...leak }).success).toBe(false);
    }
  });

  it('puts the display name behind the disclosure guard like every public free-text field', () => {
    expect(
      projectSummarySchema.safeParse({
        projectKey: key,
        displayName: '~/sites/leak',
        availability: 'available',
      }).success,
    ).toBe(false);
    expect(
      projectSummarySchema.safeParse({
        projectKey: key,
        displayName: 'site /srv/leak',
        availability: 'available',
      }).success,
    ).toBe(false);
  });

  it('rejects an empty display name and off-enum availability', () => {
    expect(
      projectSummarySchema.safeParse({
        projectKey: key,
        displayName: '',
        availability: 'available',
      }).success,
    ).toBe(false);
    expect(
      projectSummarySchema.safeParse({ projectKey: key, displayName: 'site', availability: 'gone' })
        .success,
    ).toBe(false);
  });
});
