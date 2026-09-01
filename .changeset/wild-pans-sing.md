---
'@wojciechpiskorz/astroix': patch
---

Migrated the repository toolchain from bun to npm on Node 24 and paused npm publication for the Electron rewrite: npm lockfiles replace the bun locks at the root and in both linked fixtures, every script/hook/CI/staging invocation runs npm or node, and the stable and snapshot release workflows are hard-disabled pending the retirement lane. No runtime behavior changed.
