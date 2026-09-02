import { describe, expect, it } from 'vitest';
import { type PrivateIpcChannel, processChannel } from '../../private-boot/private-ipc.ts';

/**
 * The private-IPC adapter (#222): `processChannel` lifts the forked
 * child's real IPC channel to the seam — and refuses a process without
 * one, because a process that was never spawned by a main was never the
 * exact child boot authority is conferred on. The real forked-channel
 * path runs in the process lanes; these unit tests pin both branches of
 * the adapter itself.
 */

describe('processChannel', () => {
  it('refuses a process without an IPC channel', () => {
    // A process that was never spawned by a main — the web-mode shape.
    const channelless = {
      on: (_event: string, _listener: (message: unknown) => void) => channelless,
      connected: false,
    } as unknown as NodeJS.Process;
    expect(() => processChannel(channelless)).toThrow(TypeError);
  });

  it('lifts a process-shaped native channel onto the seam unchanged', () => {
    const nativeProcess = {
      send: (_message: unknown) => true,
      on: (_event: string, listener: (message: unknown) => void) => listener,
      connected: true,
    } as unknown as NodeJS.Process;
    const channel: PrivateIpcChannel = processChannel(nativeProcess);
    expect(channel).toBe(nativeProcess);
    expect(channel.connected).toBe(true);
    expect(channel.send({ probe: 1 })).toBe(true);
    expect(
      channel.on('message', () => {
        /* the seam only forwards the listener */
      }),
    ).toBeInstanceOf(Function);
  });
});
