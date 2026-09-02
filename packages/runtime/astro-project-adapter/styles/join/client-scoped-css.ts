import type { DevCssSeamEntry } from '../../seam-readers';
import {
  readClientEnvironment,
  readTransformedModule,
  readViteClientCss,
} from '../../seam-readers';
import type { CompiledStyleModule } from './effective-selector-join';
import { stylesJoinRejected } from './effective-selector-join';

/**
 * The client-environment leg of the styles join (#226, ADR-0005): the
 * scoped style modules a route's dev-css set names are primed and
 * transformed in the OWNING client environment — the environment whose
 * module graph holds them — and the compiled CSS is read only through
 * the certified seams (`readClientEnvironment`, `readViteClientCss`,
 * `readTransformedModule`, #225). The route's page is transformed first
 * (the #206 implementation constraint): the scoped style modules only
 * enter the client graph as imports of the page module, so their URLs
 * are transformable there only after the page itself has been
 * transformed.
 *
 * Every module's ownership is PROVEN, not assumed (#206 private-seam
 * discipline): the node the graph holds under the module's resolved id
 * is the node it holds under the module's url, and its cached transform
 * code is the code the transform returned. A graph that does not own the
 * transformed module rejects — the compiled-CSS read path is never
 * trusted without its graph proof.
 *
 * This module is real Vite IO composition over the probed seams — its
 * truth is the real-install certification suite (`npm run
 * certify:adapter`, #225), not unit fakes at the behavior layer; the
 * unit tests here exercise the rejection paths with injected
 * stand-ins only (the CRAP coverage-tier decision, #226).
 */

const SEAM_JOIN_PAGE_PRIME =
  'vite client environment page prime (transformRequest of the route page)';
const SEAM_JOIN_STYLE_TRANSFORM =
  'vite client environment scoped style transform (transformRequest of a dev-css module url)';
const SEAM_JOIN_MODULE_IDENTITY =
  'vite client environment scoped style module identity (plugin container resolveId)';
const SEAM_JOIN_OWNERSHIP =
  'vite client environment module-graph ownership of the transformed scoped style module';

/** The query token that marks a dev-css entry as a compiled scoped `<style>` block. */
const SCOPED_STYLE_TOKEN = '?astro&type=style&index=';

/**
 * Primes the route's page in the client environment, then transforms
 * every scoped-style dev-css entry there and proves the client module
 * graph owns each transformed module. Returns the compiled modules in
 * the dev-css set's route order; the entries' `content` is never read —
 * the adapter takes route order, IDs, and URLs from the virtual CSS and
 * the selectors from the compiled output (#226).
 */
export async function transformScopedStyleModules(
  clientEnvironment: unknown,
  entries: readonly DevCssSeamEntry[],
  options: { readonly routeComponent: string },
): Promise<CompiledStyleModule[]> {
  const client = readClientEnvironment(clientEnvironment);
  const pageUrl = `/${options.routeComponent.replace(/^\/+/, '')}`;
  const pageTransform = await client.transformRequest(pageUrl);
  if (pageTransform === null) {
    throw stylesJoinRejected(
      SEAM_JOIN_PAGE_PRIME,
      `the client environment to transform the route page module`,
      'a transformRequest result of null for the route page',
    );
  }
  const compiled: CompiledStyleModule[] = [];
  for (const entry of entries) {
    if (!entry.id.includes(SCOPED_STYLE_TOKEN)) continue;
    const transformed = await client.transformRequest(entry.url);
    if (transformed === null) {
      throw stylesJoinRejected(
        SEAM_JOIN_STYLE_TRANSFORM,
        'the client environment to transform the scoped style module',
        'a transformRequest result of null for the scoped style module url',
      );
    }
    const compiledCss = readViteClientCss(transformed.code);
    const resolved = await client.pluginContainer.resolveId(entry.url);
    const resolvedId = (resolved as { id?: unknown } | null)?.id;
    if (typeof resolvedId !== 'string') {
      throw stylesJoinRejected(
        SEAM_JOIN_MODULE_IDENTITY,
        'the plugin container to resolve the scoped style module url to a module id',
        'a resolution that carries no string id for the scoped style module url',
      );
    }
    const graphModule = readTransformedModule(client.moduleGraph, resolvedId);
    const byUrl = await client.moduleGraph.getModuleByUrl(entry.url);
    if (byUrl !== graphModule.node || graphModule.code !== transformed.code) {
      throw stylesJoinRejected(
        SEAM_JOIN_OWNERSHIP,
        'the client module graph to own the transformed scoped style module (one node under both its resolved id and its url, holding the transform result code)',
        'a graph whose resolved-id node, url node, or cached transform code disagrees with the transform',
      );
    }
    compiled.push({ id: entry.id, url: entry.url, compiledCss });
  }
  return compiled;
}
