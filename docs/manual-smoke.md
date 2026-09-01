# Manual smoke — the owner's pre-alpha definition of done

Rewritten for the Electron parent-app rewrite (lane A1, [#210](https://github.com/wojtekpiskorz/astroix/issues/210)). The integration-era smoke checklist (`bun run smoke`, `?builder=1`, the in-chrome wizard) is retired with the integration (ADR-0010) — it verified injected-chrome behavior that no longer exists as a product surface. This checklist is the **final owner manual smoke through the delivered packaged artifact**, per the packaged-artifact contract (ADR-0008, [#207](https://github.com/wojtekpiskorz/astroix/issues/207)) and the charter's last lane: run it on the exact candidate asset, record release evidence and tester instructions, then create the git tag. Any discovered defect returns to its own earlier implementation lane.

It becomes executable once the packaged-host and vertical lanes land; until then it is the normative shape those lanes are built against.

## Environment

- Apple Silicon Mac, macOS 13.5+.
- The exact candidate ZIP from the access-limited GitHub draft release, with its published SHA-256 checksum verified before extraction.
- Extract via Finder, move Astroix to Applications.

## Checklist

1. **First launch through Gatekeeper**: the blocked launch is expected (ad-hoc sealed, not notarized); open via System Settings → Privacy & Security → Open Anyway. Never remove quarantine attributes or disable Gatekeeper.
2. **Neutral launcher**: the app opens on the launcher (no project auto-activated); registered-project list is empty.
3. **Register an existing project**: `Add Existing Project...` from the application menu; pick a representative Astro project using the certified pair (`astro@7.2.10` + `vite@8.2.2`). The project's files are untouched by registration (zero injection — `git status` clean apart from ordinary Astro/Vite caches).
4. **Activation**: the project activates, the app shell appears, the canvas loads the project's natural URL; HMR works (edit a file in the IDE, watch the canvas update).
5. **CSS loop**: enable selection mode, hover outline, click an element; the rule list shows scoped + global rules with file/line, specificity-sorted, winner marked, `@media` badges; edit the winning rule; ~300 ms later the file on disk changed (one-line `git diff`) and the canvas reflects it via HMR; a racing IDE write is refused with the changed-on-disk diff, not spliced.
6. **Content loop**: open the Content vertical, pick an entry, edit a field and the body; auto-write lands the frontmatter edit preserving comments/order; validation flags errors without blocking a draft.
7. **A to B to A switching**: register a second project; switch to it (transactional switch, top-level navigation); the old tab is invalid (`421`/reset), no stale selection or queued write crosses over; switch back to the first project — a fresh session, no stale authority; a read-only diagnostic target stays read-only throughout.
8. **Quit and relaunch**: quit (clean close report); relaunch; the registry remembers both projects; the app does not auto-activate.
9. **Incompatible dependency diagnostic**: register a project whose dependency cannot run under the bundled Node runtime; activation fails with a clear diagnostic and no managed-project mutation.
10. **Service Worker resilience**: in a project with a root-scoped Service Worker, authoritative app/API/canvas/SSE traffic is not intercepted while native Vite HMR still works.

## Release evidence

- Record per-step pass/fail with notes, plus: artifact checksum, macOS version, machine, and the app/build manifest versions.
- The smoked candidate bytes are what get promoted to the final tag/release — never a post-smoke rebuild.
- Tester instructions (browser download, checksum verification, Finder extraction, Applications move, first blocked launch, Open Anyway, registration, known limits, failure reporting) ship with the release, per ADR-0008.
