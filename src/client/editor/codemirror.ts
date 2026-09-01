// Compatibility re-export (#218, ADR-0010): the generic editor infrastructure
// moved to packages/app-shell; the integration chrome keeps importing this
// path until the retirement gate deletes it.
export * from '../../../packages/app-shell/src/editor/codemirror';
