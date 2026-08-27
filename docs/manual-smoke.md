# Manual smoke — the owner's POC definition of done

The human half of the POC DoD (the executable half is `e2e/loop.spec.ts`,
green in CI). Canonical text from the wayfinder map (T5 grilling, Q4).

1. One command prepares and boots everything: `bun run smoke` (installs root
   + fixture, builds, boots the dev server on `:4312`). Manual equivalent:
   `bun install` (root + `e2e/fixture/`), `bun run build` (root), start the
   fixture dev server (`bun run dev` inside `e2e/fixture/`).
2. Open `http://localhost:4312/` — the chrome appears (default-on), the
   canvas shows the live page.
3. Enable select mode — hovering `h1.hero-title` shows an outline — click.
4. Rule list: scoped rule (`.astro`, file+line, hash hidden) + global
   (`home.css`, line), specificity-sorted, winner marked, `@media` badge
   present.
5. Click the winning rule — CodeMirror opens the file at the range,
   highlighted; the multi-place ranges reachable as annotations.
6. Change `color` in raw text — ~300 ms later the file on disk changed
   (`git diff` = one line), the canvas shows the new color via HMR.
7. `?builder=0` on the top-level URL — clean page, no chrome.
