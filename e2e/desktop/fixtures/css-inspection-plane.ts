/**
 * The CSS inspection Electron lane's composition child (#249, I1; a
 * TEST entry, never the product composition — ADR-0008's lane-gate
 * law): one plain-Node process that boots the SHARED control-plane
 * composition (`apps/web/src/control-plane.ts` — the same composition
 * the web host and the privately-booted desktop child run) over an
 * isolated test registry with the staged fixture copy registered at
 * boot (the native directory grant's stand-in, test-owned setup), and
 * prints its listening line. The Electron harness main forks this
 * entry under the declared stock-Node executable — the law the real
 * desktop child follows (never Electron-as-Node) — so the plane's
 * worker and managed-dev-server children spawn under real Node too,
 * exactly as in the web host.
 *
 * Protocol: one JSON config on argv[2]; one `css-plane: ` line on
 * stdout; SIGTERM/SIGINT run the composition's ordered close.
 */

export {};

interface PlaneConfig {
  readonly registryDirectory: string;
  readonly clientDist: string;
  readonly registerRoot: string;
  readonly port: number;
  /** The dev-checkout worker register's absolute path (plane-launch's documented seam). */
  readonly registerModule: string;
}

function readConfig(argv: readonly string[]): PlaneConfig {
  const parsed: unknown = JSON.parse(argv[2] ?? '{}');
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('css-plane: the config argument is not a JSON object');
  }
  const config = parsed as Record<string, unknown>;
  for (const field of ['registryDirectory', 'clientDist', 'registerRoot', 'registerModule']) {
    if (typeof config[field] !== 'string' || (config[field] as string).length === 0) {
      throw new Error(`css-plane: the config argument misses ${field}`);
    }
  }
  if (typeof config.port !== 'number' || !Number.isInteger(config.port)) {
    throw new Error('css-plane: the config argument misses its port');
  }
  return {
    registryDirectory: config.registryDirectory as string,
    clientDist: config.clientDist as string,
    registerRoot: config.registerRoot as string,
    port: config.port as number,
    registerModule: config.registerModule as string,
  };
}

async function main(): Promise<void> {
  const config = readConfig(process.argv);
  const { createControlPlaneComposition } = await import('../../../apps/web/src/control-plane.ts');
  const composition = await createControlPlaneComposition({
    registryDirectory: config.registryDirectory,
    port: config.port,
    clientDist: config.clientDist,
    registerRoots: [config.registerRoot],
    workerExecArgv: ['--import', config.registerModule],
  });
  console.log(`css-plane: listening on ${composition.launcherOrigin}`);
  const terminate = (signal: string): void => {
    console.log(`css-plane: ${signal} — shutting down`);
    void composition.close().finally(() => process.exit(0));
  };
  process.once('SIGTERM', () => terminate('SIGTERM'));
  process.once('SIGINT', () => terminate('SIGINT'));
}

await main();
