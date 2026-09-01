import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, cp, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { runtimeFileInventory } from './packaged-assets.mjs';

const NODE_RELEASES = Object.freeze({
  'darwin-arm64': Object.freeze({
    filename: 'node-v24.20.0-darwin-arm64.tar.gz',
    sha256: '40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8',
    version: 'v24.20.0',
  }),
  'linux-x64': Object.freeze({
    filename: 'node-v24.20.0-linux-x64.tar.gz',
    sha256: '855d581f8a4eb1a8117e3426de25fe02770592febcfb31369aee1ffbfee9e8ec',
    version: 'v24.20.0',
  }),
});

export function nodeReleaseFor({ platform, arch }) {
  const release = NODE_RELEASES[`${platform}-${arch}`];
  if (release === undefined) {
    const error = new Error(
      `No qualified stock Node release exists for ${platform}/${arch}; Astroix will not fall back to another runtime.`,
    );
    error.code = 'ASTROIX_NODE_RELEASE_UNQUALIFIED';
    throw error;
  }
  return { ...release };
}

function processGroupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

function killProcessGroup(processGroupId) {
  try {
    process.kill(-processGroupId, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function waitForProcessGroupExit(processGroupId, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(processGroupId)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

export async function runCommand(executable, args, options = {}) {
  const { processGroup = false, timeoutMs = 60_000, ...spawnOptions } = options;
  const child = spawn(executable, args, {
    ...spawnOptions,
    detached: processGroup,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const result = await new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (processGroup) killProcessGroup(child.pid);
      else child.kill('SIGKILL');
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut });
    });
  });
  let processGroupClean;
  if (processGroup) {
    const failed = result.code !== 0 || result.signal !== null || result.timedOut;
    if (failed) killProcessGroup(child.pid);
    processGroupClean = await waitForProcessGroupExit(child.pid);
    if (!processGroupClean) {
      killProcessGroup(child.pid);
      await waitForProcessGroupExit(child.pid);
    }
  }
  return { ...result, processGroupClean, stdout, stderr };
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function downloadPinned({ filename, sha256, url }) {
  const cacheDirectory = join(tmpdir(), 'astroix-issue-209-cache');
  const archivePath = join(cacheDirectory, filename);
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });

  if (!(await exists(archivePath))) {
    const partialPath = `${archivePath}.partial-${process.pid}`;
    const response = await fetch(url);
    if (!response.ok || response.body === null) {
      throw new Error(`download failed: ${response.status} ${response.statusText}`);
    }
    try {
      await pipeline(
        Readable.fromWeb(response.body),
        createWriteStream(partialPath, { flags: 'wx', mode: 0o600 }),
      );
      if ((await sha256File(partialPath)) !== sha256) {
        throw new Error(`archive checksum mismatch for ${filename}`);
      }
      await rename(partialPath, archivePath);
    } catch (error) {
      await rm(partialPath, { force: true });
      throw error;
    }
  }

  if ((await sha256File(archivePath)) !== sha256) {
    throw new Error(`cached archive checksum mismatch for ${filename}`);
  }
  return archivePath;
}

export async function writeBuildManifest({ resourcesPath, release, sourceCommit }) {
  const nodePath = join(resourcesPath, 'node', 'bin', 'node');
  const runtimeDirectory = join(resourcesPath, 'astroix-runtime');
  const manifest = {
    schemaVersion: 1,
    sourceCommit,
    node: {
      arch: process.arch,
      archiveSha256: release.sha256,
      binarySha256: await sha256File(nodePath),
      platform: process.platform,
      version: release.version,
    },
    runtime: {
      files: await runtimeFileInventory(runtimeDirectory),
    },
  };
  await writeFile(
    join(resourcesPath, 'astroix-runtime', 'build-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  return manifest;
}

export async function stageRuntimeResources({ proofDirectory, resourcesPath, sourceCommit }) {
  const release = nodeReleaseFor({ platform: process.platform, arch: process.arch });
  const archivePath = await downloadPinned({
    filename: release.filename,
    sha256: release.sha256,
    url: `https://nodejs.org/download/release/v24.20.0/${release.filename}`,
  });
  const extractionDirectory = join(resourcesPath, '.node-extract');
  await mkdir(extractionDirectory, { recursive: true, mode: 0o700 });
  const extraction = await runCommand('/usr/bin/tar', [
    '-xzf',
    archivePath,
    '-C',
    extractionDirectory,
  ]);
  if (extraction.code !== 0) {
    throw new Error(`Node archive extraction failed\n${extraction.stdout}${extraction.stderr}`);
  }
  const extractedName = basename(release.filename, '.tar.gz');
  const nodeDirectory = join(resourcesPath, 'node');
  await rename(join(extractionDirectory, extractedName), nodeDirectory);
  await rm(extractionDirectory, { recursive: true, force: true });
  await chmod(join(nodeDirectory, 'bin', 'node'), 0o755);

  const runtimeDirectory = join(resourcesPath, 'astroix-runtime');
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  await cp(join(proofDirectory, 'src'), join(runtimeDirectory, 'src'), { recursive: true });
  await cp(join(proofDirectory, 'test'), join(runtimeDirectory, 'test'), { recursive: true });
  const manifest = await writeBuildManifest({ resourcesPath, release, sourceCommit });
  return {
    manifest,
    nodePath: join(nodeDirectory, 'bin', 'node'),
    release,
    runtimeDirectory,
  };
}
