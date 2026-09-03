import type { SessionRef, SseEventEnvelope } from '@wojciechpiskorz/astroix-protocol';
import { describe, expect, it, vi } from 'vitest';
import { createSessionGate } from '../state/session-gate.ts';
import { gatedSessionFetch, StaleSessionResultError } from './gated-session-fetch.ts';
import { gatedSseHandlers } from './session-events.ts';

/**
 * The two stale-rejection belts' focused lane (#241's AC: stale
 * responses and events cannot repopulate current-generation state):
 * the gated fetch (a moved-past resolution never lands) and the gated
 * SSE handlers (a frame carrying a foreign or absent pair never
 * dispatches).
 */

const FIRST: SessionRef = { runtimeEpoch: 'epoch-fixture', generation: 1 };
const NEXT: SessionRef = { runtimeEpoch: 'epoch-fixture', generation: 2 };

describe('gatedSessionFetch', () => {
  it('passes a resolution that arrives while its session is current', async () => {
    const gate = createSessionGate(FIRST);
    const fetch = gatedSessionFetch(gate, async () => 'inspection');
    await expect(fetch()).resolves.toBe('inspection');
  });

  it('rejects without fetching when the gate is already closed', async () => {
    const gate = createSessionGate(FIRST);
    gate.move(null);
    const underlying = vi.fn(async () => 'inspection');
    const fetch = gatedSessionFetch(gate, underlying);
    await expect(fetch()).rejects.toBeInstanceOf(StaleSessionResultError);
    expect(underlying).not.toHaveBeenCalled();
  });

  it('rejects a delayed resolution that lands after the reset closed the gate', async () => {
    const gate = createSessionGate(FIRST);
    const holder: { resolve?: (value: string) => void } = {};
    const fetch = gatedSessionFetch(gate, () => {
      return new Promise<string>((resolve) => {
        holder.resolve = resolve;
      });
    });
    const pending = fetch();
    // The transition commits while the old fetch is in flight.
    gate.move(null);
    holder.resolve?.('stale-inspection');
    await expect(pending).rejects.toBeInstanceOf(StaleSessionResultError);
  });
});

describe('gatedSseHandlers', () => {
  const envelopeOf = (session: SessionRef | undefined): SseEventEnvelope =>
    ({
      protocolVersion: 1,
      ...(session === undefined ? {} : { session }),
      event: { type: 'diagnostic', level: 'info', message: 'frame' },
    }) as SseEventEnvelope;

  it('dispatches a current-pair frame', () => {
    const gate = createSessionGate(FIRST);
    const onEvent = vi.fn();
    gatedSseHandlers(gate, { onEvent }).onEvent(envelopeOf({ ...FIRST }));
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('drops a foreign-pair frame — the stale event belt', () => {
    const gate = createSessionGate(FIRST);
    const onEvent = vi.fn();
    gatedSseHandlers(gate, { onEvent }).onEvent(envelopeOf(NEXT));
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('drops a frame with no pair — fail closed, never assumed fresh', () => {
    const gate = createSessionGate(FIRST);
    const onEvent = vi.fn();
    gatedSseHandlers(gate, { onEvent }).onEvent(envelopeOf(undefined));
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('drops every frame after the reset closed the gate', () => {
    const gate = createSessionGate(FIRST);
    gate.move(null);
    const onEvent = vi.fn();
    gatedSseHandlers(gate, { onEvent }).onEvent(envelopeOf(FIRST));
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('passes the stream-level callbacks through un-gated', () => {
    const gate = createSessionGate(FIRST);
    const onOpen = vi.fn();
    const onStale = vi.fn();
    const onTransportError = vi.fn();
    const handlers = gatedSseHandlers(gate, {
      onEvent: () => {},
      onOpen,
      onStale,
      onTransportError,
    });
    handlers.onOpen?.();
    handlers.onStale?.();
    handlers.onTransportError?.();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onTransportError).toHaveBeenCalledTimes(1);
  });

  it('passes onOpen through even on a closed gate — it describes the stream, not a pair', () => {
    const gate = createSessionGate(FIRST);
    gate.move(null);
    const onOpen = vi.fn();
    gatedSseHandlers(gate, { onEvent: () => {}, onOpen }).onOpen?.();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
