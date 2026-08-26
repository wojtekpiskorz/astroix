import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

// Build-correctness + package-shape gate for the prebuilt chrome (ADR-0001):
// the artifact must exist, contain zero bare react/react-dom imports (the
// consumer's Vite resolves none of our chrome deps), and the npm tarball must
// ship dist (node + chrome artifact) with no chrome source.

const artifact = 'dist/chrome.js';
const failures = [];

if (!existsSync(artifact)) {
  failures.push(`missing artifact: ${artifact}`);
} else {
  const code = readFileSync(artifact, 'utf8');
  if (code.length === 0) failures.push(`${artifact} is empty`);
  // bare imports of react / react-dom / their subpaths — minified or not
  const bareReact = code.match(/from\s*["']react(-dom)?(\/[^"']*)?["']/g);
  if (bareReact !== null) failures.push(`bare react imports in artifact: ${bareReact.join(', ')}`);
}

const packed = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' }),
);
const files = packed[0]?.files?.map((entry) => entry.path) ?? [];
const required = ['dist/index.js', 'dist/chrome.js', 'package.json'];
for (const path of required) {
  if (!files.includes(path)) failures.push(`tarball missing ${path}`);
}
const leakedSource = files.filter((path) => path.startsWith('src/'));
if (leakedSource.length > 0)
  failures.push(`tarball leaks chrome source: ${leakedSource.join(', ')}`);

if (failures.length > 0) {
  console.error(`chrome artifact check failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log(`chrome artifact check passed (${files.length} files packed)`);
