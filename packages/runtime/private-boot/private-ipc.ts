/**
 * The private main↔child IPC channel seam (ADR-0006 §2: "one-use boot
 * capability over private IPC"). The concrete transport is the
 * `node:child_process` IPC channel between the Electron main (or the
 * parent that stands in for it) and the exact control-plane child it
 * spawned: a kernel-exclusive file descriptor pair that no web entry
 * point can possess — there is no HTTP, WebSocket, or URL surface to it,
 * and no capability material ever travels through environment variables
 * (ADR-0007 forbids app-private authorization material in child
 * environments).
 */

/**
 * The channel subset the boot authority consumes. `process` in a forked
 * child satisfies this structurally; `processChannel()` adapts it.
 */
export interface PrivateIpcChannel {
  /** False once the other end closed or was disconnected. */
  readonly connected: boolean;
  /** Sends one JSON message; false/null when the channel is gone. */
  send(message: unknown): boolean | null;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'disconnect', listener: () => void): unknown;
}

/**
 * Adapts this process's IPC channel (a forked child) to the seam. Throws
 * when the process has no IPC channel — a process without one was never
 * the exact child a main conferred boot authority on.
 */
export function processChannel(nativeProcess: NodeJS.Process): PrivateIpcChannel {
  if (typeof nativeProcess.send !== 'function') {
    throw new TypeError('this process has no private IPC channel (not a spawned child)');
  }
  return nativeProcess as unknown as PrivateIpcChannel;
}
