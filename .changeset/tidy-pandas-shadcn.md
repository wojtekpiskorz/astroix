---
'@wojciechpiskorz/astroix': patch
---

Wire shadcn (Base UI) into the chrome as the UI foundation.

- shadcn `base-nova` (Base UI primitives): `components.json` + `package.json#imports` aliases (`#components/*`, `#lib/*`, `#hooks/*`) resolve identically in tsc, the source-mode dev server and the prebuilt chrome build — no host-side alias wiring.
- Base component set in `src/client/components/ui/`: button, input, checkbox, select, dialog, tabs.
- `chrome.css` carries the nova theme tokens (`:root, :host` + `.dark`), `tw-animate-css` and the `shadcn/tailwind.css` base layer; the Geist font import is dropped on purpose — the prebuilt chrome stays one self-contained ESM.
- Dogfood: the header select toggle is a shadcn Button under the dark theme; e2e now asserts the theme tokens resolve inside the shadow tree.
