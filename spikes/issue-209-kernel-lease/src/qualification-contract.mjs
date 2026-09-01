export const REQUIRED_QUALIFICATION_CASES = Object.freeze([
  'exposes only fixed process-lifetime acquisition calls',
  'rejects an unqualified bundled Node pin before touching private state',
  'accepts only the exact Node 24.20.0 SQLite contention error shape',
  'the qualification gate rejects any missing or duplicate required case',
  'first creation holds one fixed lease in private local state',
  'barrier-started processes allow exactly one holder for the same lease',
  'instrumentation failures cannot alter lease authority outcomes',
  'different fixed lease names can be held concurrently',
  'clean process exit releases the lease without unlinking its file',
  'a lease remains exclusive through later synchronous exit listeners',
  'SIGKILL releases the lease without stale-owner recovery',
  'a live orphaned edit executor excludes replacement until that process exits',
  'returns only the verified fixed bundled Node executable',
  'missing bundled Node fails closed without trying PATH or a system runtime',
  'tampered bundled Node fails before spawn',
  'an unqualified manifest pin fails before spawn',
  'tampered runtime code fails before import or spawn',
  'an unmanifested runtime file fails the fixed inventory',
  'pins the official Node 24.20.0 darwin arm64 archive',
  'pins the official Node 24.20.0 linux x64 archive',
  'rejects an unqualified platform instead of choosing another Node',
  'a timed-out qualification kills its complete process group',
]);

export function assertRequiredCaseSet(tapOutput) {
  const observed = tapOutput
    .split(/\r?\n/)
    .filter((line) => line.startsWith('# Subtest: '))
    .map((line) => line.slice('# Subtest: '.length))
    .sort();
  const required = [...REQUIRED_QUALIFICATION_CASES].sort();
  if (JSON.stringify(observed) !== JSON.stringify(required)) {
    const error = new Error(
      'The bundled-Node qualification matrix is incomplete or contains an unpinned case.',
    );
    error.code = 'ASTROIX_QUALIFICATION_MATRIX_INCOMPLETE';
    throw error;
  }
  return [...REQUIRED_QUALIFICATION_CASES];
}
