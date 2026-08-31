---
'@wojciechpiskorz/astroix': patch
---

Make the e2e suite boot-resilient under load (#158, of #129's boot-contention family): a shared boot gate waits on cold-boot markers with explicit budgets — 75 s for the builder refresh arm's post-reload canvas visibility (housed by an in-body 120 s test timeout) and 105 s for a chrome-mounted marker in the shared openEntry helper before any interaction (housed by literal 150 s file-level timeouts in every consumer — auto-write, live-refresh, body-editor, the last via openBodyEditor dropping its drifted pane-wait copy; the consumer files declare no test.slow(), whose annotation silently triples declared ceilings) — and recovers from the request-scoped first-boot stall the flake family traced to: a stalled chrome-module request clears when the waiting page cancels it, so the gate reloads once inside its budget. A genuinely hung boot still fails at the budget with a boot-naming error instead of an anonymous action-timeout death.
