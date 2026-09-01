# Lifetime-held kernel lease adapter qualification

Resolution evidence for
[Task: prove the lifetime-held registry and edit-writer lease adapter](https://github.com/wojtekpiskorz/astroix/issues/209)
under
[Wayfinder map: final Astroix Electron parent-app architecture and rewrite charter](https://github.com/wojtekpiskorz/astroix/issues/197).

## Result

Select the dependency-free, file-backed `node:sqlite` adapter for the registry
writer and edit writer. Each authority process opens its own fixed private file
with stock Node 24.20.0 `DatabaseSync`, explicitly disables extension loading,
uses the default rollback journal, executes `BEGIN IMMEDIATE` with `timeout: 0`,
and retains the connection and transaction for the full process lifetime.

The exact proof source is
[`657021ef974839fb7a4b54f1b6ea65cfcb20d481`](https://github.com/wojtekpiskorz/astroix/commit/657021ef974839fb7a4b54f1b6ea65cfcb20d481).
Its machine-readable reports are
[`REPORT.darwin-arm64.json`](./REPORT.darwin-arm64.json) and
[`REPORT.linux-x64.json`](./REPORT.linux-x64.json). The Linux report also came
from successful GitHub Actions
[run 33500672414](https://github.com/wojtekpiskorz/astroix/actions/runs/33500672414),
whose uploaded ZIP had SHA-256
`d673fbbeaa392eed51835320a36a143a38cc3b8db583457ab47eee9751fc85af`.

This qualifies one exact runtime, package shape, platform, architecture, and
local-filesystem matrix. It is decision evidence, not a production adapter or a
public release.

## Reproduce

From the repository root on a qualified host:

```sh
bun install --frozen-lockfile
node spikes/issue-209-kernel-lease/run.mjs
```

On macOS arm64, `run.mjs` downloads the pinned Electron 44.1.0 and Node 24.20.0
archives, verifies their hashes, builds the ratified `Contents/Resources`
layout, ad-hoc signs the app and bundled Node, ZIPs and extracts the app, verifies
the extracted signature with strict deep validation, and launches the app's
real executable. On Linux x64, the committed workflow assembles the same
resource shape and launches the exact bundled Node directly because the final
Linux Electron packaging target is not yet chartered.

Every run removes the platform-specific report before it starts, marks a dirty
source identity with `+working-tree`, launches the qualification in a dedicated
process group, and emits a new report only after all required cases pass. The
committed reports identify one clean source commit.

## Qualified environment

| Property | macOS qualification | Linux qualification |
| --- | --- | --- |
| Host | macOS 26.3.1 build 25D771280a, arm64 | GitHub-hosted Ubuntu 24.04, x64 |
| Local filesystem | APFS; report type `26` | Runner-local filesystem; report type `61267` |
| Packaged Node | Stock Node 24.20.0 darwin-arm64 archive, pinned by SHA-256 | Stock Node 24.20.0 linux-x64 archive, pinned by SHA-256 |
| Embedded SQLite | 3.53.4, source ID `2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc` | Same |
| Package entry | Extracted, ad-hoc-signed Electron 44.1.0 app | CI package-shaped resource root |
| Resource layout | `Contents/Resources/astroix-runtime` and `Contents/Resources/node` | `resources/astroix-runtime` and `resources/node` |
| Runtime fallback | None | None |

`node:sqlite` is Stability 1.2 in Node 24.20.0. This result therefore certifies
only that exact Node pin and embedded SQLite source. Every bundled-Node pin
change starts unqualified and must rerun the complete two-platform matrix before
release. The source basis and support reasoning are recorded in
[`UPSTREAM-RESEARCH.md`](./UPSTREAM-RESEARCH.md).

## Selected adapter boundary

The assembly layer supplies one private local state directory. The module it
constructs returns one frozen object with exactly two authority calls:

```ts
interface KernelLeaseModule {
  holdRegistryWriter(): void;
  holdEditWriter(): void;
}
```

The calls resolve internally to `registry-writer.sqlite` and
`edit-writer.sqlite`. They expose no database handle, file path, PID, owner
record, generic lease name, release callback, unlink operation, heartbeat,
expiry, or stale-owner recovery. A process may hold only its one lifetime lease.
Process exit is the release boundary.

The files are separate because SQLite grants one writer per database. That
allows the registry process and edit executor to hold their distinct
authorities concurrently while still making same-name acquisition exclusive.
The private directory is forced to mode `0700`; each file is opened with
`O_NOFOLLOW`, forced to `0600`, and rejected unless it remains a single-link
regular file.

## Passed matrix

Both reports contain the same exact set of 25 passing, non-skipped cases.

| Contract | Observed result on macOS arm64 and Linux x64 |
| --- | --- |
| Closed interface | Only the two fixed lifetime-hold calls are exposed; a process cannot take a second authority. |
| Exact runtime gate | A wrong Node pin is rejected before private state is touched. Only the exact Node 24.20.0 SQLite busy shape is classified as contention. |
| Qualification integrity | The runner rejects a missing, duplicated, failed, cancelled, skipped, or todo case. |
| First creation | A fixed lease is created in private local state with directory mode `0700`, file mode `0600`, rollback journal `delete`, and extensions disabled. |
| Same-name barrier | Two exact-Node processes start behind one barrier. Exactly one acquires; the other fails without waiting or retrying with `ASTROIX_KERNEL_LEASE_UNAVAILABLE`. |
| Different-name barrier | The registry writer and edit writer hold their separate files concurrently. |
| Clean exit | The successor acquires after the holder exits, while the fixed file remains present. No unlink or stale-owner cleanup runs. |
| Exit-listener ordering | A later synchronous JavaScript exit listener still observes the lease as held; the adapter does not release before kernel process teardown. |
| Crash exit | After `SIGKILL`, a successor acquires without PID, heartbeat, expiry, unlink, or stale-owner recovery. |
| Live orphan | Killing the parent does not transfer edit authority. The orphaned live executor excludes a replacement until that executor exits. |
| Observer isolation | Synchronous throws and rejected promises from proof observers cannot change acquisition, contention, or holder lifetime. |
| Packaged Node trust | Missing, tampered, wrongly pinned, wrong-platform, or root-symlinked bundled Node fails closed before spawn. No PATH, system Node, shell, or `ELECTRON_RUN_AS_NODE` fallback exists. |
| Runtime trust | Tampered, unmanifested, or root-symlinked runtime code fails the fixed inventory before import or spawn. |
| Child cleanup | A timed-out qualification kills its full process group, including a deliberately surviving descendant. |
| Environment boundary | `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, and an ambient proof secret are absent in the runtime; a poison `PATH` executable never runs. |

## Fail-closed policy and diagnostics

Only `{ code: "ERR_SQLITE_ERROR", errcode: 5, errstr: "database is locked" }`
from this exact pin means qualified contention. The adapter maps that case to
`ASTROIX_KERNEL_LEASE_UNAVAILABLE`. A changed or extended busy shape, wrong Node
pin, unexpected journal mode, enabled extensions, or missing transaction state
is `ASTROIX_KERNEL_LEASE_RUNTIME_UNQUALIFIED`. Unknown storage or SQLite
failures are not contention and fail as `ASTROIX_KERNEL_LEASE_FAILED` or the
more specific storage diagnostic.

Packaged-resource verification rejects invalid manifests, inventory drift,
tampering, escaping symlinks, missing binaries, wrong platform or architecture,
and wrong hashes before executing the bundled runtime. It returns only the
verified absolute bundled-Node path and always spawns it with `shell: false`.

## Rejected alternatives

- PID files, owner rows, heartbeats, leases with expiry, unlink-on-exit, and
  application stale-owner recovery are rejected. They would create a second
  authority model and cannot distinguish a live orphan from a dead owner as
  reliably as the kernel-held transaction.
- One database with a row per lease is rejected. Its database-wide writer lock
  would make the distinct registry and edit authorities mutually exclusive.
- WAL is rejected. A dedicated lease database needs no reader-writer
  concurrency, and WAL would add persistent sidecars and weaker filesystem
  portability without improving this contract.
- `flock`, a native addon, and a signed helper are not selected. The first
  dependency-free candidate passed the exact crash and orphan matrix, so another
  locking mechanism would add packaging and qualification surface without a
  demonstrated need.
- Electron RunAsNode, utility processes, PATH or system Node lookup, shell
  launch, and runtime fallback are rejected by the ratified package boundary.
- Public generic lease paths, caller-selected names, cleanup callbacks, and
  explicit release are rejected. Authority belongs to the lifetime of the
  exact process that performs the write role.

## Support boundary

The certified claim is limited to:

- stock Node 24.20.0 with the recorded SQLite 3.53.4 source;
- macOS 26.3.1 arm64 on local APFS through the extracted, ad-hoc-signed Electron
  44.1.0 package shape; and
- Ubuntu 24.04 x64 in the GitHub-hosted runner's recorded local filesystem
  through the package-shaped exact bundled-Node launch.

Unsupported and unproved: NFS, SMB, network mounts, FUSE or virtual filesystems,
cloud-synced or externally mirrored state, removable media, Windows, Intel
macOS, other Node or SQLite pins, other Electron package layouts, notarized or
distribution-signed packaging, and the final Linux Electron package. The
permanent adapter must place lease files only in known private local state and
must not infer broader filesystem support from these two observations.

## Charter readiness

Yes. The final rewrite charter has enough evidence to specify this adapter
without leaving a lock-ownership or packaging decision to an implementation
lane. It must carry the fixed two-file interface, lifetime hold, exact packaged
Node trust root, two-platform qualification gate, Stability 1.2 per-pin
requalification, fail-closed diagnostics, and explicit storage support boundary
as acceptance criteria.

The charter must not generalize this result into cross-version `node:sqlite`
support, arbitrary local-filesystem support, or a production-ready package.
