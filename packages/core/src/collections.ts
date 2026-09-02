/**
 * The collections payload contract (spec Impl #4 — read side): one definition
 * in core. Its retired consumers were the node REST layer (`src/node/content.ts`)
 * and the integration chrome's content client (`features/content/api.ts`);
 * bound for the protocol/runtime layers (D/E lanes), which inherit the
 * `IndexPayloadRecord` arrangement (core/matcher.ts) the index side follows.
 */

/** A single collection entry as served to the app shell (core's getCollection shape, JSON-projected). */
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
