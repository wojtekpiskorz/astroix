/**
 * The proxy-health readiness prerequisite (#232, ADR-0005 `ready` gate):
 * the LAST readiness leg, after the plane's own prerequisites (pair
 * certification through the supervisor's ok-gated probe, both children,
 * the composition pipeline, and the managed dev server answering on its
 * loopback route). The proxy itself does not exist yet — it is F-wave
 * territory (F1 #233 owns origin leases and proxying; this lane may not
 * create it) — so the prerequisite is DECLARED here as an injectable
 * seam and SATISFIED by default ({@link satisfiedProxyHealth}, the
 * documented deferred check): `ready` today resolves after exactly the
 * prerequisites that exist, and F1 supplies the real check through this
 * seam without reshaping the facade.
 *
 * The seam is deliberately minimal: a check that resolves when the
 * proxy is healthy and rejects when it is not (a rejection is terminal
 * for the run — the facade stops the plane and fails the startup), plus
 * the startup abort signal so a real check can cancel its own probing
 * when the caller stops the run mid-check. No origin URL, port, or any
 * other plane detail crosses it — F1 closes over its own listener state
 * when it injects the check.
 *
 * Plane death does NOT abort this signal: only the caller's stop() does.
 * A plane that crashes between plane.ready and this check's settlement
 * leaves the check running on a dead plane — F1's injected check must
 * observe the run's own terminality (the `closed` settlement) itself,
 * or a crash-mid-check will be misreported as a proxy-health failure.
 */

/**
 * One run's proxy-health readiness check — called once per startup,
 * after the plane's own prerequisites and before `ready` resolves.
 */
export interface ProxyHealthPrerequisite {
  /**
   * Resolves when the proxy is healthy. A rejection fails the startup
   * terminally (the run is stopped and `ready` rejects); the rejection's
   * own text is never surfaced — the failure is reported through the
   * facade's sanitized boot error.
   */
  check(input: { readonly signal?: AbortSignal }): Promise<void>;
}

/**
 * The declared-but-satisfied default (the documented deferred check):
 * the prerequisite exists on the readiness path, holds the seam's exact
 * shape, and always passes — F1 (#233) replaces it with the real check.
 */
export const satisfiedProxyHealth: ProxyHealthPrerequisite = {
  check: async () => {},
};
