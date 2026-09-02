import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The shared #231 process-lane scaffolding (the #222/#230 harness idiom):
 * scratch directories with one registry and one cleanup, plus loopback
 * ephemeral ports. Both real-child test files spawn real children — these
 * helpers own the filesystem and socket bookkeeping so the lanes assert
 * behavior, never boilerplate.
 */

const scratchDirs: string[] = [];

/** One scratch directory, registered for {@link cleanupScratch}. */
export async function makeScratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

/** Removes every registered scratch directory — call from each lane's `afterEach`. */
export async function cleanupScratch(): Promise<void> {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

/** An ephemeral loopback port (bind 0, read, close — the reservation dies with the probe socket). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : undefined;
      server.close(() => {
        if (port === undefined) reject(new Error('no ephemeral port'));
        else resolve(port);
      });
    });
  });
}
