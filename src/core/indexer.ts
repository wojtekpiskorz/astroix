// Compatibility re-export (#212, ADR-0010): the editing-domain module moved to
// packages/core; the live integration (src/node, src/client, e2e type imports)
// keeps importing this path until the retirement gate deletes it.
export * from '../../packages/core/src/indexer';
