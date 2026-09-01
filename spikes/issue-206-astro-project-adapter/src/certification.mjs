import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const FAILED_CONTRACT =
  'exact Astro/Vite pair certification must pass before project config executes';

export async function certifyProjectBeforeConfig(options, loadConfig) {
  const pair = await readInstalledPair(options.projectRoot);
  const accepted = options.certifiedPairs.some(
    (candidate) => candidate.astro === pair.astro && candidate.vite === pair.vite,
  );
  if (!accepted) {
    const certified = options.certifiedPairs.length
      ? options.certifiedPairs.map(formatPair).join(', ')
      : 'none';
    throw new Error(
      `AstroProjectAdapter compatibility rejection: detected ${formatPair(pair)}; certified pairs: ${certified}; failed contract: ${FAILED_CONTRACT}`,
    );
  }
  return loadConfig(pair);
}

export async function readInstalledPair(projectRoot) {
  const projectRequire = createRequire(join(projectRoot, 'package.json'));
  const [astro, vite] = await Promise.all(
    ['astro', 'vite'].map(async (name) => {
      let manifestPath;
      try {
        manifestPath = projectRequire.resolve(`${name}/package.json`);
      } catch (error) {
        throw new Error(
          `AstroProjectAdapter compatibility rejection: cannot resolve ${name}/package.json from managed project ${projectRoot}; failed contract: ${FAILED_CONTRACT}`,
          { cause: error },
        );
      }
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
        throw new Error(
          `AstroProjectAdapter compatibility rejection: ${name} manifest has no string version at ${manifestPath}; failed contract: ${FAILED_CONTRACT}`,
        );
      }
      return manifest.version;
    }),
  );
  return { astro, vite };
}

function formatPair(pair) {
  return `astro@${pair.astro} + vite@${pair.vite}`;
}
