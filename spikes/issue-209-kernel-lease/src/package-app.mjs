import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  downloadPinned,
  runCommand,
  stageRuntimeResources,
  writeBuildManifest,
} from './runtime-package.mjs';

const ELECTRON = Object.freeze({
  arch: 'arm64',
  filename: 'electron-v44.1.0-darwin-arm64.zip',
  platform: 'darwin',
  sha256: '9e624a8c44dee2792a532551f224ec8b8649b654a0e039416164fbf620888512',
  version: '44.1.0',
});

async function must(executable, args) {
  const result = await runCommand(executable, args, { timeoutMs: 120_000 });
  if (result.code !== 0 || result.signal !== null || result.timedOut) {
    throw new Error(
      `${executable} ${args.join(' ')} failed ${result.code}/${result.signal}\n${result.stdout}${result.stderr}`,
    );
  }
  return result;
}

async function rewritePlist(appPath) {
  const plist = join(appPath, 'Contents', 'Info.plist');
  const replacements = [
    ['CFBundleExecutable', 'Astroix Lease Proof'],
    ['CFBundleIdentifier', 'dev.astroix.issue-209-proof'],
    ['CFBundleName', 'Astroix Lease Proof'],
    ['CFBundleDisplayName', 'Astroix Lease Proof'],
  ];
  for (const [key, value] of replacements) {
    await must('/usr/bin/plutil', ['-replace', key, '-string', value, plist]);
  }
  const executableName = (await readFile(plist, 'utf8')).match(
    /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/,
  )?.[1];
  if (executableName !== 'Astroix Lease Proof') {
    throw new Error('packaged app executable name was not rewritten');
  }
}

export async function assembleMacApp({ outputDirectory, proofDirectory, sourceCommit }) {
  if (process.platform !== ELECTRON.platform || process.arch !== ELECTRON.arch) {
    throw new Error('the package-shaped Electron proof is qualified only on macOS arm64');
  }
  const electronArchive = await downloadPinned({
    filename: ELECTRON.filename,
    sha256: ELECTRON.sha256,
    url: `https://github.com/electron/electron/releases/download/v${ELECTRON.version}/${ELECTRON.filename}`,
  });
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await must('/usr/bin/ditto', ['-x', '-k', electronArchive, outputDirectory]);

  const appPath = join(outputDirectory, 'Astroix Lease Proof.app');
  await rename(join(outputDirectory, 'Electron.app'), appPath);
  const resourcesPath = join(appPath, 'Contents', 'Resources');
  await rm(join(resourcesPath, 'default_app.asar'), { force: true });
  await cp(join(proofDirectory, 'app'), join(resourcesPath, 'app'), { recursive: true });
  await cp(
    join(proofDirectory, 'src', 'packaged-assets.mjs'),
    join(resourcesPath, 'app', 'packaged-assets.mjs'),
  );
  const staged = await stageRuntimeResources({ proofDirectory, resourcesPath, sourceCommit });

  await rename(
    join(appPath, 'Contents', 'MacOS', 'Electron'),
    join(appPath, 'Contents', 'MacOS', 'Astroix Lease Proof'),
  );
  await rewritePlist(appPath);
  await writeFile(
    join(resourcesPath, 'app', 'package-evidence.json'),
    `${JSON.stringify(
      {
        electron: ELECTRON,
        node: staged.release,
        resourceLayout: ['astroix-runtime/', 'node/'],
        signature: 'ad-hoc',
      },
      null,
      2,
    )}\n`,
  );

  await must('/usr/bin/codesign', ['--force', '--sign', '-', staged.nodePath]);
  await must('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath]);
  await writeBuildManifest({
    resourcesPath,
    release: staged.release,
    sourceCommit,
  });
  await must('/usr/bin/codesign', ['--force', '--sign', '-', appPath]);
  await must('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);

  return {
    appPath,
    electron: ELECTRON,
    executablePath: join(appPath, 'Contents', 'MacOS', 'Astroix Lease Proof'),
    resourcesPath,
  };
}

export async function zipAndExtractMacApp({ appPath, outputDirectory }) {
  const archivePath = join(outputDirectory, 'Astroix-Lease-Proof.zip');
  const extractionDirectory = join(outputDirectory, 'extracted');
  await must('/usr/bin/ditto', ['-c', '-k', '--keepParent', appPath, archivePath]);
  await mkdir(extractionDirectory, { recursive: true, mode: 0o700 });
  await must('/usr/bin/ditto', ['-x', '-k', archivePath, extractionDirectory]);
  const extractedAppPath = join(extractionDirectory, 'Astroix Lease Proof.app');
  await must('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    extractedAppPath,
  ]);
  return {
    archivePath,
    appPath: extractedAppPath,
    executablePath: join(extractedAppPath, 'Contents', 'MacOS', 'Astroix Lease Proof'),
    resourcesPath: join(extractedAppPath, 'Contents', 'Resources'),
  };
}
