/**
 * The collections payload contract (spec Impl #4 — read side): one definition
 * in core, consumed by the node REST layer (`src/node/content.ts`), the chrome
 * (`features/content/api.ts`) and the e2e specs — the `IndexPayloadRecord`
 * arrangement (core/matcher.ts), which the index side already follows.
 */

/** A single collection entry as served to the chrome (core's getCollection shape, JSON-projected). */
export interface CollectionEntryRecord {
  /** Slugified source path (glob loader id), e.g. `2024/post`. */
  id: string;
  /** Root-relative posix source path, or null for store entries without one. */
  filePath: string | null;
  /** Parsed frontmatter (zod output). */
  data: unknown;
  /** Raw markdown body, or null for data-only entries. */
  body: string | null;
}

/** A collection with its entries and schema presence (spec Impl #4 — read side). */
export interface CollectionRecord {
  name: string;
  hasSchema: boolean;
  entries: CollectionEntryRecord[];
}
