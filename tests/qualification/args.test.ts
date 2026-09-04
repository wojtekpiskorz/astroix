import { describe, expect, it } from 'vitest';
import {
  describeArgumentRejection,
  parseQualificationArguments,
} from '../../scripts/qualification/args.ts';

/**
 * The argument law of the qualification harness (#258, L1 focused
 * tests): the artifact, expected checksum, and evidence directory are
 * accepted exclusively as explicit flags — every implicit, ambiguous,
 * or malformed form rejects. Pure units over argv slices; the
 * environment-derived-selection negatives live in
 * `cli-arguments.test.ts` (the real CLI subprocess with planted decoy
 * environment variables).
 */

const VALID_SHA = 'a'.repeat(64);

describe('the qualification argument law (#258)', () => {
  it('accepts the three explicit required parameters', () => {
    const parsed = parseQualificationArguments([
      '--artifact',
      '/tmp/candidate.zip',
      '--expected-sha256',
      VALID_SHA,
      '--evidence',
      '/tmp/evidence',
    ]);
    expect(parsed).toEqual({
      artifact: '/tmp/candidate.zip',
      expectedSha256: VALID_SHA,
      evidenceDir: '/tmp/evidence',
      settleMs: 30_000,
      quitTimeoutMs: 90_000,
    });
  });

  it('rejects every one of the three missing — candidates are never implicit', () => {
    expect(
      parseQualificationArguments(['--expected-sha256', VALID_SHA, '--evidence', '/e']),
    ).toEqual({ code: 'missing-required', flag: '--artifact' });
    expect(parseQualificationArguments(['--artifact', '/a.zip', '--evidence', '/e'])).toEqual({
      code: 'missing-required',
      flag: '--expected-sha256',
    });
    expect(
      parseQualificationArguments(['--artifact', '/a.zip', '--expected-sha256', VALID_SHA]),
    ).toEqual({ code: 'missing-required', flag: '--evidence' });
  });

  it('rejects an empty argv outright', () => {
    expect(parseQualificationArguments([])).toEqual({
      code: 'missing-required',
      flag: '--artifact',
    });
  });

  it('rejects unknown flags, duplicates, missing values, and positional leftovers', () => {
    expect(
      parseQualificationArguments([
        '--artifact',
        '/a.zip',
        '--expected-sha256',
        VALID_SHA,
        '--evidence',
        '/e',
        '--label',
        'x',
      ]),
    ).toEqual({ code: 'unknown-flag', flag: '--label' });
    expect(
      parseQualificationArguments([
        '--artifact',
        '/a.zip',
        '--artifact',
        '/b.zip',
        '--expected-sha256',
        VALID_SHA,
        '--evidence',
        '/e',
      ]),
    ).toEqual({ code: 'duplicate', flag: '--artifact' });
    expect(
      parseQualificationArguments([
        '--artifact',
        '--expected-sha256',
        VALID_SHA,
        '--evidence',
        '/e',
      ]),
    ).toEqual({ code: 'value-absent', flag: '--artifact' });
    expect(
      parseQualificationArguments([
        '--artifact',
        '/a.zip',
        '--expected-sha256',
        VALID_SHA,
        '--evidence',
        '/e',
        'leftover',
      ]),
    ).toEqual({ code: 'positional-argument', value: 'leftover' });
  });

  it('rejects malformed checksums — 64 lower-case hex digits or nothing', () => {
    expect(
      parseQualificationArguments([
        '--artifact',
        '/a.zip',
        '--expected-sha256',
        'XYZ',
        '--evidence',
        '/e',
      ]),
    ).toEqual({ code: 'malformed-sha256', value: 'XYZ' });
    expect(
      parseQualificationArguments([
        '--artifact',
        '/a.zip',
        '--expected-sha256',
        'A'.repeat(64),
        '--evidence',
        '/e',
      ]),
    ).toEqual({ code: 'malformed-sha256', value: 'A'.repeat(64) });
    expect(
      parseQualificationArguments([
        '--artifact',
        '/a.zip',
        '--expected-sha256',
        VALID_SHA.slice(0, 63),
        '--evidence',
        '/e',
      ]),
    ).toEqual({ code: 'malformed-sha256', value: VALID_SHA.slice(0, 63) });
  });

  it('accepts the optional duration knobs and rejects malformed ones', () => {
    const parsed = parseQualificationArguments([
      '--artifact',
      '/a.zip',
      '--expected-sha256',
      VALID_SHA,
      '--evidence',
      '/e',
      '--settle-ms',
      '5000',
      '--quit-timeout-ms',
      '1000',
    ]);
    expect(parsed).toMatchObject({ settleMs: 5000, quitTimeoutMs: 1000 });
    expect(
      parseQualificationArguments([
        '--artifact',
        '/a.zip',
        '--expected-sha256',
        VALID_SHA,
        '--evidence',
        '/e',
        '--settle-ms',
        'soon',
      ]),
    ).toEqual({ code: 'malformed-duration', flag: '--settle-ms', value: 'soon' });
    expect(
      parseQualificationArguments([
        '--artifact',
        '/a.zip',
        '--expected-sha256',
        VALID_SHA,
        '--evidence',
        '/e',
        '--quit-timeout-ms',
        '-5',
      ]),
    ).toEqual({ code: 'malformed-duration', flag: '--quit-timeout-ms', value: '-5' });
  });

  it('describes every rejection shape for the CLI usage error', () => {
    expect(describeArgumentRejection({ code: 'missing-required', flag: '--artifact' })).toContain(
      'never implicit',
    );
    expect(describeArgumentRejection({ code: 'duplicate', flag: '--artifact' })).toContain(
      'ambiguous',
    );
    expect(describeArgumentRejection({ code: 'malformed-sha256', value: 'z' })).toContain('64');
  });
});
