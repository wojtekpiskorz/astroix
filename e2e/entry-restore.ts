import { writeFileSync } from 'node:fs';

/**
 * The fixture-entry restore shared by the content specs: since the auto-write
 * loop (#74) every pane edit persists, a spec that edits an entry restores it
 * before the next test. No sync-waiting: the next test's raw baseline reads
 * disk directly, its outcome assertions poll disk bytes, and the write loop
 * itself is race-proof (the serializer leaves nodes already holding the
 * draft's value untouched; the hash guard refuses stale writes) — a lagging
 * host sync cannot corrupt either side of the loop.
 */
export function restoreEntry(file: string, original: string): void {
  writeFileSync(file, original);
}
