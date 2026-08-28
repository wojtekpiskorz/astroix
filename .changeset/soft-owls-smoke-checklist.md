---
"@wojciechpiskorz/astroix": patch
---

In-chrome owner smoke checklist (fold-in of the #46 prototype, issue #61): wizard dialog behind a top-level `?astroix_smoke=1` gate — nothing renders without the param. Gated use shows a small hint pill and the `S` shortcut (typing-guarded) summons the wizard: one step per screen over the 8 steps mirrored from `docs/manual-smoke.md`, Back/Next with progress dots, a summary screen, and a Copy report (markdown: header with date/URL/UA, per-step checkboxes with notes, Result line, agent-paste footer). Checklist state is in-memory only. The Base UI dialog portal keeps the `.dark` token re-scope on portal content.
