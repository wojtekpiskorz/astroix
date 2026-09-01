// The behavior-contract corpus writer (#216 B1, #217 B2): boots the real
// disposable oracles and captures the live surfaces through the shared
// pipelines (live-capture.ts / edit-capture.ts — the same modules the
// freeze specs use): the inspection corpus from the main + where-strategy
// boots, then the edit corpus (CSS splices, Content whole-file writes,
// stale-hash conflicts, malformed-request negatives) through its own
// self-booting two-boot pipeline. Every envelope is self-validated against
// the versioned schemas and the AC hygiene gate before the frozen fixture
// bytes land in e2e/behavior-contracts/{inspection,edit}/.
//
// Deterministic by construction: the scrub is a pure relativization, the
// serialization is fixed, the write legs settle on responses and disk
// reads — two consecutive runs must produce byte-identical fixtures (the
// lanes' reproducibility gate).
//
// Run from the repo root: node e2e/contract-oracle/capture.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { editFixtureSchemas } from '../behavior-contracts/schema/edit-contract.ts';
import { fixtureSchemas } from '../behavior-contracts/schema/inspection-contract.ts';
import { captureEditCorpus, EDIT_CORPUS_MANIFEST } from './edit-capture.ts';
import {
  assertNoForbiddenArtifacts,
  CORPUS_MANIFEST,
  captureInspectionCorpus,
  serializeFixture,
} from './live-capture.ts';
import { MAIN_PORT, WHERE_PORT, withOracleServer } from './oracle-server.ts';

const INSPECTION_DIR = join('e2e', 'behavior-contracts', 'inspection');
const EDIT_DIR = join('e2e', 'behavior-contracts', 'edit');

// Inspection first: the main boot reads the pristine canonical bytes.
const main = await withOracleServer('main', MAIN_PORT, (handle) =>
  captureInspectionCorpus({ base: handle.base, root: handle.dir, strategy: 'attribute' }),
);
const where = await withOracleServer('where', WHERE_PORT, (handle) =>
  captureInspectionCorpus({ base: handle.base, root: handle.dir, strategy: 'where' }),
);

// The edit corpus owns its boots (edit-capture.ts: writes on one oracle
// boot, the scoped after-join read on a fresh second load) and MUST run
// outside any other boot: its boots regenerate the shared .oracle-fixture
// dir and spawn on MAIN_PORT — nested under the inspection boot, every
// request would be served by the warm outer server and the spawned
// servers would die unused, regenerating through exactly the watcher-
// fragile long-lived-server path the two-boot design removed.
const editRun = await captureEditCorpus(MAIN_PORT);
const inspectionRuns = { attribute: main, where };

// The inspection manifest is the single enumeration: exactly these files
// are written, each from the oracle run its strategy names — no second
// list to drift.
mkdirSync(INSPECTION_DIR, { recursive: true });
for (const { file, strategy, leg } of CORPUS_MANIFEST) {
  const envelope = inspectionRuns[strategy][leg];
  const schema = fixtureSchemas[file];
  if (schema === undefined) throw new Error(`no schema registered for fixture ${file}`);
  const parsed = schema.safeParse(envelope);
  if (!parsed.success) {
    throw new Error(`captured ${file} fails its schema: ${JSON.stringify(parsed.error.issues)}`);
  }
  const text = serializeFixture(envelope);
  assertNoForbiddenArtifacts(text, `captured ${file}`);
  writeFileSync(join(INSPECTION_DIR, file), text);
  console.log(`[astroix] inspection contract frozen: ${file}`);
}

// The edit manifest carries the same discipline for the write corpus.
mkdirSync(EDIT_DIR, { recursive: true });
for (const { file, leg } of EDIT_CORPUS_MANIFEST) {
  const envelope = editRun[leg];
  const schema = editFixtureSchemas[file];
  if (schema === undefined) throw new Error(`no schema registered for fixture ${file}`);
  const parsed = schema.safeParse(envelope);
  if (!parsed.success) {
    throw new Error(`captured ${file} fails its schema: ${JSON.stringify(parsed.error.issues)}`);
  }
  const text = serializeFixture(envelope);
  assertNoForbiddenArtifacts(text, `captured ${file}`);
  writeFileSync(join(EDIT_DIR, file), text);
  console.log(`[astroix] edit contract frozen: ${file}`);
}
