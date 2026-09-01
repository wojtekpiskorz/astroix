export function readAstroInternalCssUtil(moduleExports, modulePath) {
  if (typeof moduleExports?.getDevCSSModuleName !== 'function') {
    throw privateSeamError(
      `internal Astro module ${modulePath} has no getDevCSSModuleName function`,
    );
  }
  return moduleExports.getDevCSSModuleName;
}

export function readViteRuntime(moduleExports) {
  if (typeof moduleExports?.createServer !== 'function') {
    throw privateSeamError('Vite runtime has no createServer function');
  }
  if (typeof moduleExports.createServerModuleRunner !== 'function') {
    throw privateSeamError('Vite runtime has no createServerModuleRunner function');
  }
  return {
    createServer: moduleExports.createServer,
    createServerModuleRunner: moduleExports.createServerModuleRunner,
  };
}

export function readRunnerContract(runner) {
  if (typeof runner?.close !== 'function' || typeof runner.isClosed !== 'function') {
    throw privateSeamError('Vite module runner has no close and isClosed functions');
  }
  return runner;
}

export function readSsrEnvironment(environment) {
  const graph = environment?.moduleGraph;
  const pluginContainer = environment?.pluginContainer;
  const emitter = environment?.hot?.api?.outsideEmitter;
  if (
    !graph ||
    typeof graph.getModuleById !== 'function' ||
    !pluginContainer ||
    typeof pluginContainer.resolveId !== 'function'
  ) {
    throw privateSeamError('SSR environment lacks its module graph or plugin container');
  }
  if (
    !emitter ||
    typeof emitter.listenerCount !== 'function' ||
    typeof emitter.on !== 'function' ||
    typeof emitter.off !== 'function'
  ) {
    throw privateSeamError('Vite runner hot transport lacks outsideEmitter listener accounting');
  }
  return { emitter, graph, pluginContainer };
}

export function readClientEnvironment(environment) {
  if (
    !environment ||
    typeof environment.transformRequest !== 'function' ||
    typeof environment.moduleGraph?.getModuleByUrl !== 'function' ||
    typeof environment.moduleGraph.getModuleById !== 'function' ||
    typeof environment.pluginContainer?.resolveId !== 'function'
  ) {
    throw privateSeamError(
      'Vite client environment lacks transformRequest, module graph, or plugin container',
    );
  }
  return environment;
}

export function readTransformedModule(graph, id) {
  const node = graph.getModuleById(id);
  if (!node?.transformResult?.code) {
    throw privateSeamError(`Vite module graph has no transformed ${id} node`);
  }
  return { code: node.transformResult.code, node };
}

export function readRouteEntries(moduleExports) {
  if (!Array.isArray(moduleExports?.routes)) {
    throw privateSeamError('virtual:astro:routes export routes is not an array');
  }
  return moduleExports.routes.map((route, index) => {
    const data = route?.routeData;
    if (
      typeof data?.route !== 'string' ||
      typeof data.component !== 'string' ||
      typeof data.type !== 'string'
    ) {
      throw privateSeamError(
        `virtual:astro:routes route ${index} lacks string routeData.route, routeData.component, or routeData.type`,
      );
    }
    return { component: data.component, pattern: data.route, type: data.type };
  });
}

export function readDevCssEntries(moduleExports) {
  if (!(moduleExports?.css instanceof Set)) {
    throw privateSeamError('virtual:astro:dev-css export css is not a Set');
  }
  return [...moduleExports.css].map((entry, index) => {
    if (
      typeof entry?.content !== 'string' ||
      typeof entry.id !== 'string' ||
      typeof entry.url !== 'string'
    ) {
      throw privateSeamError(
        `virtual:astro:dev-css entry ${index} lacks string content, id, or url`,
      );
    }
    return { content: entry.content, id: entry.id, url: entry.url };
  });
}

export function readViteClientCss(code) {
  const match = code.match(/__vite__css = ("(?:[^"\\]|\\.)*")/);
  if (match?.[1] === undefined) {
    throw privateSeamError('Vite client CSS transform has no string __vite__css assignment');
  }
  try {
    const css = JSON.parse(match[1]);
    if (typeof css === 'string') return css;
  } catch {}
  throw privateSeamError('Vite client CSS transform has an unreadable __vite__css assignment');
}

function privateSeamError(detail) {
  return new Error(`AstroProjectAdapter private seam rejection: ${detail}`);
}
