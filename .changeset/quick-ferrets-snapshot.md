---
"@wojciechpiskorz/astroix": patch
---

Experimental release channel: manual `workflow_dispatch` snapshot publishing from CI (`changeset version --snapshot experimental` + `changeset publish --tag experimental --no-git-tag`) in an ephemeral workspace, so `latest` and the changeset queue on `main` stay untouched. Consumers opt in with `@wojciechpiskorz/astroix@experimental`.
