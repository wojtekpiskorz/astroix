import { register } from 'node:module';

// The desktop control-plane child's raw-Node bootstrap (#243, H1): the
// same idiom as the web host's and the #230 process lane's register —
// registers the extensionless-relative resolve hook for this process so
// the repo's bundler-resolution TypeScript modules load under raw node.
// The packaged runtime's rebased entry (H2, ADR-0008) needs none of
// this; until then this register IS the dev runtime adapter's loader
// half (the executable half is the explicit ASTROIX_DESKTOP_NODE).
register(new URL('./extensionless-ts-hook.mjs', import.meta.url));
