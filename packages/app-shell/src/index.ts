/**
 * @wojciechpiskorz/astroix-app-shell — the retained renderer UI foundation
 * (#218, ADR-0002/ADR-0010): generic UI/editor contracts only. The public
 * surface is the shadcn/Base UI primitive set, the `cn` helper, the mobile
 * breakpoint hook, and the generic CodeMirror infrastructure (view
 * construction + the markdown editor and its toolbar). It deliberately
 * exports no CSS, content, route, or project-domain APIs — the theme
 * entry (`src/chrome.css`) has no consumer today (the Electron renderer
 * adopts it through its own stylesheet construction when it lands, G/H
 * lanes), never through this barrel.
 */
export * from './components/ui/button';
export * from './components/ui/checkbox';
export * from './components/ui/dialog';
export * from './components/ui/field';
export * from './components/ui/input';
export * from './components/ui/label';
export * from './components/ui/select';
export * from './components/ui/separator';
export * from './components/ui/sheet';
export * from './components/ui/sidebar';
export * from './components/ui/skeleton';
export * from './components/ui/tabs';
export * from './components/ui/textarea';
export * from './components/ui/tooltip';
export * from './editor/codemirror';
export * from './editor/markdown-editor';
export * from './editor/markdown-toolbar';
export * from './hooks/use-mobile';
export * from './lib/utils';
