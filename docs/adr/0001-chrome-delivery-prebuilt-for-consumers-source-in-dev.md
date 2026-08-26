# Chrome delivery: prebuilt bundle for consumers, source-served only in our dev checkout

Status: accepted (2026-08-26, wayfinder T4 · map #1)

The builder chrome is a React 19 app, and the original doctrine served it as raw source through the host project's Vite (virtual module, "no client build") to get free HMR. Research (wayfinder T3, issue #4) showed that source-serving React through a *foreign* Vite is unsafe — the optimizer keys optimized deps by bare specifier so a React-shipping host silently feeds the chrome its own copy, `resolve.dedupe` resolves only from the host root, aliases are defeated by `vite:pre-alias`, imports from `node_modules` skip optimization and get raw CJS — and that no surveyed comparable tool does it at all. We keep the dev-loop benefit and drop the foreign-host risk by splitting delivery: the **published package ships a prebuilt chrome bundle** (single ESM with react/react-dom, Tailwind, CodeMirror inside) loaded via the virtual chrome module, while our **dev checkout** (dogfood fixture via `file:`) serves the chrome as source with injected `@vitejs/plugin-react` + `@tailwindcss/vite` for full fast-refresh — a controlled host where bare `react` safely resolves to the repo's own React 19.

## Considered Options

- **Source-served everywhere** (original stack #10) + the T3 mechanism (publish-time ESM prebundle of react/react-dom behind astroix-owned virtual ids `astroix:react`, never registering `react` in the host optimizer, dev-time instance guard, host-React-18 fixture): best dev loop in every host, but novel machinery operating inside foreign hosts. Rejected: novel where the whole industry prebuilds, and unnecessary once foreign hosts stop seeing chrome source at all.
- **Prebuilt everywhere** (pure bundle, also in dev): simplest and safest, but chrome development loses fast-refresh (watch rebuild + full document reload each change). Rejected: the owner requires HMR while building Astroix — that requirement is what this ADR exists to satisfy alongside the safety goal.

## Consequences

- react/react-dom are **devDependencies**: consumed at package build, bundled into the chrome bundle; consumers never resolve them (zero React surface for host projects).
- Two serving modes exist and both are e2e-tested: the main fixture (`file:` link) exercises source mode; an `npm-pack` smoke fixture exercises the exact shipped artifact (need already flagged by T1).
- The mode switch lives in the virtual chrome module's `load()` (dev-checkout detection is a backlog detail). The `plugin-react` preamble behavior in source mode is an implementation-time verification (open question from T3).
- A cheap warn-only React instance/version guard ships in the chrome; a host-React-18 fixture is unnecessary by construction (foreign hosts load the bundle) — recorded as the tripwire to revisit only if source-serving is ever extended to foreign hosts.
- Canvas HMR is unaffected in both modes — it is the host's own HMR (`/@vite/client` in the iframe), not the chrome's.
