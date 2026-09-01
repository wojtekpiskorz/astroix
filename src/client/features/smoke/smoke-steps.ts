/** One manual-smoke step: what the owner does and where to look. */
export interface SmokeStep {
  id: string;
  title: string;
  detail: string;
  /** Which chrome/page surface the owner should be looking at. */
  surface: string;
}

// Retired in place: the integration-era manual-smoke wizard's step list. The
// doc-mirror contract and its e2e enforcement are gone (#262 owner ruling);
// the feature itself is deleted with the legacy integration (#215/A6).
// `as const satisfies` narrows the ids to a real union (StepId) so the store
// can key by them — an unknown step id is a compile error there.
export const SMOKE_STEPS = [
  {
    id: '1',
    title: 'One command boots everything',
    detail: 'bun run smoke installs root + fixture, builds and boots the dev server on :4312.',
    surface: 'terminal',
  },
  {
    id: '2',
    title: 'Chrome appears over the live page',
    detail:
      'Open http://localhost:4312/ — the chrome shows up default-on, the canvas renders the live page.',
    surface: 'chrome',
  },
  {
    id: '3',
    title: 'Select mode: hover + click the hero title',
    detail: 'Enable Select, hover h1.hero-title — an outline appears — click to select it.',
    surface: 'header + canvas',
  },
  {
    id: '4',
    title: 'Rule list shows both sources, winner marked',
    detail:
      'Scoped rule (.astro file+line, cid hash hidden) + global (home.css, line), specificity-sorted, winner starred, @media badge present.',
    surface: 'sidebar',
  },
  {
    id: '5',
    title: 'Winner click opens CodeMirror at the range',
    detail:
      'The file opens highlighted at the rule; multi-place ranges are reachable as annotations.',
    surface: 'editor',
  },
  {
    id: '6',
    title: 'Raw-text color edit lands on disk + HMR',
    detail:
      'Change color in the editor — ~300 ms later git diff shows one line and the canvas shows the new color.',
    surface: 'editor + canvas',
  },
  {
    id: '6b',
    title: 'IDE edit race: live reload, write refused',
    detail:
      'With the editor still open, edit the same file in the IDE and save — the chrome editor updates live; a racing chrome write is refused ("changed on disk — reloaded").',
    surface: 'editor',
  },
  {
    id: '7',
    title: '?builder=0 gives a clean page',
    detail: 'Append ?builder=0 to the top-level URL — clean page, no chrome.',
    surface: 'url bar',
  },
] as const satisfies readonly SmokeStep[];

export type StepId = (typeof SMOKE_STEPS)[number]['id'];
/** A step value with its id narrowed to the StepId union. */
export type SmokeStepItem = (typeof SMOKE_STEPS)[number];
