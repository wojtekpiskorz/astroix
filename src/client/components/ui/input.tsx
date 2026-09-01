// Compatibility re-export (#218, ADR-0010): the generated primitive moved to
// packages/app-shell; the integration chrome keeps importing this path (via
// the #components/* alias) until the retirement gate deletes it.
export * from '../../../../packages/app-shell/src/components/ui/input';
