import { register } from 'node:module';

// The web host's raw-Node bootstrap (#240): registers the
// extensionless-relative resolve hook for this process — the repo's
// TypeScript modules use bundler resolution (extensionless relative
// imports; vitest and the packaged runtime resolve them), a raw `node`
// process does not. The same idiom as the #230 process lane's register,
// which this stands in for until the packaged runtime's bundler context
// exists (ADR-0008). The spawned project-plane worker child receives
// the same register through its execArgv (plane-launch's documented
// dev-checkout seam).
register(new URL('./extensionless-ts-hook.mjs', import.meta.url));
