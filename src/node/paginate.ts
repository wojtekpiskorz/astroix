import type { IntegrationResolvedRoute, PaginateFunction } from 'astro';

/**
 * Vendored from astro@7.2.7 `dist/core/render/paginate.js`
 * (`generatePaginateFunction`) — core does not export it through the
 * `astro/runtime/*` wildcard, and `getStaticPaths` receives it as an
 * argument, so the enumeration pass must supply its own. Core semantics are
 * pinned by `paginate.test.ts`, which runs this against core's own
 * implementation over the same inputs. The one adaptation: core builds the
 * generator from `routeMatch.segments` + trailingSlash; the hook's
 * `IntegrationResolvedRoute.generate` already IS that generator closure.
 * The cast mirrors core's own (`callGetStaticPaths` casts for the same
 * reason): the public `PaginateFunction` is a user-facing generic
 * convenience our structural implementation satisfies.
 */

/** The options object `paginate(data, args)` accepts (core's `PaginateOptions`, structurally). */
interface PaginateArgs {
  pageSize?: number;
  params?: Record<string, string | undefined>;
  props?: Record<string, unknown>;
  format?: (url: string) => string;
}

export function generatePaginateFunction(route: IntegrationResolvedRoute): PaginateFunction {
  function paginateUtility(data: readonly unknown[], args: PaginateArgs = {}): unknown[] {
    const { pageSize: _pageSize, params: _params, props: _props, format: _format } = args;
    const pageSize = _pageSize || 10;
    const paramName = 'page';
    const additionalParams = _params || {};
    const additionalProps = _props || {};
    const formatUrl = _format || ((url: string) => url);
    let includesFirstPageNumber: boolean;
    if (route.params.includes(`...${paramName}`)) {
      includesFirstPageNumber = false;
    } else if (route.params.includes(`${paramName}`)) {
      includesFirstPageNumber = true;
    } else {
      throw new Error(
        `[paginate] page number param \`${paramName}\` not found. If you are using the paginate() helper, your route must include a [${paramName}] or [...${paramName}] param.`,
      );
    }
    const lastPage = Math.max(1, Math.ceil(data.length / pageSize));
    return [...Array(lastPage).keys()].map((num) => {
      const pageNum = num + 1;
      const start = pageSize === Number.POSITIVE_INFINITY ? 0 : (pageNum - 1) * pageSize;
      const end = Math.min(start + pageSize, data.length);
      const params = {
        ...additionalParams,
        [paramName]: includesFirstPageNumber || pageNum > 1 ? String(pageNum) : undefined,
      };
      const current = formatUrl(addRouteBase(route.generate({ ...params })));
      const next =
        pageNum === lastPage
          ? undefined
          : formatUrl(addRouteBase(route.generate({ ...params, page: String(pageNum + 1) })));
      const prev =
        pageNum === 1
          ? undefined
          : formatUrl(
              addRouteBase(
                route.generate({
                  ...params,
                  page:
                    !includesFirstPageNumber && pageNum - 1 === 1 ? undefined : String(pageNum - 1),
                }),
              ),
            );
      const first =
        pageNum === 1
          ? undefined
          : formatUrl(
              addRouteBase(
                route.generate({ ...params, page: includesFirstPageNumber ? '1' : undefined }),
              ),
            );
      const last =
        pageNum === lastPage
          ? undefined
          : formatUrl(addRouteBase(route.generate({ ...params, page: String(lastPage) })));
      return {
        params,
        props: {
          ...additionalProps,
          page: {
            data: data.slice(start, end),
            start,
            end: end - 1,
            size: pageSize,
            total: data.length,
            currentPage: pageNum,
            lastPage,
            url: { current, next, prev, first, last },
          },
        },
      };
    });
  }
  return paginateUtility as PaginateFunction;
}

/** Core's `joinPaths(base, path)` + empty→`/`, for the dev base we run under. */
function addRouteBase(path: string): string {
  const joined = `/${path.replace(/^\/+/, '')}`;
  return joined === '' ? '/' : joined;
}
