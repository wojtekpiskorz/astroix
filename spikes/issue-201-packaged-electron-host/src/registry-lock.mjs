import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'EPERM') return true;
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

export async function acquireProofRegistryLock({ directory, allowStaleRecovery = false }) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'proof-writer.lock');
  const token = randomUUID();
  const contents = { pid: process.pid, token, createdAt: new Date().toISOString() };
  let staleRecovered = false;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(contents)}\n`);
      } finally {
        await handle.close();
      }
      let released = false;
      return {
        path,
        staleRecovered,
        async release() {
          if (released) return false;
          released = true;
          try {
            const current = JSON.parse(await readFile(path, 'utf8'));
            if (current.token !== token) return false;
            await rm(path);
            return true;
          } catch (error) {
            if (error?.code === 'ENOENT') return false;
            throw error;
          }
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const current = JSON.parse(await readFile(path, 'utf8'));
      if (!allowStaleRecovery || processExists(current.pid)) {
        const locked = new Error(`proof registry already has a live writer at pid ${current.pid}`);
        locked.code = 'ASTROIX_REGISTRY_LOCKED';
        locked.owner = current;
        throw locked;
      }
      await rm(path);
      staleRecovered = true;
    }
  }
  throw new Error('proof registry stale-lock recovery did not converge');
}
