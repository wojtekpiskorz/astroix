/**
 * The SQLite busy-shape classifier (#209's resolution, the only qualified
 * contention shape): a thrown `node:sqlite` error is contention **only**
 * when it is exactly `{ code: 'ERR_SQLITE_ERROR', errcode: 5, errstr:
 * 'database is locked' }` on the qualified runtime pin. A busy-looking
 * error that drifted from that shape (`errcode` 5 with a different
 * `errstr`, or an extended busy code such as 261) is
 * `unqualified-busy` — it fails closed as a runtime-qualification
 * failure, never as successful contention. Everything else is `other`.
 *
 * Pure over `unknown` so the drift matrix is unit-testable without
 * manufacturing real SQLite errors: only the kernel can produce the real
 * shape, and the process-lane tests capture it live.
 */

/** The closed classification of a thrown SQLite error at acquisition. */
export type SqliteBusyShape = 'qualified-contention' | 'unqualified-busy' | 'other';

/** SQLite's `SQLITE_BUSY` result code; the only code family in scope here. */
const SQLITE_BUSY = 5;

export function classifySqliteBusyShape(error: unknown): SqliteBusyShape {
  if (errorProperty(error, 'code') !== 'ERR_SQLITE_ERROR') return 'other';
  const errcode = errorProperty(error, 'errcode');
  if (typeof errcode !== 'number' || !Number.isInteger(errcode)) return 'other';
  if ((errcode & 0xff) !== SQLITE_BUSY) return 'other';
  return errcode === SQLITE_BUSY && errorProperty(error, 'errstr') === 'database is locked'
    ? 'qualified-contention'
    : 'unqualified-busy';
}

/** Reads one own property of a thrown value; node:sqlite errors are plain objects. */
export function errorProperty(error: unknown, key: string): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  return (error as Record<string, unknown>)[key];
}
