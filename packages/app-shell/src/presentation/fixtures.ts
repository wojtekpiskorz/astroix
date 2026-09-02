import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import { editFixtureSchemas } from '../../../../e2e/behavior-contracts/schema/edit-contract.ts';
import { fixtureSchemas } from '../../../../e2e/behavior-contracts/schema/inspection-contract.ts';

/**
 * Test-only fixture access for the presentation widget tests (#219, AC-5/6):
 * the frozen B1/B2 behavior-contract corpora are the presentation fixtures
 * — every fixture loads through its versioned schema, so the props the
 * widgets render under test are contract-shaped by construction (a drifted
 * corpus fails here, not silently downstream). Read-only by charter: the
 * corpus bytes are owned by the freeze suites, never written here.
 */

const CONTRACTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'e2e',
  'behavior-contracts',
);

/** Each frozen inspection fixture's parsed shape, keyed by fixture name. */
type InspectionFixtureData = {
  [K in keyof typeof fixtureSchemas]: z.infer<(typeof fixtureSchemas)[K]>;
};

/** Each frozen edit fixture's parsed shape, keyed by fixture name. */
type EditFixtureData = {
  [K in keyof typeof editFixtureSchemas]: z.infer<(typeof editFixtureSchemas)[K]>;
};

/** Loads one frozen inspection fixture, parsed through its contract schema. */
export function inspectionFixture<K extends keyof typeof fixtureSchemas>(
  name: K,
): InspectionFixtureData[K] {
  const raw = JSON.parse(readFileSync(join(CONTRACTS_DIR, 'inspection', name), 'utf8')) as unknown;
  const result = fixtureSchemas[name].safeParse(raw);
  if (!result.success) {
    throw new Error(`frozen fixture ${name} drifted from its contract: ${result.error.message}`);
  }
  return result.data as InspectionFixtureData[K];
}

/** Loads one frozen edit fixture, parsed through its contract schema. */
export function editFixture<K extends keyof typeof editFixtureSchemas>(
  name: K,
): EditFixtureData[K] {
  const raw = JSON.parse(readFileSync(join(CONTRACTS_DIR, 'edit', name), 'utf8')) as unknown;
  const result = editFixtureSchemas[name].safeParse(raw);
  if (!result.success) {
    throw new Error(`frozen fixture ${name} drifted from its contract: ${result.error.message}`);
  }
  return result.data as EditFixtureData[K];
}
