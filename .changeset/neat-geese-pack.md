---
'@wojciechpiskorz/astroix': patch
---

npm-pack smoke e2e (ADR-0001 consumer lane): a minimal pack fixture consumes the actual `npm pack` tarball; a second Playwright webServer builds, packs and installs it (stable `astroix-pack.tgz` name — no per-run package.json mutation) and boots the fixture on :4313. The spec proves the chrome mounts from the prebuilt bundle (zero `/src/client` requests — source mode structurally impossible) and runs the minimal loop — select → rule list → CodeMirror edit → byte-exact disk change → canvas reflection via HMR.
