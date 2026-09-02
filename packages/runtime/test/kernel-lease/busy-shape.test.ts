import { describe, expect, it } from 'vitest';
import { classifySqliteBusyShape } from '../../kernel-lease/busy-shape.ts';

/**
 * The busy-shape drift matrix (#222 focused tests; #209's exact
 * classification): only the exact SQLite busy shape on the qualified pin
 * is contention, every drift fails closed as unqualified, and nothing
 * else ever becomes contention. The shapes here are constructed; the
 * real kernel-produced shape is captured live in kernel-lease.test.ts
 * and the process lane.
 */

function sqliteError(overrides: Record<string, unknown> = {}): Error {
  const error = new Error('SQLITE_BUSY: database is locked');
  Object.assign(error, { code: 'ERR_SQLITE_ERROR', errcode: 5, errstr: 'database is locked' });
  return Object.assign(error, overrides);
}

describe('classifySqliteBusyShape', () => {
  it('classifies the exact qualified shape as contention', () => {
    expect(classifySqliteBusyShape(sqliteError())).toBe('qualified-contention');
  });

  it('drifts on a changed errstr — never contention', () => {
    expect(classifySqliteBusyShape(sqliteError({ errstr: 'database is locked ' }))).toBe(
      'unqualified-busy',
    );
    expect(classifySqliteBusyShape(sqliteError({ errstr: undefined }))).toBe('unqualified-busy');
  });

  it('drifts on an extended busy code — the low byte alone does not qualify', () => {
    expect(classifySqliteBusyShape(sqliteError({ errcode: 261 }))).toBe('unqualified-busy');
    expect(classifySqliteBusyShape(sqliteError({ errcode: 517 }))).toBe('unqualified-busy');
  });

  it('treats a non-busy SQLite result code as other, not contention', () => {
    expect(
      classifySqliteBusyShape(sqliteError({ errcode: 6, errstr: 'database table is locked' })),
    ).toBe('other');
  });

  it('treats a foreign error code as other', () => {
    expect(classifySqliteBusyShape(sqliteError({ code: 'ERR_FS_EISDIR' }))).toBe('other');
  });

  it('treats missing or non-integer errcode as other', () => {
    expect(classifySqliteBusyShape(sqliteError({ errcode: undefined }))).toBe('other');
    expect(classifySqliteBusyShape(sqliteError({ errcode: 5.5 }))).toBe('other');
    expect(classifySqliteBusyShape(sqliteError({ errcode: '5' }))).toBe('other');
  });

  it('never classifies non-error input', () => {
    expect(classifySqliteBusyShape(undefined)).toBe('other');
    expect(classifySqliteBusyShape(null)).toBe('other');
    expect(classifySqliteBusyShape('database is locked')).toBe('other');
    expect(classifySqliteBusyShape(new Error('database is locked'))).toBe('other');
  });
});
