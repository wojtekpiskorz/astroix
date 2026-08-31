import { appendFileSync } from 'node:fs';

export function trace(tracePath, actor, event, detail = {}) {
  appendFileSync(
    tracePath,
    `${JSON.stringify({ at: new Date().toISOString(), ...detail, pid: process.pid, ppid: process.ppid, actor, event })}\n`,
  );
}
