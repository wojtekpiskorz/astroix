export function normalizePayload(payload) {
  return payload
    .map((record) => ({
      effectiveSelector:
        typeof record.effectiveSelector === 'string'
          ? normalizeScope(record.effectiveSelector)
          : null,
      file: record.file,
      line: record.line,
      media: record.media,
      range: { end: record.range.end, start: record.range.start },
      scoped: record.scoped,
      selector: record.selector,
      styleBlockIndex: record.styleBlockIndex,
    }))
    .sort((left, right) =>
      left.file === right.file
        ? left.range.start - right.range.start
        : left.file < right.file
          ? -1
          : 1,
    );
}

function normalizeScope(selector) {
  return selector
    .replaceAll(/data-astro-cid-[a-z0-9]+/g, 'data-astro-cid-<scope>')
    .replaceAll(/\.astro-[a-z0-9]+/g, '.astro-<scope>');
}
