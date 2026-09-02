// Compatibility re-export (#219, ADR-0010): the schema-tree field renderer
// moved to packages/app-shell's presentation surface; the integration
// chrome keeps importing this path until the retirement gate deletes it.
export * from '../../../../packages/app-shell/src/presentation/schema-field';
