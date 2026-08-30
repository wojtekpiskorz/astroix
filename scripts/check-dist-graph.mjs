import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'oxc-parser';

// Graph-based-classification guard (#138): every bare specifier in the
// node-side dist output must resolve at a consumer — node builtins, packages
// in `dependencies`, or peers supplied by the host (`astro`, `vite`). A
// devDep leaking as a bare import (the yaml/entry-writer trap class: node-side
// code picking up a client-only library) fails here in CI instead of at a
// consumer's first install. dist/chrome.js is out of scope by design: it is
// the browser artifact whose deps vite bundles (ADR-0001), gated separately
// by check-chrome-artifact.mjs.

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, 'dist');
const CHROME_BUNDLE = 'chrome.js';
const BUILTINS = new Set(builtinModules);
const isBuiltin = (specifier) =>
  BUILTINS.has(specifier.startsWith('node:') ? specifier.slice(5) : specifier);

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const allowed = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
]);

const failures = [];

if (!existsSync(join(DIST, 'index.js'))) {
  failures.push('missing dist/index.js — run bun run build first');
}

// oxc's AST over the built artifact: statics as top-level declarations,
// dynamic import() nested anywhere (a plain recursive walk — bundled output
// has no syntax a parser can misread as an import, which is why this is not
// a regex over `from "..."` text).
function importSpecifiers(code, filename) {
  const { program, errors } = parseSync(filename, code);
  const firstError = errors[0];
  if (firstError !== undefined) throw new SyntaxError(`${filename}: ${firstError.message}`);

  const specs = [];
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node === null || typeof node !== 'object' || typeof node.type !== 'string') return;
    if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration') {
      specs.push(node.source.value);
    } else if (node.type === 'ExportNamedDeclaration' && node.source !== null) {
      specs.push(node.source.value);
    } else if (
      node.type === 'ImportExpression' &&
      (node.source?.type === 'StringLiteral' || node.source?.type === 'Literal')
    ) {
      // raw-oxc string literals are `Literal`; the ESTree flavor says StringLiteral
      specs.push(node.source.value);
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(program);
  return specs;
}

/** `@scope/name/sub`, `name/sub`, `virtualns:rest` → the owning package name. */
function packageNameOf(specifier) {
  const colon = specifier.indexOf(':');
  if (colon !== -1) return specifier.slice(0, colon); // virtual id, e.g. astro:content
  const segments = specifier.split('/');
  return segments[0]?.startsWith('@') === true
    ? segments.slice(0, 2).join('/')
    : (segments[0] ?? '');
}

const surface = new Map(); // package (or :builtin/:skip) → [file, specifier]

function classify(specifier, file) {
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    surface.set(':relative', [...(surface.get(':relative') ?? []), `${file}: ${specifier}`]);
    return;
  }
  if (specifier.startsWith('#')) {
    failures.push(`${file}: package-private #import escaped the bundle: ${specifier}`);
    return;
  }
  const name = isBuiltin(specifier) ? ':builtin' : packageNameOf(specifier);
  if (name !== ':builtin' && !allowed.has(name)) {
    failures.push(
      `${file}: "${specifier}" resolves to ${name || '(unparsable)'}, which is not a dependency, peer, or builtin`,
    );
    return;
  }
  surface.set(name, [...(surface.get(name) ?? []), `${file}: ${specifier}`]);
}

const files = existsSync(DIST)
  ? readdirSync(DIST, { recursive: true })
      .map((entry) => String(entry))
      .filter((entry) => /\.(js|d\.ts)$/.test(entry) && entry !== CHROME_BUNDLE)
      .sort()
  : [];

for (const entry of files) {
  for (const specifier of importSpecifiers(readFileSync(join(DIST, entry), 'utf8'), entry)) {
    classify(specifier, entry);
  }
}

if (failures.length > 0) {
  console.error(`dist import-graph check failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}

const summary = [...surface.entries()].map(([name, uses]) => `${name} (${uses.length})`).join(', ');
console.log(`dist import-graph check passed (${files.length} files scanned; imports: ${summary})`);
