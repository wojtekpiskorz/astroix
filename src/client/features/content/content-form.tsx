// Compatibility re-export (#219, ADR-0010): the schema-generated form moved
// to packages/app-shell's presentation surface as a prop-driven widget —
// the advisory-validation roundtrip now arrives as `issues` props and
// flush/blurs as callbacks (the adapter hook below the pane owns the
// fetch). The integration chrome keeps importing this path until the
// retirement gate deletes it.
export * from '../../../../packages/app-shell/src/presentation/content-form';
