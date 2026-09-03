import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NODE_EXECUTABLE_RESOURCE_PATH,
  type PackagedAssetFailure,
  verifyPackagedAssets,
} from '@wojciechpiskorz/astroix-runtime/internal/packaged-assets';
import { describe, expect, it } from 'vitest';
import {
  type RuntimeAssetsRejection,
  resolveRuntimeAssets,
  runtimeAssetsBootDiagnostic,
} from '../../src/runtime-assets/resolve-runtime-assets.ts';
import {
  newScratchRoot,
  replaceWithOutsideSymlink,
  rewriteManifest,
  writePackagedFixture,
} from './fixtures.ts';

/**
 * The public-output no-leak legs (#244, H2): packaged paths and hashes
 * stay behind the adapter — every sanitized rejection, and the
 * fail-closed boot diagnostic main may print (its console is a public
 * surface), carries codes, relative resource ids, and pin-level detail
 * ONLY. No absolute path, no resources root, no 64-hex digest ever
 * reaches a public error surface, protocol payload, or renderer state.
 */
describe('packaged paths and hashes never leak (#244)', () => {
  it('every sanitized adapter rejection is path-free and hash-free', async () => {
    const failures = await collectFailureVocabulary();
    expect(failures.size).toBeGreaterThanOrEqual(6);

    for (const failure of failures) {
      assertSanitized(JSON.stringify(failure));
    }
  });

  it("the resolver's rejection envelope adds nothing but its own code", async () => {
    const root = await newScratchRoot('astroix-leak-resolver-');
    await writePackagedFixture(root);
    await rm(join(root, NODE_EXECUTABLE_RESOURCE_PATH));

    const rejection = (await resolveRuntimeAssets(packagedFacts(root))) as RuntimeAssetsRejection;
    assertSanitized(JSON.stringify(rejection));
  });

  it('the fail-closed boot diagnostic never prints a packaged path or a hash', async () => {
    const root = await newScratchRoot('astroix-leak-diagnostic-');
    await writePackagedFixture(root);
    await rm(join(root, NODE_EXECUTABLE_RESOURCE_PATH));

    const rejection = (await resolveRuntimeAssets(packagedFacts(root))) as RuntimeAssetsRejection;
    const diagnostic = runtimeAssetsBootDiagnostic(rejection);
    assertSanitized(diagnostic);
    // the vocabulary is the sanitized one: a code and a relative resource id
    expect(diagnostic).toContain('code=resource-missing');
    expect(diagnostic).toContain(`resource=${NODE_EXECUTABLE_RESOURCE_PATH}`);
    expect(diagnostic).toContain('there is no fallback');
  });

  it('the wrong-pin diagnostic carries version strings only — never a path', () => {
    const diagnostic = runtimeAssetsBootDiagnostic({
      code: 'packaged-resources-rejected',
      failure: {
        code: 'pin-mismatch',
        detail: { field: 'node', declared: 'v24.19.0', expected: 'v24.20.0' },
      },
    });
    expect(diagnostic).toContain('field=node');
    expect(diagnostic).toContain('declared=v24.19.0');
    expect(diagnostic).toContain('expected=v24.20.0');
    expect(diagnostic.includes('/')).toBe(false); // version strings carry no separators
  });

  it('the dev refusals name the environment variable, never a path', () => {
    const missing = runtimeAssetsBootDiagnostic({ code: 'dev-node-executable-required' });
    expect(missing).toContain('ASTROIX_DESKTOP_NODE');
    expect(missing.includes('/')).toBe(false);

    const unavailable = runtimeAssetsBootDiagnostic({ code: 'dev-checkout-unavailable' });
    expect(unavailable).toContain('controlled checkout artifacts');
    expect(unavailable.includes('/')).toBe(false);
  });
});

/** The no-leak law: no temp-absolute path fragment, no 64-hex digest. */
function assertSanitized(serialized: string): void {
  expect(serialized.includes(tmpdir()), `a temp path leaked: ${serialized}`).toBe(false);
  expect(/[0-9a-f]{64}/.test(serialized), `a SHA-256 digest leaked: ${serialized}`).toBe(false);
}

/**
 * Produces the adapter's sanitized failure vocabulary over one shared
 * broken-fixture battery — missing, unparseable, wrong-pin, tampered,
 * symlinked, and wrong-architecture layouts. Distinct shapes, so the
 * leak scan sees each.
 */
async function collectFailureVocabulary(): Promise<Set<PackagedAssetFailure>> {
  const failures: PackagedAssetFailure[] = [];

  const missing = await newScratchRoot('astroix-vocab-');
  await writePackagedFixture(missing);
  await rm(join(missing, 'astroix-runtime', 'build-manifest.json'));
  failures.push(await verifyRoot(missing));

  const unreadable = await newScratchRoot('astroix-vocab-');
  await writePackagedFixture(unreadable);
  await writeFile(join(unreadable, 'astroix-runtime', 'build-manifest.json'), 'not-json{');
  failures.push(await verifyRoot(unreadable));

  const wrongNode = await newScratchRoot('astroix-vocab-');
  await writePackagedFixture(wrongNode);
  await rewriteManifest(wrongNode, (parsed) => {
    parsed.node = 'v24.19.0';
  });
  failures.push(await verifyRoot(wrongNode));

  const tampered = await newScratchRoot('astroix-vocab-');
  await writePackagedFixture(tampered);
  await writeFile(
    join(tampered, NODE_EXECUTABLE_RESOURCE_PATH),
    'tampered-with-the-same-exec-bit\n',
  );
  failures.push(await verifyRoot(tampered));

  const symlinked = await newScratchRoot('astroix-vocab-');
  await writePackagedFixture(symlinked);
  await replaceWithOutsideSymlink(symlinked, NODE_EXECUTABLE_RESOURCE_PATH, '/bin/sh');
  failures.push(await verifyRoot(symlinked));

  const wrongArch = await newScratchRoot('astroix-vocab-');
  await writePackagedFixture(wrongArch);
  await rewriteManifest(wrongArch, (parsed) => {
    parsed.architecture = 'x64';
  });
  failures.push(await verifyRoot(wrongArch));

  return new Set(failures);
}

async function verifyRoot(root: string): Promise<PackagedAssetFailure> {
  const outcome = await verifyPackagedAssets({
    resourcesRoot: root,
    architecture: 'arm64',
    electronVersion: '44.1.0',
  });
  if (!('code' in outcome)) {
    throw new Error('the broken fixture battery must reject, never resolve');
  }
  return outcome;
}

function packagedFacts(root: string) {
  return {
    isPackaged: true,
    resourcesPath: root,
    electronVersion: '44.1.0',
    architecture: 'arm64',
    env: {},
  };
}
