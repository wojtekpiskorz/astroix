#!/usr/bin/env node
/**
 * The prelaunch dependency screening for the unsupported-native fixture
 * (#259, L2; the ticket's node-sass law): reads ONE dependency manifest
 * and rejects every dependency this product's bundled runtime cannot
 * load — WITHOUT INSTALLING ANYTHING. node-sass 9 is the charter's
 * fixed input: upstream declares support for Node 14/16/18/20 (module
 * ABI 83/93/108/115) and the package is deprecated upstream in favor of
 * sass (dart-sass); the bundled Node v24.20.0 (ABI 137) is outside
 * every upstream-supported range, so the rejection is deterministic —
 * a fact about version tables, never a build attempt.
 *
 *   node reject.mjs [--manifest <package.json>] [--runtime-node v24.20.0]
 *                   [--runtime-abi 137] [--os darwin] [--arch arm64]
 *
 * Prints the screening verdict as one JSON object on stdout:
 *
 *   { accepted, phase: 'prelaunch', installed: false,
 *     rejection?: { package, version, runtime, os, architecture,
 *                   upstream-support } }
 *
 * Exit code 0 in BOTH verdict shapes — the tool's job is the
 * deterministic verdict, and the caller (the candidate matrix) fails
 * when the verdict is not the expected rejection. The only nonzero
 * exits are misuse: a missing or unparseable manifest (exit 2), which
 * is never a screening verdict.
 *
 * This module performs NO installation by construction: it opens one
 * file, reads it, and prints. There is no npm invocation, no network,
 * no filesystem write — the focused self-tests pin that (the fixture
 * directory carries no node_modules after any number of screenings).
 */
import { readFile } from 'node:fs/promises';

/** The upstream support facts the screening rules on (the node-sass README's support matrix, 9.0.0). */
const UPSTREAM_SUPPORT = Object.freeze({
  'node-sass': Object.freeze({
    supportedNode: Object.freeze(['14', '16', '18', '20']),
    supportedAbi: Object.freeze(['83', '93', '108', '115']),
    status: 'deprecated',
    recommendation: 'sass (dart-sass)',
    source:
      'the node-sass 9.0.0 support matrix (upstream README): Node 14/16/18/20 (ABI 83/93/108/115); the package is deprecated upstream in favor of sass',
  }),
});

const DEFAULT_RUNTIME = Object.freeze({
  node: 'v24.20.0',
  abi: '137',
  os: 'darwin',
  arch: 'arm64',
});

const USAGE = `usage: reject.mjs [--manifest <package.json>] [--runtime-node <vX.Y.Z>]
                  [--runtime-abi <n>] [--os <os>] [--arch <arch>]`;

function cliValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv.at(index + 1);
}

const HERE = new URL('.', import.meta.url);
const manifestPath = new URL(cliValue('--manifest') ?? 'package.json', HERE);
const runtime = {
  node: cliValue('--runtime-node') ?? DEFAULT_RUNTIME.node,
  abi: cliValue('--runtime-abi') ?? DEFAULT_RUNTIME.abi,
  os: cliValue('--os') ?? DEFAULT_RUNTIME.os,
  arch: cliValue('--arch') ?? DEFAULT_RUNTIME.arch,
};

let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
} catch (error) {
  console.error(
    `reject: the manifest at ${manifestPath.pathname} cannot be read: ${error.message}`,
  );
  console.error(USAGE);
  process.exit(2);
}

/**
 * Screens one dependency declaration against the bundled runtime:
 * `null` when the declaration is fine for this runtime, otherwise the
 * structured rejection. The table is the #259 charter's fixed input —
 * node-sass with its published support matrix; an unknown package is
 * not this fixture's subject and is never guessed at (accepting it
 * here says nothing about it: this screener is the node-sass
 * fixture's law, not a general dependency policy).
 */
function screenDependency(name, range, bundled) {
  const facts = UPSTREAM_SUPPORT[name];
  if (facts === undefined) return null;
  const nodeMajor = bundled.node.replace(/^v/, '').split('.')[0] ?? '';
  const nodeSupported = facts.supportedNode.includes(nodeMajor);
  const abiSupported = facts.supportedAbi.includes(bundled.abi);
  if (nodeSupported && abiSupported) return null;
  return {
    package: name,
    version: range,
    runtime: { node: bundled.node, abi: bundled.abi },
    os: bundled.os,
    architecture: bundled.arch,
    'upstream-support': {
      supportedNode: [...facts.supportedNode],
      supportedAbi: [...facts.supportedAbi],
      bundledNodeSupported: false,
      status: facts.status,
      recommendation: facts.recommendation,
      source: facts.source,
    },
    detail: `node-sass ${range} supports Node ${facts.supportedNode.join('/')} (ABI ${facts.supportedAbi.join('/')}); the bundled runtime ${bundled.node} (ABI ${bundled.abi}, ${bundled.os} ${bundled.arch}) is outside every upstream-supported range`,
  };
}

const declarations = {
  ...(manifest.dependencies ?? {}),
  ...(manifest.devDependencies ?? {}),
};
const rejections = [];
for (const [name, range] of Object.entries(declarations)) {
  if (typeof range !== 'string') continue;
  const rejection = screenDependency(name, range, runtime);
  if (rejection !== null) rejections.push(rejection);
}

const verdict = {
  accepted: rejections.length === 0,
  phase: 'prelaunch',
  installed: false,
  ...(rejections.length > 0 ? { rejection: rejections[0], allRejections: rejections } : {}),
};
process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
