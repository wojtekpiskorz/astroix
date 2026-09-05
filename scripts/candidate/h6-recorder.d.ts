/**
 * The narrow ambient declaration for H6's import-inert recorder module
 * (#259, L2): `apps/desktop/scripts/run-early-package-smoke.mjs` is
 * plain .mjs (no type surface), and the candidate matrix CONSUMES its
 * `batteryVerdict` — the conjunctive parser that is H6's own honesty
 * law over the early-package battery output. Declaring just that
 * surface here keeps the consumption typed without inventing types for
 * the whole module; the module itself stays H6's, untouched.
 */
declare module '*/run-early-package-smoke.mjs' {
  /** The battery's verdict as the recorder parses it (order-free Tests-line counts + the conjunctive exit). */
  export interface EarlyPackageBatteryVerdict {
    readonly passed: number;
    readonly failed: number;
    readonly skipped: number;
    readonly summary: string | null;
    readonly exitCode: number;
    readonly ok: boolean;
  }
  export function batteryVerdict(text: string, exitCode: number): EarlyPackageBatteryVerdict;
}
