import { register } from 'node:module';

// The #230 process-lane bootstrap: registers the extensionless-relative
// resolve hook for raw forked children. The repo's TypeScript modules
// use bundler resolution (extensionless relative imports — vitest and
// the packaged runtime resolve them); a raw `node` child does not. This
// stands in for the packaged runtime's bundler context (ADR-0008) so the
// forked test child can load the same product modules the bundler will.
register(new URL('./extensionless-ts-hook.mjs', import.meta.url));
