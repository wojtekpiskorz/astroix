import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The managed-project snapshot — the ZERO-INJECTION LAW's measurement,
 * one home for every lane that proves it (the web host's G3 battery
 * and the packaged early smoke's audit alike). Born at the second
 * consumer (#248's packaged lane copying the web lane's walker — two
 * copies meant the next web-lane change would silently alter the
 * packaged proof), extracted to the e2e root where both hosts' lanes
 * import it as a shared helper.
 *
 * What the snapshot records: every file's bytes (SHA-256) and metadata
 * (kind, mode class, symlink target) keyed by project-relative path —
 * everything a hidden control file, bridge, config edit, or manifest
 * mutation would move.
 */

/**
 * The managed project's permitted Astro/Vite side effects — ordinary
 * caches and build output (CONTEXT.md's zero-injection guarantee names
 * them): the linked installation, `.astro/` state, and build dist.
 * Everything else must survive hosting byte- and metadata-identical.
 */
export const MANAGED_EXCLUDED_ENTRIES: ReadonlySet<string> = new Set([
  'node_modules',
  '.astro',
  'dist',
]);

/**
 * One managed-project snapshot: every non-excluded file's bytes
 * (SHA-256) and metadata keyed by project-relative path.
 */
export function snapshotManagedProject(root: string): Map<string, string> {
  const entries = new Map<string, string>();
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (MANAGED_EXCLUDED_ENTRIES.has(entry.name)) continue;
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        entries.set(relative, `symlink:${readlinkSync(full)}`);
        continue;
      }
      if (entry.isDirectory()) {
        entries.set(relative, 'directory');
        walk(full, relative);
        continue;
      }
      const bytes = readFileSync(full);
      entries.set(
        relative,
        `file:${bytes.length}:${createHash('sha256').update(bytes).digest('hex')}`,
      );
    }
  };
  walk(root, '');
  return entries;
}
