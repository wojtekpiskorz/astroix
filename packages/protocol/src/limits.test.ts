import { describe, expect, it } from 'vitest';
import { BYTE_LIMIT_NAMES, byteLength, envelopeBytes, LIMITS, withinByteLimit } from './limits';

/**
 * The limits traceability test (#220 AC: limits encode the ADR numbers —
 * the expectations below are the ADR paragraphs restated, so a limit can
 * never drift from its ruling without this file going red): 64 KiB
 * lifecycle JSON, 8 MiB edit request / editable text resource, 32 MiB
 * inspection response, 256 KiB SSE event, 16 KiB error details
 * (ADR-0006 §7); 30 s startup, 5 s graceful stop, 5 s drain, 2 s forced
 * reap (ADR-0006 §4, §8); 128-bit project keys and 256-bit capabilities
 * (ADR-0006 §1, §3); one authoritative SSE client, three diagnostics
 * (ADR-0006 §7).
 */
describe('LIMITS — one statement of every ruled number', () => {
  it('encodes the ADR-0006 §7 byte caps exactly', () => {
    expect(LIMITS.lifecycleJsonBytes).toBe(64 * 1024);
    expect(LIMITS.editRequestBytes).toBe(8 * 1024 * 1024);
    expect(LIMITS.editableResourceBytes).toBe(8 * 1024 * 1024);
    expect(LIMITS.inspectionResponseBytes).toBe(32 * 1024 * 1024);
    expect(LIMITS.sseEventBytes).toBe(256 * 1024);
    expect(LIMITS.errorDetailsBytes).toBe(16 * 1024);
  });

  it('encodes the ADR-0006 §4/§8 deadlines exactly', () => {
    expect(LIMITS.startupDeadlineMs).toBe(30_000);
    expect(LIMITS.gracefulStopDeadlineMs).toBe(5_000);
    expect(LIMITS.drainDeadlineMs).toBe(5_000);
    expect(LIMITS.forcedReapDeadlineMs).toBe(2_000);
  });

  it('encodes the ADR-0006 §1/§3/§7 identity sizes and role counts exactly', () => {
    expect(LIMITS.projectKeyBits).toBe(128);
    expect(LIMITS.requestCapabilityBits).toBe(256);
    expect(LIMITS.authoritativeSseClients).toBe(1);
    expect(LIMITS.diagnosticSseClients).toBe(3);
  });

  it('derives the byte-limit name set from LIMITS — the single statement the details enum reads', () => {
    expect([...BYTE_LIMIT_NAMES].sort()).toEqual([
      'editRequestBytes',
      'editableResourceBytes',
      'errorDetailsBytes',
      'inspectionResponseBytes',
      'lifecycleJsonBytes',
      'sseEventBytes',
    ]);
    const byteKeys = Object.keys(LIMITS).filter((name) => name.endsWith('Bytes'));
    expect(BYTE_LIMIT_NAMES).toHaveLength(byteKeys.length); // a seventh cap joins both or neither
  });
});

describe('byte accounting', () => {
  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    expect(byteLength('astroix')).toBe(7);
    expect(byteLength('é')).toBe(2);
    expect(byteLength('🚀')).toBe(4); // one emoji, four bytes
    expect(byteLength('平仮名')).toBe(9);
  });

  it('measures envelope size over the serialized JSON bytes', () => {
    expect(envelopeBytes({ a: 1 })).toBe(byteLength('{"a":1}'));
    expect(envelopeBytes('ü')).toBe(4); // "ü" serialized keeps its two bytes
  });

  it('bounds text against the named limit, inclusive at the boundary', () => {
    const sixtyFourKib = 'x'.repeat(LIMITS.lifecycleJsonBytes);
    expect(withinByteLimit(sixtyFourKib, 'lifecycleJsonBytes')).toBe(true);
    expect(withinByteLimit(`${sixtyFourKib}x`, 'lifecycleJsonBytes')).toBe(false);
    expect(withinByteLimit('ü'.repeat(LIMITS.errorDetailsBytes), 'errorDetailsBytes')).toBe(false); // 16 KiB of two-byte chars is 32 KiB on the wire
  });
});
