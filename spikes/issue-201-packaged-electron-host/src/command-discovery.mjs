import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export function resolvePackageCommand({ projectRoot, packageName, binName }) {
  const packageRequire = createRequire(join(resolve(projectRoot), 'package.json'));
  const packageJsonPath = packageRequire.resolve(`${packageName}/package.json`);
  const packageRoot = dirname(packageJsonPath);
  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const declaredBin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binName];

  if (typeof declaredBin !== 'string' || declaredBin.length === 0) {
    throw new Error(`${packageName} does not declare the ${binName} command`);
  }

  const commandPath = resolve(packageRoot, declaredBin);
  const fromPackage = relative(packageRoot, commandPath);
  if (fromPackage === '..' || fromPackage.startsWith(`..${sep}`) || isAbsolute(fromPackage)) {
    throw new Error(`${packageName}'s ${binName} command is outside its package directory`);
  }
  if (!existsSync(commandPath)) {
    throw new Error(`${packageName}'s ${binName} command does not exist at ${commandPath}`);
  }

  return {
    packageName,
    packageVersion: manifest.version,
    commandPath,
    source: 'project-installation',
  };
}
