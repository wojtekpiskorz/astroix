import { projectKeySchema, sanitizedTextSchema } from '@wojciechpiskorz/astroix-protocol';
import { z } from 'zod';

/**
 * The registry document (ADR-0006 §2 "Persistence": "a strictly versioned
 * JSON document"; #221): one schema version, an array of records, and
 * nothing else — no lease state, no PID or ownership record, no
 * browser-supplied root. Version 1 is migration-free by ticket: only
 * explicitly recognized schema migrations may ever run, and none exist
 * yet, so every document that is not exactly version 1 is classified
 * below and quarantined by the store, never guessed into shape.
 */

/** The one schema version this layer reads and writes (migration-free v1). */
export const REGISTRY_SCHEMA_VERSION = 1;

/**
 * One persisted record. `canonicalRoot` is the `fs.realpath` result — the
 * filesystem's own case and identity semantics, never an arbitrary
 * lowercasing (ADR-0006 §1) — so it is always absolute, and exact-string
 * equality after realpath IS root identity. The display name is stored
 * through the protocol's disclosure guard: it is the one free-text field
 * the browser ever sees (`projectSummarySchema`), so a document whose
 * stored name would fail the guard is corruption, not a cosmetic defect.
 */
export const registryRecordSchema = z.strictObject({
  projectKey: projectKeySchema,
  canonicalRoot: z.string().regex(/^\//, 'canonical root must be an absolute resolved path'),
  displayName: sanitizedTextSchema,
});

export type RegistryRecord = z.infer<typeof registryRecordSchema>;

/**
 * The whole document. Strict: an unknown field — a `pid`, a `lease`, a
 * `browserRoot` — fails the schema and therefore classifies as corruption
 * (#221 migration policy: no browser-supplied root path or PID ownership
 * record becomes authority, not even persisted).
 */
export const registryDocumentSchema = z
  .strictObject({
    schemaVersion: z.literal(REGISTRY_SCHEMA_VERSION),
    records: z.array(registryRecordSchema),
  })
  .superRefine((doc, ctx) => {
    // Duplicate keys or duplicate canonical roots in a stored document are
    // structural corruption (identity is unique by construction); the
    // comparison is exact-string because both fields are already canonical.
    const keys = new Set<string>();
    const roots = new Set<string>();
    for (const [index, record] of doc.records.entries()) {
      if (keys.has(record.projectKey)) {
        ctx.addIssue({
          code: 'custom',
          path: ['records', index, 'projectKey'],
          message: `duplicate project key in registry document`,
        });
      }
      if (roots.has(record.canonicalRoot)) {
        ctx.addIssue({
          code: 'custom',
          path: ['records', index, 'canonicalRoot'],
          message: 'duplicate canonical root in registry document',
        });
      }
      keys.add(record.projectKey);
      roots.add(record.canonicalRoot);
    }
  });

export type RegistryDocument = z.infer<typeof registryDocumentSchema>;

/** Why a document was quarantined (ADR-0006 §2: corrupt and unsupported future schemas alike). */
export type QuarantineReason = 'corrupt' | 'unsupported-future';

/**
 * What a registry file's bytes are: a valid v1 document, an unusable
 * corrupt one, or a structurally valid document written by a schema this
 * version does not recognize. The distinction is launcher-facing copy
 * only — both unusable statuses quarantine identically and require the
 * explicit restore command.
 */
export type DocumentClassification =
  | { status: 'ok'; document: RegistryDocument }
  | { status: 'corrupt' }
  | { status: 'unsupported-future'; foundVersion: number };

/**
 * The first read of a registry file's bytes. Unparseable JSON, a missing
 * or non-numeric version, a version below 1, or any schema failure is
 * `corrupt`; a numeric `schemaVersion` above the recognized one is
 * `unsupported-future` (a newer Astroix wrote it — only an explicit
 * restore from the last-known-good snapshot, never a downgrade guess,
 * may recover). Never throws: every unusable byte sequence classifies.
 */
export function classifyRegistryDocument(text: string): DocumentClassification {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: 'corrupt' };
  }
  if (!isPlainObject(parsed)) {
    return { status: 'corrupt' };
  }
  const version = parsed.schemaVersion;
  if (typeof version === 'number' && Number.isInteger(version)) {
    if (version > REGISTRY_SCHEMA_VERSION) {
      return { status: 'unsupported-future', foundVersion: version };
    }
    if (version < REGISTRY_SCHEMA_VERSION) {
      // A version below the only one that ever existed was never written
      // by any Astroix — it is corruption, not a migration case.
      return { status: 'corrupt' };
    }
  } else {
    return { status: 'corrupt' };
  }
  const result = registryDocumentSchema.safeParse(parsed);
  return result.success ? { status: 'ok', document: result.data } : { status: 'corrupt' };
}

/** The empty v1 document of a first boot (or a fully-removed registry). */
export function emptyRegistryDocument(): RegistryDocument {
  return { schemaVersion: REGISTRY_SCHEMA_VERSION, records: [] };
}

/**
 * Deterministic serialization for every write: two-space indent, stable
 * field order (`schemaVersion`, `records`; per record `projectKey`,
 * `canonicalRoot`, `displayName`), one trailing newline — byte-stable for
 * identical documents, so the last-known-good mirror and the restored
 * file are byte-comparable in tests and diagnostics.
 */
export function serializeRegistryDocument(document: RegistryDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
