---
'@wojciechpiskorz/astroix': patch
---

Converted the canonical e2e fixture to plain Astro and moved the legacy integration setup into disposable oracle copies: e2e/fixture no longer imports, registers, or depends on astroix (npm-installs and builds standalone), each integration-era e2e lane now boots a gitignored generated copy (e2e/.oracle-fixture, e2e/.oracle-pack, e2e/.oracle-src) whose config registers astroix() through the staged local links, the tracked src-fixture is deleted (its bytes were identical to the canonical fixture) and pack-fixture shrinks to a content-only oracle input. Fixture cleanup is regenerate-on-setup, replacing the git-restore boot heal.
