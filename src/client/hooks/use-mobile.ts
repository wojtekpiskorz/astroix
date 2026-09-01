// Compatibility re-export (#218, ADR-0010): the hook moved with the generated
// ui set it serves (components.json `hooks` alias); the integration chrome
// keeps importing this path until the retirement gate deletes it.
export * from '../../../packages/app-shell/src/hooks/use-mobile';
