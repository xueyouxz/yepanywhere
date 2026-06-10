/**
 * Parent-chain ordering utilities for transcript rows.
 *
 * Terminology: each row has at most one `parentUuid` while a parent may
 * have several children, so the structure is a single-parent branching
 * forest, not a general multi-parent DAG ("dag" survives in these names
 * for historical reasons).
 *
 * Rows normally arrive in file order; these utilities repair the one race
 * we actually see — a child arriving before its parent (e.g. stream vs
 * JSONL loading) — without disturbing anything else.
 *
 * Ordering contract (deliberately conservative):
 * - An item whose parent appears LATER in the array is moved to directly
 *   after its parent, with its own dependents following.
 * - Everything else keeps its input position. In particular, items whose
 *   parent is absent from the array (hidden connector rows such as
 *   `attachment`/`system`, pagination cuts, incremental fetch windows) and
 *   items with no parentUuid at all (live stream rows) are NOT treated as
 *   evidence of misordering: relocating them to the head or tail scrambles
 *   the transcript whenever a connector row is missing client-side.
 */

/**
 * Interface for items that can be ordered by parent chain.
 * Items must have at least one of `uuid` or `id` for identification.
 */
export interface DagOrderable {
  uuid?: string;
  id?: string;
  parentUuid?: string | null;
}

/**
 * Get the canonical ID for a DagOrderable item, preferring uuid over id.
 */
function getDagId(item: DagOrderable): string {
  return item.uuid ?? item.id ?? "";
}

/**
 * Check if items need reordering: some item's parent is present in the
 * array but only at a later index. O(n) with just Set operations.
 *
 * A parent that is entirely absent from the array does NOT count — that is
 * the normal shape of pagination windows and transcripts whose connector
 * rows were never delivered, and there is no better position to move the
 * child to.
 *
 * @returns true if reordering is needed, false if already correctly ordered
 */
export function needsReorder<T extends DagOrderable>(items: T[]): boolean {
  const ids = new Set<string>();
  for (const item of items) {
    ids.add(getDagId(item));
  }
  const seen = new Set<string>();
  for (const item of items) {
    if (
      item.parentUuid &&
      ids.has(item.parentUuid) &&
      !seen.has(item.parentUuid)
    ) {
      return true;
    }
    seen.add(getDagId(item));
  }
  return false;
}

/**
 * Order items so every item whose parent is present in the array appears
 * after that parent, moving as little as possible (see the module header
 * for the full contract).
 *
 * Performance:
 * - Early bailout via needsReorder() check - O(n) with Set operations only
 * - Full reorder only when needed (race condition): O(n) single pass with
 *   per-parent deferral
 */
export function orderByParentChain<T extends DagOrderable>(items: T[]): T[] {
  if (items.length <= 1) return items;
  if (!needsReorder(items)) return items;

  const ids = new Set<string>();
  for (const item of items) {
    ids.add(getDagId(item));
  }

  const result: T[] = [];
  const emitted = new Set<string>();
  // Items deferred until their (later-positioned) parent is emitted
  const waitingByParent = new Map<string, T[]>();

  const emit = (item: T) => {
    const id = getDagId(item);
    if (id) {
      if (emitted.has(id)) return;
      emitted.add(id);
    }
    result.push(item);
    if (!id) return;
    const waiting = waitingByParent.get(id);
    if (!waiting) return;
    waitingByParent.delete(id);
    for (const dependent of waiting) {
      emit(dependent);
    }
  };

  for (const item of items) {
    const parent = item.parentUuid;
    if (parent && ids.has(parent) && !emitted.has(parent)) {
      const waiting = waitingByParent.get(parent) ?? [];
      waiting.push(item);
      waitingByParent.set(parent, waiting);
      continue;
    }
    emit(item);
  }

  // Defensive: a parentUuid cycle would strand its members in
  // waitingByParent; append them in input order rather than dropping rows.
  if (waitingByParent.size > 0) {
    for (const item of items) {
      const id = getDagId(item);
      if (id && !emitted.has(id)) {
        emit(item);
      }
    }
  }

  return result;
}
