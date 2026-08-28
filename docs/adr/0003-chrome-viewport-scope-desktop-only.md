# Chrome viewport scope: desktop-only

Status: accepted (2026-08-29, owner ruling on the PR #85 thread · review round 5, item 3)

## Context

Astroix is not an internal tool. The quality bar is public-grade: the ambition is a state-of-the-art visual builder companion for Astro builds. Today, though, the chrome is a devtools overlay: sidebar, editor dock and header are mouse-and-keyboard machinery sized for a desktop workbench.

The pressure point is the shadcn Sidebar primitive below 768px: it swaps its column for a Sheet with no visible recovery affordance, because the shell renders no `SidebarTrigger` (the tabs-grilling ruling keeps the ChromeHeader untouched by shell wiring), leaving only cmd/ctrl+b. Base UI portals also render outside the shadow root, where `.dark` does not reach, so that Sheet opens light-themed on dark chrome — the finding family of the smoke-checklist Dialog (#46), whose `.dark` re-scope lands with the #61 fold-in.

## Decision

The chrome is **desktop-only for now**:

- No investment in mobile or narrow-viewport affordances in the **chrome**: no `SidebarTrigger` in the header or dock, no mobile-flavored layouts, no responsive styling around the generated primitives' behavior. The canvas-side mobile preview stays spec backlog (spec.md Implementation Decision 3), unaffected by this rule.
- Below 768px the sidebar becomes the primitive's Sheet; recovery is cmd/ctrl+b, and the light-theme Sheet there is a known, accepted state until the portal re-scope lands.
- The viewport scope may be revisited — but only as an owner ruling, when the product earns narrow-viewport users. This ADR is the default, not a lifetime sentence.

## Considered Options

- **`SidebarTrigger` in the ChromeHeader** — the primitive's own answer, but it revises the ruling that keeps the header untouched by shell wiring (header home stays `features/css` until content chrome reshapes it), and on desktop the trigger would duplicate the rail.
- **`SidebarTrigger` in the dock column (`md:hidden`)** — no ruling revision, zero desktop cost, but a permanent shell element whose only job is a viewport range the product does not serve today. Rejected as premature; the drop-in upgrade path if the missing affordance ever bites in practice.

## Consequences

- e2e runs at the desktop viewport only (1280×720 default); no mobile-lane specs.
- Future UI slices size for desktop workbenches first; the generated tier's `use-mobile` hook and Sheet branch stay untouched upstream code.
- Revisiting this decision (mobile or narrow-viewport support) opens as an owner-initiated change to this ADR, not as PR-scope creep.
