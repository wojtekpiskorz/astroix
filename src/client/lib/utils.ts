// Compatibility re-export (#218, ADR-0010): the helper moved to
// packages/app-shell; the integration chrome keeps importing this path (via
// the #lib/* alias) until the retirement gate deletes it.
export * from '../../../packages/app-shell/src/lib/utils';
