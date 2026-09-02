import { LIMITS, type SseEvent, sseEventEnvelopeSchema } from '@wojciechpiskorz/astroix-protocol';
import { describe, expect, it } from 'vitest';
import {
  type SsePublication,
  sseFrame,
  ssePublication,
  sseStreamHeaders,
} from '../../sse/sse-frames.ts';
import { createSseHub, type SseHub, type SseStreamRecord } from '../../sse/sse-hub.ts';
import { KEY_A, NEXT_SESSION, OTHER_EPOCH, SESSION } from './fixtures.ts';

/**
 * The F3 SSE hub and frame focused legs (#235): the stream registry's
 * caps, delivery matrix, and revocation scopes over recorder sinks
 * (deterministic — no socket here; the wire is the real-socket lane),
 * and the frame writer's cap enforcement. The zero-old-generation
 * invariant is pinned in all three of its layers: exact-pair delivery,
 * the stale-publication watermark, and the switch's stream revocation.
 */

const PROJECT_HOST = { host: 'project', projectKey: KEY_A } as const;
const LAUNCHER_HOST = { host: 'launcher' } as const;

/** One recording stream — the deterministic stand-in for a live connection. */
function recordingStream(input: Partial<SseStreamRecord> = {}): SseStreamRecord & {
  frames: string[];
  closed: boolean;
} {
  const frames: string[] = [];
  const record: SseStreamRecord & { frames: string[]; closed: boolean } = {
    role: 'editor',
    host: PROJECT_HOST,
    session: SESSION,
    clientCapability: `client-${Math.random().toString(36).slice(2)}`,
    sink: (text) => {
      frames.push(text);
    },
    close: () => {
      record.closed = true;
    },
    closed: false,
    frames,
    ...input,
  };
  return record;
}

/** A session-scoped publication for the pair — the common mint. */
function sessionPublication(session = SESSION, event?: SseEvent): SsePublication {
  const minted =
    ssePublication({
      session,
      event: event ?? { type: 'diagnostic', level: 'info', message: 'fixture event' },
    }) ?? undefined;
  if (minted === undefined) throw new Error('fixture publication failed to construct');
  return minted;
}

describe('the frame writer (cap enforcement at the transport)', () => {
  it('serializes one session-scoped frame carrying the exact pair, as a single data line', () => {
    const frame = sseFrame(sessionPublication());
    expect(frame.kind).toBe('frame');
    if (frame.kind !== 'frame') return;
    expect(frame.text.endsWith('\n\n')).toBe(true);
    expect(frame.text.startsWith('data: ')).toBe(true);
    const lines = frame.text.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    const envelope = sseEventEnvelopeSchema.parse(JSON.parse(frame.text.slice('data: '.length)));
    expect(envelope.session).toEqual(SESSION);
    expect(envelope.event.type).toBe('diagnostic');
    expect(frame.bytes).toBeLessThanOrEqual(LIMITS.sseEventBytes);
  });

  it('serializes the idle registry nudge without inventing a session', () => {
    const publication = ssePublication({ event: { type: 'registry-changed' } });
    expect(publication).not.toBeNull();
    const frame = sseFrame(publication as SsePublication);
    expect(frame.kind).toBe('frame');
    if (frame.kind !== 'frame') return;
    const envelope = sseEventEnvelopeSchema.parse(JSON.parse(frame.text.slice('data: '.length)));
    expect(envelope.session).toBeUndefined();
    expect(envelope.event.type).toBe('registry-changed');
  });

  it('refuses an event whose envelope breaches the 256 KiB cap — it never becomes a frame', () => {
    const publication = sessionPublication(SESSION, {
      type: 'diagnostic',
      level: 'info',
      message: 'x'.repeat(LIMITS.sseEventBytes + 4096),
    });
    const frame = sseFrame(publication);
    expect(frame.kind).toBe('oversized');
    if (frame.kind === 'oversized') {
      expect(frame.bytes).toBeGreaterThan(LIMITS.sseEventBytes);
    }
  });

  it('constructs no publication that contradicts the session-presence table', () => {
    expect(ssePublication({ event: { type: 'registry-changed' }, session: SESSION })).toBeNull();
    expect(
      ssePublication({ event: { type: 'diagnostic', level: 'info', message: 'm' } }),
    ).toBeNull();
  });

  it('answers the stream head with the event-stream media type, no-store, the marker — and zero CORS', () => {
    const headers = sseStreamHeaders();
    expect(headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['x-astroix-generated']).toBe('1');
    expect(Object.keys(headers).some((name) => name.includes('access-control'))).toBe(false);
    expect(headers['content-length']).toBeUndefined();
  });
});

describe('the stream caps (one authoritative, three diagnostics)', () => {
  it('admits exactly one authoritative stream and refuses the second', () => {
    const hub = createSseHub();
    expect(hub.admit(recordingStream({ role: 'editor' })).kind).toBe('admitted');
    const second = hub.admit(
      recordingStream({ role: 'editor', clientCapability: 'client-editor-2' }),
    );
    expect(second).toMatchObject({ kind: 'refused', reason: 'authoritative-cap' });
    expect(hub.counts().authoritative).toBe(1);
  });

  it('admits up to three diagnostic streams and refuses the fourth', () => {
    const hub = createSseHub();
    for (let index = 0; index < LIMITS.diagnosticSseClients; index += 1) {
      const admitted = hub.admit(
        recordingStream({ role: 'diagnostic', clientCapability: `diag-${index}` }),
      );
      expect(admitted.kind, `diagnostic ${index}`).toBe('admitted');
    }
    const fourth = hub.admit(recordingStream({ role: 'diagnostic', clientCapability: 'diag-3' }));
    expect(fourth).toMatchObject({ kind: 'refused', reason: 'diagnostic-cap' });
    expect(hub.counts().diagnostic).toBe(LIMITS.diagnosticSseClients);
  });

  it('supersedes the stream a client capability still holds — the EventSource reconnect', () => {
    const hub = createSseHub();
    const first = recordingStream({ role: 'editor', clientCapability: 'client-editor' });
    expect(hub.admit(first).kind).toBe('admitted');
    hub.publish(sessionPublication());
    expect(first.frames.length).toBe(1);
    const reconnect = recordingStream({ role: 'editor', clientCapability: 'client-editor' });
    expect(hub.admit(reconnect).kind).toBe('admitted');
    expect(first.closed).toBe(true);
    expect(hub.counts().authoritative).toBe(1);
  });

  it('frees the slot on drop — a closed stream no longer counts', () => {
    const hub = createSseHub();
    const first = hub.admit(recordingStream({ role: 'editor' }));
    expect(first.kind).toBe('admitted');
    if (first.kind !== 'admitted') return;
    hub.drop(first.id);
    const second = hub.admit(
      recordingStream({ role: 'editor', clientCapability: 'client-editor-2' }),
    );
    expect(second.kind).toBe('admitted');
    expect(hub.counts().authoritative).toBe(1);
  });
});

describe('the delivery matrix (which stream receives which event)', () => {
  it('delivers a session-scoped event to the editor and the diagnostics of the exact pair', () => {
    const hub = createSseHub();
    const editor = recordingStream({ role: 'editor' });
    const diagnostic = recordingStream({ role: 'diagnostic', clientCapability: 'diag-0' });
    hub.admit(editor);
    hub.admit(diagnostic);
    const outcome = hub.publish(sessionPublication());
    expect(outcome).toMatchObject({ kind: 'delivered', streams: 2 });
    expect(editor.frames).toHaveLength(1);
    expect(diagnostic.frames).toHaveLength(1);
  });

  it('delivers session-state lifecycle progress to the launcher stream too', () => {
    const hub = createSseHub();
    const launcher = recordingStream({ role: 'launcher', host: LAUNCHER_HOST, session: null });
    hub.admit(launcher);
    const outcome = hub.publish(
      sessionPublication(SESSION, {
        type: 'session-state',
        snapshot: {
          active: { ref: SESSION, projectKey: KEY_A, state: 'ready' },
        },
      }),
    );
    expect(outcome).toMatchObject({ kind: 'delivered', streams: 1 });
    expect(launcher.frames).toHaveLength(1);
  });

  it('delivers invalidations and diagnostics to session streams only — never the launcher', () => {
    const hub = createSseHub();
    const launcher = recordingStream({ role: 'launcher', host: LAUNCHER_HOST, session: null });
    hub.admit(launcher);
    const invalidation = hub.publish(
      sessionPublication(SESSION, { type: 'invalidation', families: ['styles'], revision: 4 }),
    );
    expect(invalidation).toMatchObject({ kind: 'delivered', streams: 0 });
    const diagnostic = hub.publish(sessionPublication());
    expect(diagnostic).toMatchObject({ kind: 'delivered', streams: 0 });
    expect(launcher.frames).toHaveLength(0);
  });

  it('delivers the idle registry nudge to the launcher stream only', () => {
    const hub = createSseHub();
    const launcher = recordingStream({ role: 'launcher', host: LAUNCHER_HOST, session: null });
    const editor = recordingStream({ role: 'editor' });
    hub.admit(launcher);
    hub.admit(editor);
    const publication = ssePublication({ event: { type: 'registry-changed' } });
    expect(publication).not.toBeNull();
    const outcome = hub.publish(publication as SsePublication);
    expect(outcome).toMatchObject({ kind: 'delivered', streams: 1 });
    expect(launcher.frames).toHaveLength(1);
    expect(editor.frames).toHaveLength(0);
  });

  it('delivers a session-scoped event only at the EXACT pair — a generation-2 event never reaches a generation-1 stream', () => {
    const hub = createSseHub();
    const old = recordingStream({ session: SESSION });
    const next = recordingStream({
      role: 'diagnostic',
      session: NEXT_SESSION,
      clientCapability: 'client-next',
    });
    hub.admit(old);
    hub.admit(next);
    hub.publish(sessionPublication(NEXT_SESSION));
    expect(old.frames).toHaveLength(0);
    expect(next.frames).toHaveLength(1);
  });
});

describe('the zero-old-generation watermark', () => {
  it('refuses a publication minted under a generation the hub has moved past', () => {
    const hub = createSseHub();
    const stream = recordingStream({ session: NEXT_SESSION });
    hub.admit(stream);
    hub.publish(sessionPublication(NEXT_SESSION));
    const stale = hub.publish(sessionPublication(SESSION));
    expect(stale).toMatchObject({ kind: 'refused', reason: 'stale-publication' });
    expect(stream.frames).toHaveLength(1);
  });

  it('refuses a foreign-epoch publication after the live epoch was established', () => {
    const hub = createSseHub();
    hub.publish(sessionPublication(SESSION));
    const foreign = hub.publish(sessionPublication(OTHER_EPOCH));
    expect(foreign).toMatchObject({ kind: 'refused', reason: 'stale-publication' });
  });

  it('refuses an over-cap publication whole — nothing is delivered, not even partially', () => {
    const hub = createSseHub();
    const stream = recordingStream();
    hub.admit(stream);
    const oversized = hub.publish(
      sessionPublication(SESSION, {
        type: 'diagnostic',
        level: 'info',
        message: 'x'.repeat(LIMITS.sseEventBytes + 4096),
      }),
    );
    expect(oversized).toMatchObject({ kind: 'refused', reason: 'oversized-event' });
    expect(stream.frames).toHaveLength(0);
  });

  it('contains a throwing sink: the dead stream is closed and dropped, the fan-out survives', () => {
    const hub = createSseHub();
    const healthy = recordingStream({ clientCapability: 'healthy' });
    const dead = recordingStream({
      role: 'diagnostic',
      clientCapability: 'dead',
      sink: () => {
        throw new Error('connection already gone');
      },
    });
    hub.admit(healthy);
    hub.admit(dead);
    const outcome = hub.publish(sessionPublication());
    expect(outcome).toMatchObject({ kind: 'delivered', streams: 1 });
    expect(dead.closed).toBe(true);
    expect(healthy.frames).toHaveLength(1);
    expect(hub.counts().authoritative).toBe(1);
  });
});

describe('the revocation scopes (route, capability, binding, session)', () => {
  it('ends every stream admitted under a host — route retirement / capability revocation', () => {
    const hub: SseHub = createSseHub();
    const editor = recordingStream({ role: 'editor' });
    const diagnostic = recordingStream({ role: 'diagnostic', clientCapability: 'diag-0' });
    const launcher = recordingStream({ role: 'launcher', host: LAUNCHER_HOST, session: null });
    hub.admit(editor);
    hub.admit(diagnostic);
    hub.admit(launcher);
    expect(hub.endForHost(PROJECT_HOST)).toBe(2);
    expect(editor.closed).toBe(true);
    expect(diagnostic.closed).toBe(true);
    expect(launcher.closed).toBe(false);
    expect(hub.endForHost(LAUNCHER_HOST)).toBe(1);
    expect(launcher.closed).toBe(true);
  });

  it('ends every stream bound at the exact session — the switch/stop revocation', () => {
    const hub = createSseHub();
    const old = recordingStream({ session: SESSION });
    const next = recordingStream({
      role: 'diagnostic',
      session: NEXT_SESSION,
      clientCapability: 'client-next',
    });
    hub.admit(old);
    hub.admit(next);
    expect(hub.endForSession(SESSION)).toBe(1);
    expect(old.closed).toBe(true);
    expect(next.closed).toBe(false);
  });

  it('ends the stream admitted under one client capability — binding revocation', () => {
    const hub = createSseHub();
    const editor = recordingStream({ clientCapability: 'client-editor' });
    hub.admit(editor);
    expect(hub.endForBinding('client-editor')).toBe(1);
    expect(editor.closed).toBe(true);
    expect(hub.endForBinding('client-editor')).toBe(0);
  });

  it('delivers nothing to a stream after its session was revoked — the open-stream switch law', () => {
    const hub = createSseHub();
    const old = recordingStream({ session: SESSION });
    hub.admit(old);
    hub.publish(sessionPublication(SESSION));
    expect(old.frames).toHaveLength(1);
    hub.endForSession(SESSION);
    hub.publish(sessionPublication(SESSION));
    expect(old.frames).toHaveLength(1);
  });
});
