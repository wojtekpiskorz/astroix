export function classifySqliteBusyError(error) {
  if (
    error?.code !== 'ERR_SQLITE_ERROR' ||
    !Number.isInteger(error?.errcode) ||
    (error.errcode & 0xff) !== 5
  ) {
    return 'other';
  }
  return error.errcode === 5 && error.errstr === 'database is locked'
    ? 'qualified-contention'
    : 'unqualified-busy';
}
