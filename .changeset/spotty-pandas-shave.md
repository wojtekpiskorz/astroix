---
'@wojciechpiskorz/astroix': patch
---

Fix the dev-server chrome boot payload: vite dev was inlining the prebuilt chrome module's transform sourcemap as a base64 data URL, tripling the served bytes (7.85 MB vs 2.2 MB of code, 72% unreadable map). The chrome-payload guard drops it, cutting every cold boot's wire bytes ~3.5x and shrinking the client-side starvation window the e2e boot-stall family rides (#171, of #129/#158); an e2e assertion pins the property. A stall-lab repro kit lands under e2e/stall-lab/ with the investigation ledger.
