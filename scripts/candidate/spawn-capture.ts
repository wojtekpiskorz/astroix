import { spawn } from 'node:child_process';

/**
 * The candidate legs' shared bounded spawn (#259, L2): one child
 * process, full stdout/stderr capture, a hard timeout kill — the
 * plumbing both fixture legs drive their children through (the
 * node-sass screener, the native fixture's from-source build and its
 * bundled-node check). Its own module, so neither leg imports the
 * other's plumbing (review round 6: the sideways import is gone).
 */

/** One bounded spawn with full stdout/stderr capture. */
export function spawnCapture(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      env: options?.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      stderr.push(Buffer.from(error.message));
      resolve({
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        signal: signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}
