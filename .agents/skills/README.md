# Vendored agent skills

Repo-local review skills so every agent (local session or CI reviewer) runs the same review, instead of depending on the owner's `~/.agents/skills` installs. Vendored for [wayfinder ticket #41](https://github.com/wojtekpiskorz/astroix/issues/41).

| Skill | Upstream | Pinned at |
| --- | --- | --- |
| `thermo-nuclear-code-quality-review/` | [cursor/plugins](https://github.com/cursor/plugins) · `cursor-team-kit/skills/thermo-nuclear-code-quality-review` (identical copy also ships in the `thermos/` plugin) | `6e3d2ea56d7d446b955eaae6ac4c8eef8bf504cf` |
| `unslop/` | [cursor/plugins](https://github.com/cursor/plugins) · `pstack/skills/unslop` (registry page: [skills.sh](https://skills.sh)) | `99559f2f52047978602ef365589275831e76af07` |

Both are MIT; each skill directory carries its upstream `LICENSE` (Cursor for thermo-nuclear, Lauren Tan for unslop). The `SKILL.md` files are byte-identical to upstream — never edit them in place, so a refresh is always a plain diff.

## Refreshing

Check a skill against upstream:

```sh
gh api repos/cursor/plugins/contents/<upstream-path>/SKILL.md --jq .content \
  | base64 -d | diff - .agents/skills/<skill>/SKILL.md
```

To adopt upstream changes, overwrite the local copy, update the pinned SHA in the table above, and note the delta in the PR description.

## Notes

- `thermo-nuclear-code-quality-review` has `disable-model-invocation: true` upstream (kept verbatim): it is invoked by an explicit review flow, not self-invoked by the model.
- The owner also keeps `unslop` at `~/.agents/skills` (identical content); the vendored copy is the repo-portable, CI-readable source of truth.
