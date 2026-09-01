# AstroProjectAdapter current-stable compatibility proof

## Result

The disposable proof passes for exactly `astro@7.2.10 + vite@8.2.2` on macOS arm64 with Node `22.22.3` and Bun `1.3.14`.

This result certifies one pair, not an Astro 7 or Vite 8 range. The adapter must reject every unlisted pair before importing the managed project's Astro config.

The machine-readable run is [`REPORT.json`](./REPORT.json). The fixture has only `astro` and `vite` dependencies. It contains a project-owned observable integration for the duplicate-hook probe, but no Astroix dependency, integration, bridge, config mutation, or hidden control file. Every live project is a disposable copy outside the repository; a passing run deletes it, and a failing run retains it with its path in the report.

## Reproduce

From the repository root:

```sh
bun install --frozen-lockfile
bun run build
node --test spikes/issue-206-astro-project-adapter/test/*.test.mjs
node spikes/issue-206-astro-project-adapter/run.mjs
```

`run.mjs` installs each disposable project from the committed lockfile, launches real Astro processes, launches Playwright, compares against the built current integration, writes `REPORT.json`, and prints one `PROOF_REPORT` JSON line. The run fails on any missing assertion.

## What passed

| Contract | Observation |
| --- | --- |
| Pair gate | The managed project resolved `astro@7.2.10 + vite@8.2.2`. An allowlist containing `vite@0.0.0-uncertified` was rejected before the config-import callback ran. The diagnostic names the detected pair, certified pair, and failed contract. |
| Plain managed project | Dependency names remained exactly `astro` and `vite`; Astroix was absent from the manifest and project config. A full-tree fingerprint, excluding only `.astro/` and `node_modules/`, found no runtime mutation beyond the proof's deliberate `src/pages/index.astro` invalidation edit. |
| Two real executions | The managed Astro dev process and composition-inspector process each ran the project-owned `astro:config:setup` hook once, under distinct PIDs with the same canonical project root and working directory. |
| Compatible duplicate hook | The deliberately append-only non-idempotent hook wrote both process observations successfully. Each distinct PID also observed its process-local module counter at `1`, proving state separation for this narrow case while the shared appendable effect ran twice. |
| Incompatible duplicate hook | The managed execution claimed an exclusive file; the composition execution then failed with `proof integration incompatible duplicate hook: exclusive side effect already claimed at …`. Its process exited nonzero after reporting that startup-failure cleanup closed the composition server; the managed process was reaped without force, and its port closed. |
| Content and schemas | Fresh-runner inspection returned `blog` entries `alpha` and `beta`, homepage entry `index`, and both schema names. A valid blog value parsed through the real project schema. The managed pages rendered the same titles and content. |
| Routes | `virtual:astro:routes` exposed `/` and `/blog/[slug]`; the real route module's `getStaticPaths()` rendered `alpha` and `beta`, and both managed URLs returned 200 with their expected titles. |
| CSS join | A static source index was joined to compiler-owned effective selectors from the client environment's transformed scoped-CSS module. Raw and compiler style blocks correlated by content, shape, and index; source and compiled rules correlated by count, order, and selector identity. The complete normalized payload equaled the preserved integration oracle. |
| Selector parity | In default `attribute` mode the scoped selector used `[data-astro-cid-*]`; in configured `where` mode it used `:where(.astro-*)`. Every global and scoped selector matched the same `data-proof-node` set in the adapter project and preserved oracle. |
| Invalidation | Editing the scoped source produced a watcher event, a new effective selector, and a browser style update without document replacement. One transient static/compiled rule-count mismatch was rejected while the two views converged; a later fresh-runner inspection passed. |
| Runner closure | Every inspection used a fresh module runner, closed it in `finally`, observed `isClosed() === true`, and restored the runner transport's `send` listener count. |
| Process cleanup | Composition servers reported closed with exit 0. Managed and oracle servers stopped without `SIGKILL`, their ports closed, and the successful temporary workspace was deleted. Timings are observations, not product budgets. |

## Public, experimental, and private seams

Public or documented seams used by the proof:

- `astro/config#getViteConfig()` to resolve and run the real managed-project config.
- Astro integration hooks to observe each project-config execution.
- Vite's JavaScript `createServer()` API and per-environment module-graph model.
- `ModuleRunner#import()`, `close()`, and `isClosed()` lifecycle behavior.

Experimental or version-locked seam:

- Vite's root-exported `createServerModuleRunner(environment)` is marked experimental. It is legal only behind the exact-pair gate.

Private or output-shape-coupled seams:

- Astro's internal `dist/vite-plugin-css/util.js#getDevCSSModuleName` export.
- `virtual:astro:routes` and `routes[*].routeData.{route,component,type}`.
- `virtual:astro:dev-css:*` and its `css: Set<{ content, id, url }>` export.
- The SSR runner hot transport's `outsideEmitter` listener accounting.
- Vite client-environment module resolution and graph ownership for transformed CSS modules.
- The `const __vite__css = <JSON string>` sentinel in Vite's client CSS JavaScript.
- Rule-order correlation between the static style block and compiled CSS.

The negative test suite exercises fail-closed rejection for the exact-pair gate, the internal Astro CSS utility, the experimental Vite runner factory, runner lifecycle methods, SSR hot transport, client environment, null module-graph transforms, both `virtual:astro:*` export shapes, compiled-CSS extraction, compiler/source style-block disagreement, a missing active-route CSS module, static/compiled rule-count disagreement, and same-count rule reordering. The live run also requires every positive seam before it can emit a passing report.

## Implementation constraints exposed by the proof

1. Canonicalize the managed project root before Astro config or client CSS work. On macOS, mixing `/var/...` and `/private/var/...` breaks Astro's compile-metadata key and can construct a duplicated root.
2. Treat `virtual:astro:dev-css:*` content as cache-dependent. Use it for route-associated CSS order, IDs, and URLs; prime the page in the client environment, transform each scoped CSS URL there, extract `__vite__css`, and verify the same transform is owned by that environment's module graph.
3. Create a fresh runner for every inspection and always close it. Never share runner cache across requests.
4. Invalidation is a convergence protocol. Disk truth can advance before compiled graph truth; reject any compiler/source, module-presence, rule-count, order, or selector-identity inconsistency and retry after watcher invalidation instead of serving or synthesizing a mismatched payload.
5. “Duplicate hooks” means one real config-hook pass in each of two separate project-plane processes. It does not mean registering Astroix twice in one Vite server.
6. Duplicate integration execution is an explicit compatibility boundary. An integration with a shared exclusive side effect is unsupported unless a future adapter-specific policy proves or isolates it.
7. The current stable `where` output is class-based (`:where(.astro-*)`), while the default output is attribute-based (`[data-astro-cid-*]`). The adapter must consume compiler output rather than synthesize either form.

## Unsupported or unproved

- Any pair other than exactly `astro@7.2.10 + vite@8.2.2`, including future npm `latest` versions or other releases satisfying semver ranges.
- Arbitrary third-party integration compatibility. Ports, files, subprocesses, process globals, network services, and other shared side effects can still make duplicate execution unsafe.
- CSS preprocessors, CSS Modules, Tailwind-specific output, custom Vite CSS plugins, multiple scoped style blocks, and selector transforms beyond the fixture's plain CSS and Astro scoped styles.
- Content loaders other than Astro's glob loader, non-Markdown content types, custom schema factories, or project-specific content plugins.
- Alternative config filenames or unusual config-loading side effects beyond normal `astro.config.mjs` discovery.
- Windows, Linux, Intel macOS, performance budgets, stress behavior under watcher bursts, and arbitrary crash timing.
- Multiple active projects, Electron hosting, proxy/HMR transport, authorization, registry persistence, packaging, signing, or production builds. Those belong to the other map decisions and proofs.
- A production adapter implementation. This branch is evidence only and changes no product or oracle source.

## Charter readiness

Yes: the final execution charter now has enough evidence to specify the adapter without hiding a compatibility decision inside an implementation lane, provided it carries the exact-pair gate and every implementation constraint above as acceptance criteria.

The charter must not generalize this result into broad Astro 7/Vite 8 support or arbitrary integration compatibility. A new pair requires a new proof run and explicit certification. A new private seam or output shape requires its own fail-closed probe. The invalidation convergence rule and duplicate-hook support boundary must be written into the adapter lane rather than decided during implementation.
