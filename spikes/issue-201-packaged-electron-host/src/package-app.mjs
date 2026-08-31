import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

async function command(executable, args) {
  const child = spawn(executable, args, {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (code !== 0) {
    throw new Error(`${executable} ${args.join(' ')} exited ${code}\n${stdout}${stderr}`);
  }
  return { stdout, stderr };
}

async function sha256(path) {
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

async function downloadPinnedElectron(electron) {
  const filename = `electron-v${electron.version}-${electron.platform}-${electron.arch}.zip`;
  const cacheDirectory = join(homedir(), 'Library', 'Caches', 'astroix-issue-201');
  const archivePath = join(cacheDirectory, filename);
  await mkdir(cacheDirectory, { recursive: true });

  if (!(await exists(archivePath))) {
    const partialPath = `${archivePath}.partial-${process.pid}`;
    const url = `https://github.com/electron/electron/releases/download/v${electron.version}/${filename}`;
    const response = await fetch(url);
    if (!response.ok || response.body === null) {
      throw new Error(`Electron download failed: ${response.status} ${response.statusText}`);
    }
    try {
      await pipeline(
        Readable.fromWeb(response.body),
        createWriteStream(partialPath, { flags: 'wx' }),
      );
      const digest = await sha256(partialPath);
      if (digest !== electron.sha256) {
        throw new Error(`Electron archive checksum mismatch: ${digest}`);
      }
      await rename(partialPath, archivePath);
    } catch (error) {
      await rm(partialPath, { force: true });
      throw error;
    }
  }

  const digest = await sha256(archivePath);
  if (digest !== electron.sha256) {
    throw new Error(`cached Electron archive checksum mismatch: ${digest}`);
  }
  return archivePath;
}

export async function assemblePackagedApp({ electron, outputDirectory, sourceDirectory }) {
  const archivePath = await downloadPinnedElectron(electron);
  await mkdir(outputDirectory, { recursive: true });
  await command('/usr/bin/ditto', ['-x', '-k', archivePath, outputDirectory]);

  const extractedPath = join(outputDirectory, 'Electron.app');
  const appPath = join(outputDirectory, 'Astroix Proof.app');
  await rename(extractedPath, appPath);
  const resourcesPath = join(appPath, 'Contents', 'Resources');
  const packagedSource = join(resourcesPath, 'app');
  await rm(join(resourcesPath, 'default_app.asar'), { force: true });
  await mkdir(packagedSource, { recursive: true });
  await cp(join(sourceDirectory, 'app'), packagedSource, { recursive: true });
  await cp(join(sourceDirectory, 'src'), join(packagedSource, 'src'), {
    recursive: true,
  });

  const plist = join(appPath, 'Contents', 'Info.plist');
  const originalExecutable = join(appPath, 'Contents', 'MacOS', 'Electron');
  const renamedExecutable = join(appPath, 'Contents', 'MacOS', 'Astroix Proof');
  await rename(originalExecutable, renamedExecutable);
  await command('/usr/bin/plutil', [
    '-replace',
    'CFBundleExecutable',
    '-string',
    'Astroix Proof',
    plist,
  ]);
  await command('/usr/bin/plutil', [
    '-replace',
    'CFBundleIdentifier',
    '-string',
    'dev.astroix.issue-201-proof',
    plist,
  ]);
  await command('/usr/bin/plutil', ['-replace', 'CFBundleName', '-string', 'Astroix Proof', plist]);
  await command('/usr/bin/plutil', [
    '-replace',
    'CFBundleDisplayName',
    '-string',
    'Astroix Proof',
    plist,
  ]);
  const executableName = (await readFile(plist, 'utf8')).match(
    /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/,
  )?.[1];
  if (executableName === undefined) {
    throw new Error('packaged app has no CFBundleExecutable');
  }
  const executablePath = join(appPath, 'Contents', 'MacOS', executableName);
  await writeFile(
    join(packagedSource, 'package-evidence.json'),
    `${JSON.stringify({ electron, productSignature: 'ad-hoc', distributionSignature: 'none' }, null, 2)}\n`,
  );
  await command('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath]);

  return { appPath, executablePath, resourcesPath };
}
