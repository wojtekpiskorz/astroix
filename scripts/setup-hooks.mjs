#!/usr/bin/env node
/**
 * Points git's core.hooksPath at scripts/hooks — the no-hook-manager wiring
 * for the astroix pre-commit hook (blocking biome staged check + the crap4ts
 * CC-warn scan, wayfinder #55/#64). Idempotent; run once per clone via
 * `bun run hooks`.
 *
 * Deliberately NOT a postinstall: this package is published, and a
 * postinstall would rewrite git config inside consumers' repositories.
 */
import { execSync } from 'node:child_process';

execSync('git config core.hooksPath scripts/hooks', { stdio: 'pipe' });
console.log(
  'astroix: git core.hooksPath -> scripts/hooks (pre-commit: biome blocks staged lint/format, CC scan warns)',
);
