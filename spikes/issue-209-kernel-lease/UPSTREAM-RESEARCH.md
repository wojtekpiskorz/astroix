# Issue 209 upstream research: kernel lease candidate

Status: research evidence only; no executable qualification has run here.  
Researched: 2026-09-01.  
Scope: exact stock Node.js 24.20.0, its bundled SQLite, SQLite locking, and the
already-ratified Electron 44.1.0 / Forge 7.11.2 packaged-runtime shape.

## Bottom line

The upstream contract supports trying the dependency-free adapter first: keep
one file-backed `DatabaseSync` connection in a live operating-system process,
execute `BEGIN IMMEDIATE` with `timeout: 0`, and retain both the connection and
transaction for the lease lifetime. SQLite permits only one simultaneous write
transaction per database; a competing `BEGIN IMMEDIATE` can therefore fail with
`SQLITE_BUSY` at acquisition time. Two independently holdable names require two
distinct database files, so `registry-writer` and `edit-writer` must map to two
fixed internal files rather than rows in one database. These are direct
consequences of SQLite's transaction rules, not behaviors invented by the
adapter. ([transactions](https://www.sqlite.org/lang_transaction.html#immediate),
[result codes](https://www.sqlite.org/rescode.html#busy))

Upstream documentation does **not** complete issue 209. It does not certify the
exact barrier-start, first-creation, clean handoff, `SIGKILL` handoff, or
live-orphan matrix on macOS arm64 and Linux, and it does not certify launch from
the final signed Electron package. Those remain executable proof obligations.
In particular, SQLite describes kernel locks as normally vanishing when their
process exits, but deliberately qualifies that statement because the VFS,
operating system, and filesystem supply the actual lock semantics.
([SQLite atomic-commit locking](https://www.sqlite.org/atomiccommit.html#section_3_2))

## Pinned sources

| Source | Version or source date used | Relevant fact |
| --- | --- | --- |
| Node.js | v24.20.0, released 2026-08-26 | Exact runtime under qualification; `node:sqlite` is Stability 1.2. ([release tag](https://github.com/nodejs/node/releases/tag/v24.20.0), [versioned SQLite docs](https://nodejs.org/download/release/v24.20.0/docs/api/sqlite.html)) |
| SQLite embedded in Node | 3.53.4, source ID dated 2026-07-24 | This, not the host's system SQLite, is the implementation exercised by stock Node 24.20.0. ([Node's pinned header](https://github.com/nodejs/node/blob/v24.20.0/deps/sqlite/sqlite3.h#L149-L154)) |
| SQLite documentation | Transaction/result pages updated 2026-02-18; corruption guide updated 2026-04-13; WAL page updated 2026-08-25 | Locking and filesystem constraints quoted below. ([transaction page](https://www.sqlite.org/lang_transaction.html), [corruption guide](https://www.sqlite.org/howtocorrupt.html), [WAL](https://www.sqlite.org/wal.html)) |
| Electron | v44.1.0 tag dated 2026-08-31 | `process.resourcesPath`, RunAsNode, and fuse behavior are taken from this exact source tag. ([tag](https://github.com/electron/electron/releases/tag/v44.1.0), [process docs](https://github.com/electron/electron/blob/v44.1.0/docs/api/process.md), [fuse docs](https://github.com/electron/electron/blob/v44.1.0/docs/tutorial/fuses.md)) |
| Electron Forge | v7.11.2 tag dated 2026-05-20 | Forge delegates `packagerConfig` to Electron Packager and depends on Packager `^18.3.5`; the permanent implementation must lock the resolved dependency too. ([Forge package](https://github.com/electron/forge/blob/v7.11.2/packages/api/core/package.json), [configuration resolution](https://github.com/electron/forge/blob/v7.11.2/packages/api/core/src/util/forge-config.ts#L224-L250)) |

All SQLite claims below refer to the documented SQLite behavior and the exact
3.53.4 copy embedded by Node 24.20.0. A later SQLite page may describe behavior
newer than 3.53.4; where that matters, the exact Node source is cited instead.

## 1. Exact `DatabaseSync` behavior

`DatabaseSync` represents one SQLite connection and all its APIs execute
synchronously. Its writable file open uses `SQLITE_OPEN_READWRITE |
SQLITE_OPEN_CREATE | SQLITE_OPEN_URI`; its native open path installs the
configured value with `sqlite3_busy_timeout()`. The v24.20.0 configuration
default is `timeout_ = 0`. ([Node API](https://nodejs.org/download/release/v24.20.0/docs/api/sqlite.html#class-databasesync),
[open source](https://github.com/nodejs/node/blob/v24.20.0/src/node_sqlite.cc#L943-L995),
[default configuration](https://github.com/nodejs/node/blob/v24.20.0/src/node_sqlite.h#L117-L128))

The public constructor documents `timeout` as the maximum time SQLite waits for
a database lock and defaults it to `0`. SQLite specifies that a busy timeout
less than or equal to zero disables busy handlers. Passing `{ timeout: 0 }`
therefore makes acquisition fail without an application-level waiting policy;
the proof must measure the actual elapsed fail-fast bound rather than infer a
scheduler-independent duration from the word "immediate."
([Node constructor](https://nodejs.org/download/release/v24.20.0/docs/api/sqlite.html#new-databasesyncpath-options),
[SQLite busy timeout](https://www.sqlite.org/c3ref/busy_timeout.html))

`allowExtension` defaults to `false`; when constructed false, Node documents
that extension loading cannot later be enabled. Passing it explicitly records
the security intent, even though it matches the v24.20.0 default.
([Node constructor](https://nodejs.org/download/release/v24.20.0/docs/api/sqlite.html#new-databasesyncpath-options),
[enableLoadExtension](https://nodejs.org/download/release/v24.20.0/docs/api/sqlite.html#databaseenableloadextensionallow))

When SQLite operations fail, this exact Node source throws an `Error` with
`code: "ERR_SQLITE_ERROR"`, numeric `errcode`, and textual `errstr`; it uses
`sqlite3_extended_errcode()` for the numeric value. `SQLITE_BUSY` has primary
code `5`, while extended result codes retain the primary code in their least
significant byte. These error-object fields are source observations rather than
a documented stable JavaScript API, so the executable must snapshot their exact
shape for v24.20.0 and the adapter must treat every unrecognized shape as an
unexpected failure, never as successful contention.
([Node error construction](https://github.com/nodejs/node/blob/v24.20.0/src/node_sqlite.cc#L173-L224),
[SQLite primary and extended codes](https://www.sqlite.org/rescode.html#pve),
[SQLITE_BUSY](https://www.sqlite.org/rescode.html#busy))

`database.close()` wraps `sqlite3_close_v2()`. SQLite specifies that destroying
a connection with an open transaction rolls it back. A normal release can
explicitly `ROLLBACK` and then close; the proof must show that the successor can
acquire after the close. ([Node close API](https://nodejs.org/download/release/v24.20.0/docs/api/sqlite.html#databaseclose),
[Node close source](https://github.com/nodejs/node/blob/v24.20.0/src/node_sqlite.cc#L1431-L1441),
[SQLite close](https://www.sqlite.org/c3ref/close.html))

### Stability 1.2 consequence

Node 24.20.0 labels the entire module **Stability 1.2 — Release candidate**.
Node defines 1.2 as hopefully ready for stable use with no further breaking
changes anticipated, while still allowing breaking changes in response to user
feedback or underlying specification development. This is materially weaker
than Stability 2 and prevents the permanent contract from assuming cross-pin
compatibility. ([v24.20.0 SQLite status](https://nodejs.org/download/release/v24.20.0/docs/api/sqlite.html#sqlite),
[v24.20.0 stability index](https://nodejs.org/download/release/v24.20.0/docs/api/documentation.html#stability-index))

**Inference for the contract:** qualify an exact Node binary hash, Node version,
embedded SQLite version/source ID, constructor behavior, contention error shape,
and complete lease matrix. Every bundled-Node pin change starts unqualified and
must rerun that entire gate. A missing module, changed error shape, unexpected
journal mode, wrong binary/hash/version, or any matrix failure should produce a
stable Astroix diagnostic such as `LEASE_RUNTIME_UNQUALIFIED`, including only
the expected and observed runtime versions plus the failed qualification step.
It must create no listener or write authority and must not fall back to another
Node or another lock mechanism. This diagnostic is a proposed fail-closed
policy, not something Node supplies.

## 2. Why `BEGIN IMMEDIATE` is the lease primitive

SQLite supports multiple simultaneous readers but only one simultaneous write
transaction per database. `BEGIN IMMEDIATE` starts the write transaction at
once instead of waiting for the first write statement and may itself return
`SQLITE_BUSY` when another connection already owns a write transaction. Once
`BEGIN IMMEDIATE` succeeds, SQLite guarantees that operations on that connection
through the next `COMMIT` will not later fail with `SQLITE_BUSY`.
([transactions](https://www.sqlite.org/lang_transaction.html#immediate),
[busy result](https://www.sqlite.org/rescode.html#busy))

In the default rollback-journal locking model, that write intent is represented
by the single available `RESERVED` lock. Other readers may coexist, but a second
writer cannot obtain another `RESERVED` lock and receives `SQLITE_BUSY`.
([rollback locking states](https://www.sqlite.org/lockingv3.html#locking),
[write acquisition](https://www.sqlite.org/lockingv3.html#writing))

**Inference:** each lease must use a separate, fixed file such as an internal
`registry-writer.sqlite` and `edit-writer.sqlite`. If both names shared one
database, SQLite's database-wide single writer would make them mutually
exclusive and violate the required concurrent-different-name case. The public
interface should accept only the closed name union and resolve the corresponding
file internally:

```ts
type KernelLeaseName = "registry-writer" | "edit-writer";

interface KernelLease {
  acquire(name: KernelLeaseName): KernelLeaseHold;
}

interface KernelLeaseHold {
  release(): void;
}
```

The hold owns the retained `DatabaseSync`; neither database handles, paths,
PIDs, unlinking, stale-owner reclamation, nor generic cleanup authority cross
this seam. The exact result/error union still belongs to the executable proof.

## 3. Clean release, crash release, and process lifetime

SQLite's Unix VFS uses operating-system locking (POSIX advisory locking by
default). Its own locking description says OS locks normally vanish when their
creating process exits, and its crash-recovery design treats the absence of a
`RESERVED` lock as part of recognizing a hot rollback journal. Application or
OS crashes can leave a hot journal, which the next connection rolls back before
normal access. No PID record, heartbeat, unlink, expiry, or application stale
owner algorithm participates in that protocol.
([Unix lock behavior](https://www.sqlite.org/atomiccommit.html#section_3_2),
[hot journals](https://www.sqlite.org/lockingv3.html#hot_journals))

This is also why the lease must be held by the exact authority-bearing process.
The live orphan case follows from the same rule: losing the parent or IPC
channel does not release a lock still owned by a living edit executor; process
exit does. Conversely, `SIGKILL` bypasses JavaScript cleanup, so a successful
successor after `SIGKILL` demonstrates kernel/VFS release rather than a hidden
application cleanup path. Those two conclusions are inferences from the
process-held lock model and must be demonstrated on both target operating
systems.

There is one important Unix hazard. POSIX advisory locks are process-associated;
closing another descriptor for the same file can cancel the process's locks.
SQLite coordinates its own same-process connections to work around this, but
warns against bypassing SQLite or linking independent SQLite copies. The lease
file must remain opaque: no unrelated direct open/close, replacement, rename, or
second SQLite implementation while a hold is active.
([SQLite POSIX close hazard](https://www.sqlite.org/howtocorrupt.html#posix_close_bug),
[unlink/rename hazard](https://www.sqlite.org/howtocorrupt.html#unlink))

### What the executable must measure

For each fixed lease, barrier-start distinct exact-Node processes and record
which child crossed the acquisition boundary. Exactly one must acquire and the
other must return the exact qualified contention result. Run the same barrier
with different lease names and require both holds simultaneously. Repeat after
first creation, explicit rollback/close, `SIGKILL`, and parent loss while the
edit executor remains alive. The successor after parent loss must remain
excluded until that exact executor exits. None of these timings or orchestration
outcomes is guaranteed by the documentation alone.

## 4. Rollback journal versus WAL

SQLite's default journal mode is `DELETE`, where the rollback journal is
deleted at transaction conclusion. `WAL` is persistent once selected, adds
`-wal` and `-shm` state, and still permits only one writer. WAL's benefit is
reader/writer concurrency, which a dedicated lease database does not need.
([journal modes](https://www.sqlite.org/pragma.html#pragma_journal_mode),
[WAL concurrency](https://www.sqlite.org/wal.html#concurrency))

WAL also requires all processes to be on the same host because its wal-index
uses shared memory; it does not work over network filesystems. Crash recovery
may transiently produce `SQLITE_BUSY_RECOVERY`. Rollback mode already provides
the single-writer exclusion needed here without those extra mechanisms.
([WAL disadvantages](https://www.sqlite.org/wal.html#advantages),
[WAL busy recovery](https://www.sqlite.org/rescode.html#busy_recovery))

**Inference:** do not opt into WAL. The proof should query and record
`PRAGMA journal_mode`, require `delete`, and fail closed if pre-existing or
unexpected state has changed it. This is a simplification choice, not a claim
that WAL cannot implement exclusion.

## 5. Supported and unsupported storage

SQLite depends on correct filesystem locking. It specifically warns that
network filesystems, especially NFS, may have broken or missing lock
implementations and can corrupt a database under concurrent access. SQLite's
strongest guidance is not to use database files on a network filesystem.
([filesystem locking failures](https://www.sqlite.org/howtocorrupt.html#_filesystems_with_broken_or_missing_lock_implementations),
[locking reference](https://www.sqlite.org/lockingv3.html#how_to_corrupt))

Cloud-sync software presents a separate, conservative exclusion. SQLite says a
live database's state may span the database and `-journal` or `-wal` sidecar and
warns that copying, moving, deleting, or mismatching those files can defeat
recovery. Electron also warns that some environments may back up `userData` to
cloud storage. SQLite does not publish a blanket statement naming every
Dropbox/iCloud/OneDrive configuration, so "cloud-synced paths unsupported" is an
Astroix policy inference, not a quoted SQLite guarantee.
([journal pairing](https://www.sqlite.org/howtocorrupt.html#_mispairing_database_files_and_hot_journals_),
[Electron `userData`](https://github.com/electron/electron/blob/v44.1.0/docs/api/app.md#appgetpathname))

The qualified support claim can cover only private local storage actually
tested: local APFS on macOS arm64 and the local Linux CI filesystem. NFS, SMB or
other network mounts, FUSE/virtual filesystems without certified POSIX locks,
removable media with unreliable sync, and cloud-synced or externally mirrored
directories remain unsupported. A portable proof cannot reliably recognize
every sync client or mount implementation, so configuration/packaging must
choose a known private local state path and the qualification report must name
the actual filesystem. This support boundary is an inference from SQLite's
stated dependencies.

Electron places `userData` under the per-user application-data location and
recommends an app-specific subdirectory. On macOS, the parent `appData` default
is `~/Library/Application Support`. Electron does not promise restrictive BSD
modes, so the adapter must create its lease directory as `0700` and lease files
as `0600`, then verify them in the matrix. ([Electron paths](https://github.com/electron/electron/blob/v44.1.0/docs/api/app.md#appgetpathname))

Node's documented creation defaults are `0777` for directories and `0666` for
files before the process umask. Child processes inherit the parent's umask.
`DatabaseSync` exposes no file-mode option, so the proof must control creation
(for example, a private `0700` directory plus an inherited `0077` mask) and
assert final modes; it must not assume the database constructor alone guarantees
`0600`. ([Node filesystem modes](https://nodejs.org/download/release/v24.20.0/docs/api/fs.html#fsmkdirsyncpath-options),
[Node umask](https://nodejs.org/download/release/v24.20.0/docs/api/process.html#processumaskmask))

## 6. Launching the exact packaged Node

Electron Packager's `extraResource` copies files directly to
`Contents/Resources` on macOS (and `resources` elsewhere), and identifies
`process.resourcesPath` as the packaged lookup root. Electron 44.1.0 likewise
defines `process.resourcesPath` as the resources directory. This supports the
ratified layout `Contents/Resources/node/` without PATH or shell discovery.
([Packager option](https://github.com/electron/packager/blob/v18.3.5/src/types.ts#L414-L421),
[Electron process API](https://github.com/electron/electron/blob/v44.1.0/docs/api/process.md#processresourcespath-readonly))

The package adapter should derive the fixed platform-specific executable below
that root and pass its absolute path as the `command` to `spawn()` with
`shell: false`. Node documents that `spawn(command, args, options)` executes the
given command and that `shell` defaults to false. The child must report
`process.execPath` (an absolute, symlink-resolved executable path),
`process.version`, `process.arch`, `process.platform`, embedded SQLite version,
and the lease protocol version; the parent must also verify the immutable
resource hash from the packaged manifest before granting authority.
([spawn](https://nodejs.org/download/release/v24.20.0/docs/api/child_process.html#child_processspawncommand-args-options),
[process.execPath](https://nodejs.org/download/release/v24.20.0/docs/api/process.html#processexecpath))

This excludes three superficially similar paths:

1. `process.execPath` in Electron identifies the Electron application
   executable, not the separately bundled stock Node resource.
   ([Electron process API](https://github.com/electron/electron/blob/v44.1.0/docs/api/process.md))
2. `ELECTRON_RUN_AS_NODE` makes Electron start as a Node-like process, has
   documented CLI/crypto differences because Electron uses BoringSSL, and is
   ignored when the `runAsNode` fuse is disabled. The ratified hardened package
   disables that fuse, so it cannot be the lease runtime.
   ([environment variable](https://github.com/electron/electron/blob/v44.1.0/docs/api/environment-variables.md#electron_run_as_node),
   [fuse](https://github.com/electron/electron/blob/v44.1.0/docs/tutorial/fuses.md#runasnode))
3. A bare `node`, `/usr/bin/env node`, `execPath` inherited from Electron, or
   shell startup would select something other than the manifest-pinned resource
   or depend on PATH/shell configuration. Passing the verified absolute command
   with `shell: false` supplies no such fallback.

Electron's `utilityProcess.fork()` is also not equivalent: Electron documents it
as a Chromium Services API child with Node integration, not the separately
packaged stock Node executable. It may be useful for other Electron work but
does not satisfy this proof's exact-binary premise.
([utility process](https://github.com/electron/electron/blob/v44.1.0/docs/api/utility-process.md))

### macOS signing caveat the package proof must settle

Apple says nested executable code must already be correctly signed before the
outer app is signed, and recommends signing from the innermost code outward.
Electron Packager exposes `osxSign.binaries` for additional binaries. The
bundled Node Mach-O must therefore be included in the explicit inner signing
plan before the final ad-hoc signature, and the extracted artifact must pass
recursive strict verification. ([Apple nested-code signing](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Procedures/Procedures.html#//apple_ref/doc/uid/TP40005929-CH4-SW7),
[Packager signing option](https://github.com/electron/packager/blob/v18.3.5/src/types.ts#L497-L506))

Apple also warns that executable code placed outside its standard nested-code
locations is treated as a sealed resource and may be sealed twice. The already
ratified `Contents/Resources/node/` layout is therefore not guaranteed valid by
the location guidance alone; the package-shaped proof must demonstrate that the
exact ad-hoc-signed layout launches and that `codesign --verify --deep --strict`
succeeds after ZIP extraction. Moving the binary to a different bundle location
would be a packaging-decision change, not a conclusion this research makes.
([Apple bundle placement](https://developer.apple.com/library/archive/technotes/tn2206/_index.html#//apple_ref/doc/uid/DTS40007919-CH1-TNTAG205))

Apple defines ad-hoc signing as signing with the pseudo-identity `-`; such a
signature seals code without a signing identity. This is integrity/sealing
evidence, not Developer ID identity or notarization. ([Apple ad-hoc flag](https://developer.apple.com/documentation/security/seccodesignatureflags/adhoc))

## 7. Proof boundary and decision gate

### Upstream guarantees or documented contracts

- `DatabaseSync` is synchronous, defaults to timeout zero and disabled
  extensions, and is backed by the exact SQLite copy embedded in the exact Node
  binary.
- SQLite allows one writer per database, makes `BEGIN IMMEDIATE` contend at
  transaction start, and uses OS/VFS locks rather than PID files or heartbeats.
- Default rollback-journal mode is sufficient for that one-writer primitive;
  WAL does not add multi-writer ownership.
- Electron/Packager provide a deterministic packaged resource root, and Node can
  spawn an explicit absolute executable without a shell.

### The executable proof must establish

- exact child path, hash, version, architecture, embedded SQLite version/source
  ID, journal mode, error shape, and private permissions;
- first creation under a barrier, same-name contention, different-name
  concurrency, clean release, `SIGKILL` release, and live-orphan exclusion;
- no acquisition via unlink, expiry, heartbeat, PID inspection, or stale-owner
  recovery;
- the full matrix on macOS arm64 local APFS and Linux CI's recorded local
  filesystem;
- launch from the exact final package-shaped resource layout, including
  executable bit, resource-manifest verification, ad-hoc nested signing, strict
  extracted-app signature verification, and no Electron/system/shell fallback;
- deterministic fail-closed behavior for wrong runtime, unsupported storage,
  unexpected SQLite state, and every unknown error.

Until that matrix is green, upstream evidence is enough to select
`DatabaseSync` as the **candidate**, not enough to select it as the permanent
adapter or to tell issue 203 that the lease decision is closed. If any required
case fails, issue 209's next comparison is the smallest real `flock` adapter or
signed helper; the contract must not be weakened to make SQLite pass.
