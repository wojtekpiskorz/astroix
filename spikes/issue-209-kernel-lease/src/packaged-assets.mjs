import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

const CERTIFIED_NODE_VERSION = 'v24.20.0';

function publicError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function sha256(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

export async function runtimeFileInventory(runtimeDirectory) {
  const files = [];

  async function walk(directory, relativeDirectory = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (relativePath === 'build-manifest.json') continue;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) throw new Error(`unsupported runtime entry: ${relativePath}`);
      const metadata = await stat(absolutePath);
      files.push({
        path: relativePath,
        sha256: await sha256(absolutePath),
        size: metadata.size,
      });
    }
  }

  await walk(runtimeDirectory);
  return files;
}

function validRuntimeFile(file) {
  return (
    typeof file?.path === 'string' &&
    file.path.length > 0 &&
    file.path === posix.normalize(file.path) &&
    file.path !== '..' &&
    !file.path.startsWith('../') &&
    !file.path.includes('\\') &&
    /^[a-f0-9]{64}$/.test(file?.sha256) &&
    Number.isSafeInteger(file?.size) &&
    file.size >= 0
  );
}

function containedBy(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

async function readManifest(runtimeDirectory) {
  try {
    const raw = await readFile(join(runtimeDirectory, 'build-manifest.json'), 'utf8');
    const manifest = JSON.parse(raw);
    if (
      manifest?.schemaVersion !== 1 ||
      typeof manifest?.node?.arch !== 'string' ||
      typeof manifest?.node?.binarySha256 !== 'string' ||
      typeof manifest?.node?.platform !== 'string' ||
      typeof manifest?.node?.version !== 'string' ||
      !Array.isArray(manifest?.runtime?.files) ||
      manifest.runtime.files.length === 0 ||
      !manifest.runtime.files.every(validRuntimeFile) ||
      new Set(manifest.runtime.files.map((file) => file.path)).size !==
        manifest.runtime.files.length
    ) {
      throw new Error('invalid schema');
    }
    return manifest;
  } catch {
    throw publicError(
      'ASTROIX_RESOURCE_MANIFEST_INVALID',
      'Astroix cannot start because its packaged resource manifest is missing or invalid. Reinstall the exact Astroix build.',
    );
  }
}

export async function verifyPackagedAssets({ resourcesPath }) {
  if (typeof resourcesPath !== 'string' || resourcesPath.length === 0) {
    throw new TypeError('resourcesPath is required');
  }
  let resourcesRoot;
  let runtimeDirectory;
  try {
    resourcesRoot = await realpath(resourcesPath);
    const runtimeCandidate = join(resourcesPath, 'astroix-runtime');
    const runtimeMetadata = await lstat(runtimeCandidate);
    runtimeDirectory = await realpath(runtimeCandidate);
    if (
      runtimeMetadata.isSymbolicLink() ||
      !runtimeMetadata.isDirectory() ||
      !containedBy(resourcesRoot, runtimeDirectory)
    ) {
      throw new Error('runtime root escaped package resources');
    }
  } catch {
    throw publicError(
      'ASTROIX_RUNTIME_INTEGRITY_FAILED',
      'Astroix cannot start because its packaged runtime files failed integrity verification. Reinstall the exact Astroix build.',
    );
  }
  const manifest = await readManifest(runtimeDirectory);
  let actualRuntimeFiles;
  try {
    actualRuntimeFiles = await runtimeFileInventory(runtimeDirectory);
  } catch {
    throw publicError(
      'ASTROIX_RUNTIME_INTEGRITY_FAILED',
      'Astroix cannot start because its packaged runtime files failed integrity verification. Reinstall the exact Astroix build.',
    );
  }
  if (JSON.stringify(actualRuntimeFiles) !== JSON.stringify(manifest.runtime.files)) {
    throw publicError(
      'ASTROIX_RUNTIME_INTEGRITY_FAILED',
      'Astroix cannot start because its packaged runtime files failed integrity verification. Reinstall the exact Astroix build.',
    );
  }
  if (
    manifest.node.version !== CERTIFIED_NODE_VERSION ||
    manifest.node.platform !== process.platform ||
    manifest.node.arch !== process.arch
  ) {
    throw publicError(
      'ASTROIX_BUNDLED_NODE_UNQUALIFIED',
      `Astroix cannot start because packaged Node ${manifest.node.version}/${manifest.node.platform}/${manifest.node.arch} is not qualified. Expected ${CERTIFIED_NODE_VERSION}/${process.platform}/${process.arch}.`,
    );
  }

  const nodeRootCandidate = join(resourcesPath, 'node');
  const expectedPath = join(nodeRootCandidate, 'bin', 'node');
  let nodePath;
  let nodeRoot;
  let nodeRootMetadata;
  let expectedMetadata;
  let nodeMetadata;
  try {
    nodeRootMetadata = await lstat(nodeRootCandidate);
    expectedMetadata = await lstat(expectedPath);
    nodeRoot = await realpath(nodeRootCandidate);
    nodePath = await realpath(expectedPath);
    nodeMetadata = await stat(nodePath);
  } catch {
    throw publicError(
      'ASTROIX_BUNDLED_NODE_MISSING',
      'Astroix cannot start because its bundled Node resource is missing. Reinstall the exact Astroix build.',
    );
  }

  const fromRoot = relative(nodeRoot, nodePath);
  if (
    nodeRootMetadata.isSymbolicLink() ||
    !nodeRootMetadata.isDirectory() ||
    expectedMetadata.isSymbolicLink() ||
    !containedBy(resourcesRoot, nodeRoot) ||
    !containedBy(resourcesRoot, nodePath) ||
    !nodeMetadata.isFile() ||
    (nodeMetadata.mode & 0o111) === 0 ||
    fromRoot === '..' ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot) ||
    (await sha256(nodePath)) !== manifest.node.binarySha256
  ) {
    throw publicError(
      'ASTROIX_BUNDLED_NODE_INTEGRITY_FAILED',
      'Astroix cannot start because its bundled Node resource failed integrity verification. Reinstall the exact Astroix build.',
    );
  }

  return Object.freeze({
    nodePath,
    runtime: Object.freeze({
      arch: manifest.node.arch,
      platform: manifest.node.platform,
      version: manifest.node.version,
    }),
  });
}
