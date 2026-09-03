import { type FuseV1Config, FuseV1Options, FuseVersion, getCurrentFuseWire } from '@electron/fuses';

/**
 * The release fuse law (#245, H3; ADR-0008 release hardening): the ONE
 * source of truth for the Electron runtime capability fuses the packaged
 * artifact ships with — the Forge config applies it
 * (`forge.config.ts`'s FusesPlugin imports {@link RELEASE_FUSE_CONFIG}),
 * and the packaging pipeline verifies it by READING the fuses back off
 * the real packaged binary (never by trusting the config).
 *
 * The ratified release state, per ADR-0008:
 *
 * - **RunAsNode disabled** — the packaged app can never be turned into a
 *   Node runtime (`ELECTRON_RUN_AS_NODE`); every runtime spawn goes
 *   through the bundled stock Node executable.
 * - **NODE_OPTIONS disabled** (`EnableNodeOptionsEnvironmentVariable`) —
 *   the environment cannot smuggle loader flags into the packaged
 *   Electron process.
 * - **Command-line inspection disabled** (`EnableNodeCliInspectArguments`)
 *   — `--inspect`/`--inspect-brk` arguments never reach the V8 inspector
 *   in the packaged app.
 * - **ASAR integrity enabled** (`EnableEmbeddedAsarIntegrityValidation`)
 *   — Electron validates the embedded `app.asar` hash (recorded by the
 *   packager in `Info.plist`'s `ElectronAsarIntegrity`) before loading.
 * - **only-load-app-from-ASAR enabled** — the app code can never be
 *   loaded from a loose `app` directory beside the asar.
 * - The remaining settable fuses (cookie encryption, the
 *   browser-process V8 snapshot, file-protocol privileges) stay at
 *   their off-by-default release state, ruled on EXPLICITLY.
 *
 * **The strictness split.** The pinned Forge 7.11.2 plugin accepts
 * `@electron/fuses` 1.x only (peer `^1.0.0`), and 1.x knows the eight
 * fuse slots through `GrantFileProtocolExtraPrivileges` — Electron
 * 44.1.0's wire has a NINTH (`WasmTrapHandlers`, index 8, shipped
 * enabled; the perf-neutral WebAssembly trap-handler setting, settable
 * only by @electron/fuses ≥ 2). So `strictlyRequireAllFuses` is false
 * and the completeness law lives HERE: every fuse the pinned toolchain
 * can set is explicitly ruled in {@link RELEASE_FUSE_CONFIG}, and the
 * riding ninth fuse is ruled in {@link RELEASE_RIDING_FUSE_STATES} —
 * the read-back verifies all nine by name, and a future Electron fuse
 * (a wire longer than nine) rejects as `wire-too-long` instead of
 * riding along silently.
 *
 * `resetAdHocDarwinSignature` is deliberately `false`: flipping fuses
 * invalidates the Electron Framework's embedded signature, and this
 * pipeline's own sign stage (`src/forge/codesign.ts`) re-signs ad hoc
 * with identity `-` AFTER all resources and fuses are final — the
 * FusesPlugin's own `--deep` re-sign would run inside `packageAfterCopy`,
 * before the asar and the extra resources exist, leaving a stale seal
 * that the explicit nested-first signing replaces anyway.
 */

const releaseFuses: FuseV1Config = {
  version: FuseVersion.V1,
  resetAdHocDarwinSignature: false,
  // false of necessity, not neglect: the peer-pinned 1.x toolchain
  // cannot express Electron 44's ninth fuse (see the header). The
  // completeness law moved to the read-back below.
  strictlyRequireAllFuses: false,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
};

/** The concrete release fuse config the FusesPlugin applies — imported by `forge.config.ts`. */
export const RELEASE_FUSE_CONFIG: Readonly<FuseV1Config> = Object.freeze(releaseFuses);

/**
 * The fuses the pinned 1.x toolchain cannot set — explicitly ruled at
 * their Electron-shipped state instead of silently riding. Verified by
 * the read-back like every other fuse.
 */
export const RELEASE_RIDING_FUSE_STATES: Readonly<Record<string, 'enable' | 'disable'>> =
  Object.freeze({
    WasmTrapHandlers: 'enable', // Electron 44.1.0 ships the wire's ninth slot enabled
  });

/** One wire slot: the name the law reads by, the wire index it lives at. */
interface WireFuse {
  readonly name: string;
  readonly index: number;
}

/** The V1 wire's fuses in wire order — the BINARY's vocabulary (nine slots in Electron 44). */
const V1_WIRE: readonly WireFuse[] = Object.freeze([
  { name: 'RunAsNode', index: FuseV1Options.RunAsNode },
  { name: 'EnableCookieEncryption', index: FuseV1Options.EnableCookieEncryption },
  {
    name: 'EnableNodeOptionsEnvironmentVariable',
    index: FuseV1Options.EnableNodeOptionsEnvironmentVariable,
  },
  { name: 'EnableNodeCliInspectArguments', index: FuseV1Options.EnableNodeCliInspectArguments },
  {
    name: 'EnableEmbeddedAsarIntegrityValidation',
    index: FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
  },
  { name: 'OnlyLoadAppFromAsar', index: FuseV1Options.OnlyLoadAppFromAsar },
  {
    name: 'LoadBrowserProcessSpecificV8Snapshot',
    index: FuseV1Options.LoadBrowserProcessSpecificV8Snapshot,
  },
  {
    name: 'GrantFileProtocolExtraPrivileges',
    index: FuseV1Options.GrantFileProtocolExtraPrivileges,
  },
  { name: 'WasmTrapHandlers', index: 8 }, // beyond the 1.x enum; see RELEASE_RIDING_FUSE_STATES
]);

/** Every fuse name the law reads, in wire order. */
export const V1_FUSE_NAMES: readonly string[] = Object.freeze(V1_WIRE.map((fuse) => fuse.name));

/** One fuse's verified state, as the wire encodes it. */
export type VerifiedFuseState = 'enable' | 'disable' | 'inherit' | 'removed';

/** The fuse states a binary read reports — keyed by fuse name, wire order preserved. */
export type VerifiedFuseStates = Readonly<Record<string, VerifiedFuseState>>;

/** Why a fuse read could not produce states at all. */
export type FuseReadRejection =
  | { readonly code: 'binary-unreadable' }
  | { readonly code: 'sentinel-missing' }
  | { readonly code: 'wire-version-mismatch'; readonly found: string }
  | { readonly code: 'wire-unknown-state'; readonly fuse: string }
  | { readonly code: 'wire-too-short'; readonly found: number; readonly expected: number }
  | { readonly code: 'wire-too-long'; readonly found: number; readonly expected: number };

const STATE_BYTES: Readonly<Record<number, VerifiedFuseState>> = Object.freeze({
  48: 'disable', // FuseState.DISABLE
  49: 'enable', // FuseState.ENABLE
  114: 'removed', // FuseState.REMOVED
  144: 'inherit', // FuseState.INHERIT
});

/**
 * Reads the live fuse states off a real Electron binary or `.app` bundle
 * (through the same wire walk `@electron/fuses` writes with): the fuse
 * wire sits after its sentinel in the Electron Framework binary, and this
 * read is the verification law's eyes — the pipeline asserts the wire
 * against {@link expectedReleaseFuseStates}, never against the config
 * that set it.
 */
export async function readFuseStates(
  binaryOrAppPath: string,
): Promise<VerifiedFuseStates | FuseReadRejection> {
  let wire: Awaited<ReturnType<typeof getCurrentFuseWire>>;
  try {
    wire = await getCurrentFuseWire(binaryOrAppPath);
  } catch (error) {
    return (error as Error).message.includes('Could not find sentinel')
      ? { code: 'sentinel-missing' }
      : { code: 'binary-unreadable' };
  }
  if (wire.version !== '1') {
    return { code: 'wire-version-mismatch', found: wire.version };
  }
  const states: Record<string, VerifiedFuseState> = {};
  for (const fuse of V1_WIRE) {
    const raw = wire[fuse.index as FuseV1Options] as number | undefined;
    const state: VerifiedFuseState | undefined = raw === undefined ? undefined : STATE_BYTES[raw];
    if (state === undefined) {
      return { code: 'wire-unknown-state', fuse: fuse.name };
    }
    states[fuse.name] = state;
  }
  const wireLength = Object.keys(wire).filter((key) => Number.isInteger(Number(key))).length;
  // the ride-along belt, both directions: a SHORTER wire cannot carry the
  // law's nine, and a LONGER one means an Electron fuse this table does
  // not rule on — neither may pass verification silently
  if (wireLength < V1_WIRE.length) {
    return { code: 'wire-too-short', found: wireLength, expected: V1_WIRE.length };
  }
  if (wireLength > V1_WIRE.length) {
    return { code: 'wire-too-long', found: wireLength, expected: V1_WIRE.length };
  }
  return states;
}

/**
 * The release law as read-back expectations — the settable fuses derive
 * from {@link RELEASE_FUSE_CONFIG} and the riding ninth from
 * {@link RELEASE_RIDING_FUSE_STATES}, so the config and the verifier can
 * never drift apart.
 */
export function expectedReleaseFuseStates(): VerifiedFuseStates {
  const expected: Record<string, VerifiedFuseState> = {};
  for (const fuse of V1_WIRE) {
    const riding = RELEASE_RIDING_FUSE_STATES[fuse.name];
    if (riding !== undefined) {
      expected[fuse.name] = riding;
      continue;
    }
    const configured = releaseFuses[fuse.index as FuseV1Options];
    if (typeof configured !== 'boolean') {
      // unreachable while the config rules every 1.x fuse — the
      // read-back belt owns it anyway: an unruled fuse is drift.
      throw new Error(`release-fuses: the release config does not rule on fuse ${fuse.name}`);
    }
    expected[fuse.name] = configured ? 'enable' : 'disable';
  }
  return expected;
}

/** The fuses whose read-back state differs from the law — the offending fuses only. */
/**
 * The state a violating fuse was actually found in — or `absent` when
 * the actual map did not carry the fuse at all: a partial actual map is
 * itself a violation, never a vacuous pass (the strictness split's
 * other half — every wire fuse must be ruled on AND reported).
 */
export type FuseViolationActual = VerifiedFuseState | 'absent';

export function fuseStateViolations(
  actual: Readonly<Record<string, VerifiedFuseState | undefined>>,
  expected: VerifiedFuseStates,
): ReadonlyArray<{
  readonly fuse: string;
  readonly actual: FuseViolationActual;
  readonly expected: VerifiedFuseState;
}> {
  const violations: Array<{
    fuse: string;
    actual: FuseViolationActual;
    expected: VerifiedFuseState;
  }> = [];
  for (const fuse of V1_WIRE) {
    const actualState = actual[fuse.name];
    const expectedState: VerifiedFuseState | undefined = expected[fuse.name];
    if (actualState === undefined) {
      violations.push({
        fuse: fuse.name,
        actual: 'absent',
        expected: expectedState as VerifiedFuseState,
      });
      continue;
    }
    if (actualState !== expectedState) {
      violations.push({
        fuse: fuse.name,
        actual: actualState,
        expected: expectedState as VerifiedFuseState,
      });
    }
  }
  return violations;
}
