import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The counts ledger (#214, AC-4; retained past the gate by #215, lane A6):
 * enumerates every quality lane the retired tree rests on — unit,
 * contract, and fixture — and asserts each is NON-EMPTY. Vacuity is the
 * failure mode this exists to make impossible: a lane whose tests
 * disappeared (a deleted suite, a broken discovery pattern, an emptied
 * corpus) fails readiness instead of passing greenly. The lane set is the
 * post-retirement one: the freeze suites, the retained-UI regression, and
 * the Playwright readiness aggregate died at the gate with the runtime
 * they booted; the frozen corpora, the schema validators, the retained
 * packages, and the plain-fixture smoke carry the counts now.
 *
 * Enumeration is authoritative, not hand-maintained: every vitest lane —
 * units, validators, mounts, and this suite's own legs — comes from one
 * `vitest list --json` over the root config (the runner's own collection;
 * the presentation mounts were folded into the root run in advisory round
 * 1 on #291, retiring the spawned second config and its second listing).
 * The single Playwright lane is counted statically over its authored spec
 * file (the spec declares its tests with `test(...)` at the top level;
 * the aggregate run itself is `npm run test:e2e`'s exit code), and the
 * contract corpus from the frozen directories on disk.
 */

/** One lane's row in the ledger. */
export interface LaneRow {
  lane: string;
  kind: 'unit' | 'contract' | 'fixture';
  what: string;
  count: number;
}

/** The whole ledger — emitted by the spec and recorded in the evidence report. */
export interface CountsLedger {
  rows: readonly LaneRow[];
  total: number;
}

const ROOT = process.cwd();

// --- the vitest lanes (the runner's own enumeration) ---

interface VitestListEntry {
  name: string;
  file: string;
}

function listVitest(): readonly VitestListEntry[] {
  const stdout = execFileSync('npx', ['vitest', 'list', '--json', '--config', 'vitest.config.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error('vitest list --json did not return an array');
  return parsed as VitestListEntry[];
}

function countBy(entries: readonly VitestListEntry[], prefix: string): number {
  return entries.filter((entry) => entry.file.startsWith(join(ROOT, prefix))).length;
}

// --- the playwright lane (one authored spec, statically counted) ---

function countSpecTests(specFile: string): number {
  const text = readFileSync(join(ROOT, 'e2e', specFile), 'utf8');
  const matches = text.match(/\btest\s*\(\s*['"`]/g);
  return matches === null ? 0 : matches.length;
}

// --- the frozen corpus (the directories on disk) ---

function countJsonFiles(dir: string): number {
  return readdirSync(join(ROOT, 'e2e', 'behavior-contracts', dir)).filter((name) =>
    name.endsWith('.json'),
  ).length;
}

/**
 * Assembles the ledger; THROWS on any empty lane (a zero count is a
 * readiness failure, never a passing state).
 */
export function assembleCountsLedger(): CountsLedger {
  const vitest = listVitest();

  const rows: LaneRow[] = [
    // unit lanes (vitest): the retained pure modules + the tooling
    {
      lane: 'unit:src',
      kind: 'unit',
      what: 'vitest tests under src/ (the CRAP tooling layer — complexity + crap, the only src/ survivors of the gate)',
      count: countBy(vitest, 'src/'),
    },
    {
      lane: 'unit:packages/core',
      kind: 'unit',
      what: 'vitest tests under packages/core/src (the retained editing domain)',
      count: countBy(vitest, 'packages/core/src/'),
    },
    {
      lane: 'unit:packages/app-shell',
      kind: 'unit',
      what: 'vitest tests under packages/app-shell/src (foundation + retained presentation widgets)',
      count: countBy(vitest, 'packages/app-shell/src/'),
    },
    // contract lanes: the versioned validators, the frozen corpus, the mounts
    {
      lane: 'contract:schema-validators',
      kind: 'contract',
      what: "vitest tests under e2e/behavior-contracts/schema (the frozen contracts' validators)",
      count: countBy(vitest, 'e2e/behavior-contracts/schema/'),
    },
    {
      lane: 'contract:inspection-corpus',
      kind: 'contract',
      what: 'frozen inspection fixtures under e2e/behavior-contracts/inspection',
      count: countJsonFiles('inspection'),
    },
    {
      lane: 'contract:edit-corpus',
      kind: 'contract',
      what: 'frozen edit fixtures under e2e/behavior-contracts/edit',
      count: countJsonFiles('edit'),
    },
    {
      lane: 'contract:readiness-mount',
      kind: 'contract',
      what: 'vitest mounts in presentation-mount.test.tsx (retained widgets over schema-validated contract data; a root-run sibling since advisory round 1 on #291)',
      count: countBy(vitest, 'e2e/retirement-readiness/presentation-mount.test.tsx'),
    },
    // fixture lanes: the canonical plain fixture and this suite's own legs
    {
      lane: 'fixture:plain-build',
      kind: 'fixture',
      what: 'Playwright tests in the serverless plain-fixture build smoke (the named no-product-E2E lane)',
      count: countSpecTests('plain-build.spec.ts'),
    },
    {
      lane: 'fixture:readiness',
      kind: 'fixture',
      what: 'vitest legs in this readiness suite',
      count: countBy(vitest, 'e2e/retirement-readiness/readiness.test.ts'),
    },
  ];

  const empty = rows.filter((row) => row.count === 0).map((row) => row.lane);
  if (empty.length > 0) {
    throw new Error(`vacuous quality lanes — readiness cannot pass: ${empty.join(', ')}`);
  }
  return { rows, total: rows.reduce((sum, row) => sum + row.count, 0) };
}

/** Renders the ledger as the human-readable block the report mirrors. */
export function formatCountsLedger(ledger: CountsLedger): string {
  return ledger.rows.map((row) => `- ${row.lane}: ${row.count} (${row.what})`).join('\n');
}
