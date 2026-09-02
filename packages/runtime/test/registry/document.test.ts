import { describe, expect, it } from 'vitest';
import {
  classifyRegistryDocument,
  emptyRegistryDocument,
  REGISTRY_SCHEMA_VERSION,
  registryDocumentSchema,
  serializeRegistryDocument,
} from '../../registry/document';

/**
 * The versioned registry document (#221): strict v1 shape, the
 * corrupt/unsupported-future classification that drives quarantine, and
 * deterministic serialization. The ticket's migration policy is
 * structural here — a PID, lease, or browser-path field is an unknown
 * field and therefore corruption.
 */

const VALID_KEY_1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
const VALID_KEY_2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbb';

function validDocumentText(): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      records: [
        {
          projectKey: VALID_KEY_1,
          canonicalRoot: '/Users/owner/sites/site-a',
          displayName: 'site-a',
        },
      ],
    },
    null,
    2,
  )}\n`;
}

describe('registryDocumentSchema', () => {
  it('parses a strict v1 document', () => {
    const result = registryDocumentSchema.safeParse(JSON.parse(validDocumentText()));
    expect(result.success).toBe(true);
  });

  it('rejects every lease-shaped or browser-shaped field the ticket forbids', () => {
    const base = JSON.parse(validDocumentText());
    for (const extra of [
      { pid: 4242 },
      { lease: 'registry-writer' },
      { browserRoot: '/claimed' },
      { owner: 'me' },
    ]) {
      const attempt = { ...base, records: [{ ...base.records[0], ...extra }] };
      expect(registryDocumentSchema.safeParse(attempt).success).toBe(false);
    }
  });

  it('rejects duplicate project keys and duplicate canonical roots as corruption', () => {
    const duplicateKey = {
      schemaVersion: 1,
      records: [
        { projectKey: VALID_KEY_1, canonicalRoot: '/a', displayName: 'a' },
        { projectKey: VALID_KEY_1, canonicalRoot: '/b', displayName: 'b' },
      ],
    };
    expect(registryDocumentSchema.safeParse(duplicateKey).success).toBe(false);

    const duplicateRoot = {
      schemaVersion: 1,
      records: [
        { projectKey: VALID_KEY_1, canonicalRoot: '/a', displayName: 'a' },
        { projectKey: VALID_KEY_2, canonicalRoot: '/a', displayName: 'b' },
      ],
    };
    expect(registryDocumentSchema.safeParse(duplicateRoot).success).toBe(false);
  });

  it('keeps case-different roots distinct — exact post-realpath strings are identity', () => {
    // A case-sensitive filesystem genuinely has both roots; arbitrary
    // lowercasing at this layer would collide them (AC: no lowercasing).
    const casePair = {
      schemaVersion: 1,
      records: [
        { projectKey: VALID_KEY_1, canonicalRoot: '/srv/Site', displayName: 'a' },
        { projectKey: VALID_KEY_2, canonicalRoot: '/srv/site', displayName: 'b' },
      ],
    };
    expect(registryDocumentSchema.safeParse(casePair).success).toBe(true);
  });

  it('rejects a relative root, a bad key, and a disclosure-failing display name', () => {
    for (const bad of [
      { projectKey: VALID_KEY_1, canonicalRoot: 'relative/path', displayName: 'a' },
      { projectKey: 'UPPERCASE!', canonicalRoot: '/a', displayName: 'a' },
      { projectKey: VALID_KEY_1, canonicalRoot: '/a', displayName: 'see /Users/owner/leak' },
      { projectKey: VALID_KEY_1, canonicalRoot: '/a', displayName: '' },
    ]) {
      expect(registryDocumentSchema.safeParse({ schemaVersion: 1, records: [bad] }).success).toBe(
        false,
      );
    }
  });
});

describe('classifyRegistryDocument', () => {
  it('classifies a valid document', () => {
    const result = classifyRegistryDocument(validDocumentText());
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.document.records[0]?.displayName).toBe('site-a');
    }
  });

  it('classifies unparseable bytes, non-objects, and shape failures as corrupt', () => {
    for (const text of ['', '{not json', '[]', '42', '{}', validDocumentText().slice(0, 40)]) {
      expect(classifyRegistryDocument(text)).toEqual({ status: 'corrupt' });
    }
  });

  it('classifies a numeric version below 1 or a non-numeric version as corrupt', () => {
    for (const version of [0, -1, 1.5, '1', null]) {
      expect(
        classifyRegistryDocument(JSON.stringify({ schemaVersion: version, records: [] })),
      ).toEqual({ status: 'corrupt' });
    }
  });

  it('classifies a future schema version as unsupported-future, reporting it', () => {
    expect(
      classifyRegistryDocument(JSON.stringify({ schemaVersion: REGISTRY_SCHEMA_VERSION + 1 })),
    ).toEqual({ status: 'unsupported-future', foundVersion: REGISTRY_SCHEMA_VERSION + 1 });
    // A future version with otherwise-valid v1 records is still future —
    // the version alone decides; nothing inside is read.
    expect(
      classifyRegistryDocument(
        JSON.stringify({ schemaVersion: 99, records: [{ nonsense: true }] }),
      ),
    ).toEqual({ status: 'unsupported-future', foundVersion: 99 });
  });
});

describe('serializeRegistryDocument', () => {
  it('is byte-deterministic with a trailing newline and round-trips', () => {
    const document = {
      ...emptyRegistryDocument(),
      records: [{ projectKey: VALID_KEY_1, canonicalRoot: '/srv/site', displayName: 'site' }],
    };
    const first = serializeRegistryDocument(document);
    expect(serializeRegistryDocument(structuredClone(document))).toBe(first);
    expect(first.endsWith('}\n')).toBe(true);
    const roundTrip = classifyRegistryDocument(first);
    expect(roundTrip.status).toBe('ok');
    if (roundTrip.status === 'ok') {
      expect(serializeRegistryDocument(roundTrip.document)).toBe(first);
    }
  });

  it('serializes the empty document with exactly schemaVersion and records', () => {
    expect(JSON.parse(serializeRegistryDocument(emptyRegistryDocument()))).toEqual({
      schemaVersion: 1,
      records: [],
    });
  });
});
