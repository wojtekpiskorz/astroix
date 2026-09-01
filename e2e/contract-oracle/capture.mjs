// The inspection-contract corpus writer (#216, lane B1): boots the real
// disposable oracles (main + where-strategy), captures the live inspection
// surfaces through the shared pipeline (live-capture.ts — the same module
// the freeze spec uses), self-validates every envelope against the
// versioned schema and the AC-4 hygiene gate, and writes the frozen fixture
// bytes into e2e/behavior-contracts/inspection/.
//
// Deterministic by construction: the scrub is a pure relativization, the
// serialization is fixed — two consecutive runs must produce byte-identical
// fixtures (the lane's reproducibility gate).
//
// Run from the repo root: node e2e/contract-oracle/capture.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureSchemas } from '../behavior-contracts/schema/inspection-contract.ts';
import {
  assertNoForbiddenArtifacts,
  CORPUS_MANIFEST,
  captureInspectionCorpus,
  serializeFixture,
} from './live-capture.ts';
import { MAIN_PORT, WHERE_PORT, withOracleServer } from './oracle-server.ts';

const FIXTURE_DIR = join('e2e', 'behavior-contracts', 'inspection');

const main = await withOracleServer('main', MAIN_PORT, (handle) =>
  captureInspectionCorpus({ base: handle.base, root: handle.dir, strategy: 'attribute' }),
);
const where = await withOracleServer('where', WHERE_PORT, (handle) =>
  captureInspectionCorpus({ base: handle.base, root: handle.dir, strategy: 'where' }),
);
const runs = { attribute: main, where };

// The manifest is the single enumeration: exactly these files are written,
// each from the oracle run its strategy names — no second list to drift.
mkdirSync(FIXTURE_DIR, { recursive: true });
for (const { file, strategy, leg } of CORPUS_MANIFEST) {
  const envelope = runs[strategy][leg];
  const schema = fixtureSchemas[file];
  if (schema === undefined) throw new Error(`no schema registered for fixture ${file}`);
  const parsed = schema.safeParse(envelope);
  if (!parsed.success) {
    throw new Error(`captured ${file} fails its schema: ${JSON.stringify(parsed.error.issues)}`);
  }
  const text = serializeFixture(envelope);
  assertNoForbiddenArtifacts(text, `captured ${file}`);
  writeFileSync(join(FIXTURE_DIR, file), text);
  console.log(`[astroix] inspection contract frozen: ${file}`);
}
