# Upstream contract for the Astro project adapter proof

Checked at `2026-09-01T00:02:21Z` against npm registry metadata and the tagged sources for Astro `7.2.10` and Vite `8.2.2`.

This note records upstream facts for the disposable proof. Version numbers and dependency ranges do not certify the adapter. Certification requires the executable proof to pass against the exact installed pair.

## Current npm `latest` pair

| Package | `latest` at check time | Published | Upstream relationship |
| --- | --- | --- | --- |
| `astro` | `7.2.10` | `2026-08-31T19:39:50.142Z` | Astro declares `vite: ^8.0.13` as a dependency. |
| `vite` | `8.2.2` | `2026-08-20T04:14:39.107Z` | This version satisfies Astro's declared dependency range. |

Sources: [Astro registry metadata](https://registry.npmjs.org/astro), [Astro 7.2.10 artifact](https://registry.npmjs.org/astro/7.2.10), [Vite registry metadata](https://registry.npmjs.org/vite), [Vite 8.2.2 artifact](https://registry.npmjs.org/vite/8.2.2), and [Astro 7.2.10 package manifest](https://github.com/withastro/astro/blob/astro%407.2.10/packages/astro/package.json#L126-L179).

`^8.0.13` is an npm installation relationship. It does not say that Astroix works with every matching Vite release, nor that `7.2.10 + 8.2.2` is certified. The proof should resolve both packages from the managed project's installation, reject every pair outside its exact allowlist before loading project config, and report the detected pair, allowed pairs, and failed contract.

## Public and documented seams

### Astro project config and `getViteConfig()`

Astro documents `getViteConfig()` as an `astro/config` export that merges a caller-supplied Vite config with an optional Astro config. Astro presents it as a way to configure Vitest. The export itself is public. [Astro config imports reference](https://docs.astro.build/en/reference/modules/astro-config/#getviteconfig)

Its behavior relevant to this proof is visible in tagged source, not promised in that short API description. In `7.2.10`, it:

1. resolves the Astro project config;
2. creates settings;
3. runs `astro:config:setup`;
4. creates Astro's Vite configuration;
5. runs `astro:config:done`; and
6. merges the caller's Vite config.

[Astro 7.2.10 `getViteConfig()` source](https://github.com/withastro/astro/blob/astro%407.2.10/packages/astro/src/config/index.ts#L19-L67)

Astro documents the root config file and supports `astro.config.mjs`, `.js`, and `.ts`. Tagged source also searches `.mts`, in the order `.mjs`, `.js`, `.ts`, `.mts`, unless an explicit `configFile` is supplied. It merges inline Astro config after the file config. [Astro configuration guide](https://docs.astro.build/en/guides/configuring-astro/#the-astro-config-file), [Astro 7.2.10 config resolution](https://github.com/withastro/astro/blob/astro%407.2.10/packages/astro/src/core/config/config.ts#L18-L86), [merge order](https://github.com/withastro/astro/blob/astro%407.2.10/packages/astro/src/core/config/config.ts#L135-L152)

The composition inspector should pass the managed project root explicitly. If it knows the config path, it should pass that too. This keeps discovery in the managed project rather than the parent app's current working directory.

Astro's generated Vite config sets `configFile: false`, so Vite does not independently discover and combine a `vite.config.*` file after Astro has produced the configuration. Vite documents that an omitted `configFile` triggers root-based discovery and `false` disables it. [Astro 7.2.10 `createVite()`](https://github.com/withastro/astro/blob/astro%407.2.10/packages/astro/src/core/create-vite.ts#L166-L174), [Vite JavaScript API](https://vite.dev/guide/api-javascript#inlineconfig)

### Module runner closure

Vite documents `ModuleRunner#import()`, `clearCache()`, `close()`, and `isClosed()`. `close()` clears caches and HMR listeners and resets source-map support. [Vite Module Runner API](https://vite.dev/guide/api-environment-runtimes#modulerunner)

The tagged implementation also disconnects the transport. The server-side transport removes its `send` listener and emits a client disconnect. Every fresh runner in the proof therefore needs `await runner.close()` in `finally`, with listener removal and `isClosed()` observed. [Vite 8.2.2 runner closure](https://github.com/vitejs/vite/blob/v8.2.2/packages/vite/src/module-runner/runner.ts#L95-L119), [server transport disconnect](https://github.com/vitejs/vite/blob/v8.2.2/packages/vite/src/node/ssr/runtime/serverModuleRunner.ts#L87-L136)

### Per-environment module graphs

Vite documents `server.environments.<name>.moduleGraph` and says each environment has an isolated graph. Nodes can exist before transformation, so `transformResult` may be `null`. The compatibility `server.moduleGraph` is a mixed client and SSR view. [Vite environment instances](https://vite.dev/guide/api-environment-instances#separate-module-graphs), [Vite Environment API compatibility note](https://vite.dev/guide/api-environment#backward-compatibility)

The proof should read the graph belonging to the intended environment and fail closed on a missing node or `null` transform result. It should not use the mixed server graph.

## Experimental and version-locked seam

Vite root-exports `createServerModuleRunner(environment, options)`, but its tagged declaration marks the factory `@experimental`. It builds an HMR-capable `ModuleRunner` over the supplied `DevEnvironment`. [Vite 8.2.2 factory](https://github.com/vitejs/vite/blob/v8.2.2/packages/vite/src/node/ssr/runtime/serverModuleRunner.ts#L139-L159), [root export](https://github.com/vitejs/vite/blob/v8.2.2/packages/vite/src/node/index.ts#L64-L72)

Vite labels the broader Environment API release candidate and says some APIs remain experimental. Stability is intended within a major, but a future major may break it. [Vite Environment API status](https://vite.dev/guide/api-environment#environment-api)

The proof may use `createServerModuleRunner()` only under the exact-pair gate. Its result cannot be generalized into a cross-version adapter guarantee.

## Private and shape-coupled seams

### `virtual:astro:routes`

Astro's route plugin defines `virtual:astro:routes` inside `packages/astro/src/vite-plugin-routes`; it is not an Astro public module export or documented integration API. In `7.2.10`, the plugin serializes internal route info, reconstructs it with `deserializeRouteInfo`, and exports `routes`. [Astro 7.2.10 route virtual module](https://github.com/withastro/astro/blob/astro%407.2.10/packages/astro/src/vite-plugin-routes/index.ts#L30-L31), [emitted route module](https://github.com/withastro/astro/blob/astro%407.2.10/packages/astro/src/vite-plugin-routes/index.ts#L168-L196)

Reading `routes[*].routeData.route`, `.component`, and `.type` is private shape coupling. The proof should accept only the certified shape and reject missing or changed fields with a seam-specific diagnostic.

Astro does provide the documented `astro:routes:resolved` integration hook, but that hook belongs to the integration lifecycle and is not a substitute for out-of-process composition inspection. [Astro Integration API](https://docs.astro.build/en/reference/integrations-reference/#astroroutesresolved)

### `virtual:astro:dev-css:*`

Astro's CSS plugin defines `virtual:astro:dev-css:*` and `virtual:astro:dev-css-all` internally and states that the per-route virtual module is for development only. The per-route module exports `css` as a `Set` of objects with exactly `content`, `id`, and `url` in `7.2.10`. The all-routes module exports `devCSSMap`, mapping a route component to a function that imports its per-route module. [virtual IDs](https://github.com/withastro/astro/blob/astro%407.2.10/packages/astro/src/vite-plugin-css/const.ts#L1-L7), [development-only note and graph walk](https://github.com/withastro/astro/blob/astro%407.2.10/packages/astro/src/vite-plugin-css/index.ts#L90-L151), [per-route emitted shape](https://github.com/withastro/astro/blob/astro%407.2.10/packages/astro/src/vite-plugin-css/index.ts#L200-L262), [all-routes map](https://github.com/withastro/astro/blob/astro%407.2.10/packages/astro/src/vite-plugin-css/index.ts#L288-L320)

Neither virtual module is a supported public Astro contract. The proof should shape-check the `Set` and every entry, and fail closed if the export or fields change.

### Vite compiled CSS output

A Vite graph node exposes a nullable `transformResult`, but interpreting its `code` as CSS is output-shape coupling. In Vite `8.2.2` dev mode:

- a normal client CSS module transforms to JavaScript containing `const __vite__css = <JSON string>` and an `updateStyle` call;
- a normal server-consumer CSS module returns CSS-module exports or `export {}`;
- a `?inline` CSS request returns a default-exported CSS string; and
- a direct CSS request returns `null` from this transform branch.

[Vite 8.2.2 CSS transform branches](https://github.com/vitejs/vite/blob/v8.2.2/packages/vite/src/node/plugins/css.ts#L581-L632), [module-node shape](https://github.com/vitejs/vite/blob/v8.2.2/packages/vite/src/node/server/moduleGraph.ts#L14-L41)

The adapter must select the correct environment and request kind. It must not assume `transformResult.code` is raw CSS or an object with a `css` property. Any extraction from the `__vite__css` JavaScript sentinel needs an exact-version probe and a fail-closed parser. Astro's internal per-route dev-CSS module offers a more direct compiled-CSS shape, but it remains private and must carry the same exact-pair guard.

Execution correction: the proof found that the per-route dev-CSS entry for a buildable scoped style can carry an empty `content` string until the relevant environment-local cache is warm. The adapter therefore uses this virtual module only for route-associated CSS order, IDs, and URLs. It canonicalizes the project root, primes the page in Vite's client environment, transforms each scoped CSS URL there, then reads the client graph and fail-closed `__vite__css` parser. `REPORT.json` records the exercised result.

## Duplicate-hook contract for the proof

The duplicate is a consequence of two real Astro executions, not a documented Astro guarantee:

- `getViteConfig()` loads the managed project's Astro config and runs its `astro:config:setup` and `astro:config:done` hooks for the composition inspector. [source](https://github.com/withastro/astro/blob/astro%407.2.10/packages/astro/src/config/index.ts#L49-L66)
- the managed Astro dev container independently runs the same two config hooks during startup. [source](https://github.com/withastro/astro/blob/astro%407.2.10/packages/astro/src/core/dev/container.ts#L39-L52), [config-done call](https://github.com/withastro/astro/blob/astro%407.2.10/packages/astro/src/core/dev/container.ts#L81-L89)

For the ratified two-execution topology, a project integration should therefore observe one config-hook pass in each execution. The proof must record both passes from inside the disposable project plane. It must also run an intentionally non-idempotent integration:

- a compatible case shows that the two executions use isolated process-owned state and both start;
- an incompatible case deliberately collides through a shared external side effect, fails startup with the exact diagnostic, and records cleanup of both executions.

This does not certify arbitrary integrations. Integrations can touch ports, files, subprocesses, singletons, or external services whose duplicate execution is unsafe. Those remain unsupported unless the proof exercises them or the final adapter contract rejects them explicitly.

## Proof boundary

The public pieces are `astro/config`'s documented helper, Astro's documented integration hooks, Vite's documented runner lifecycle, and the documented per-environment graph model. `createServerModuleRunner()` is experimental. Route and dev-CSS virtual modules, their export shapes, and parsing compiled CSS from transformed JavaScript are private or shape-coupled.

The durable result should name `astro@7.2.10 + vite@8.2.2` only if the executable proof actually runs that pair and all required positive, negative, teardown, invalidation, selector-parity, and private-seam probes pass. Registry freshness alone is not evidence of adapter compatibility.
