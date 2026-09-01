// The behavior-contract corpus writer (#216 B1, #217 B2): boots the real
// disposable oracles (main + where-strategy), captures the live inspection
// surfaces and — in the same main-oracle boot, after inspection has read
// pristine bytes — the live edit cycles (CSS splices, Content whole-file
// writes, stale-hash conflicts, malformed-request negatives) through the
// shared pipelines (live-capture.ts / edit-capture.ts — the same modules
// the freeze specs use), self-validates every envelope against the
// versioned schemas and the AC hygiene gate, and writes the frozen fixture
// bytes into e2e/behavior-contracts/{inspection,edit}/.
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

// One main boot carries both captures: inspection reads the pristine
// canonical bytes first, then the edit legs write — the oracle is
// disposable and regenerated on every boot, so the order is the only
// sequencing the determinism needs.
const main = await withOracleServer('main', MAIN_PORT, async (handle) => ({
  inspection: await captureInspectionCorpus({
    base: handle.base,
    root: handle.dir,
    strategy: 'attribute',
  }),
  edit: await captureEditCorpus({ base: handle.base, root: handle.dir }),
}));
const where = await withOracleServer('where', WHERE_PORT, (handle) =>
  captureInspectionCorpus({ base: handle.base, root: handle.dir, strategy: 'where' }),
);
const inspectionRuns = { attribute: main.inspection, where };
const editRun = main.edit;

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
