/**
 * Windowing maths for the channel list.
 *
 * The list rendered `filteredChannels.slice(0, 500)`, so beyond 500 channels the
 * rest simply did not exist as far as the UI was concerned — no paging, no
 * scrolling to them, just a note saying some were hidden. This computes which
 * rows to render for a given scroll position instead.
 *
 * The wrinkle is that one row can be expanded and is then much taller than the
 * others, which shifts everything below it. Kept pure so that offset arithmetic
 * can be tested rather than eyeballed.
 */

export interface WindowInput {
    totalRows: number;
    rowHeight: number;
    scrollTop: number;
    viewportHeight: number;
    /** Rows rendered beyond the viewport on each side, to hide scroll tearing. */
    buffer?: number;
    /** Index of the expanded row within the filtered list, if any. */
    expandedIndex?: number | null;
    /** Extra height the expanded row adds on top of a normal row. */
    expandedExtraHeight?: number;
}

export interface WindowResult {
    startIndex: number;
    /** Exclusive. */
    endIndex: number;
    paddingTop: number;
    paddingBottom: number;
    totalHeight: number;
}

/** Pixel offset of the top of a row, accounting for an expanded row above it. */
export function rowOffset(
    index: number,
    rowHeight: number,
    expandedIndex: number | null | undefined,
    expandedExtraHeight: number
): number {
    const base = index * rowHeight;
    const expandedAbove = expandedIndex !== null && expandedIndex !== undefined && index > expandedIndex;
    return base + (expandedAbove ? expandedExtraHeight : 0);
}

export function computeWindow(input: WindowInput): WindowResult {
    const rowHeight = Math.max(1, input.rowHeight);
    const totalRows = Math.max(0, input.totalRows);
    const buffer = Math.max(0, input.buffer ?? 6);
    const extra = input.expandedIndex === null || input.expandedIndex === undefined
        ? 0
        : Math.max(0, input.expandedExtraHeight ?? 0);
    const expandedIndex = extra > 0 ? input.expandedIndex! : null;

    const totalHeight = totalRows * rowHeight + extra;

    if (totalRows === 0) {
        return { startIndex: 0, endIndex: 0, paddingTop: 0, paddingBottom: 0, totalHeight: 0 };
    }

    const scrollTop = Math.min(Math.max(0, input.scrollTop), Math.max(0, totalHeight - 1));

    // Invert rowOffset: above the expanded row the mapping is linear, below it
    // everything has been pushed down by the expansion.
    let rawIndex: number;
    if (expandedIndex === null || scrollTop <= (expandedIndex + 1) * rowHeight) {
        rawIndex = Math.floor(scrollTop / rowHeight);
    } else {
        rawIndex = Math.floor((scrollTop - extra) / rowHeight);
        // Anything inside the expanded row's own band resolves to that row.
        if (rawIndex < expandedIndex) rawIndex = expandedIndex;
    }

    const startIndex = Math.max(0, Math.min(totalRows - 1, rawIndex) - buffer);

    const visibleRows = Math.ceil(Math.max(0, input.viewportHeight) / rowHeight) + buffer * 2 + 1;
    const endIndex = Math.min(totalRows, startIndex + visibleRows);

    const paddingTop = rowOffset(startIndex, rowHeight, expandedIndex, extra);
    const paddingBottom = Math.max(0, totalHeight - rowOffset(endIndex, rowHeight, expandedIndex, extra));

    return { startIndex, endIndex, paddingTop, paddingBottom, totalHeight };
}

/**
 * Scroll offset that brings a row into view — used after filtering so the
 * expanded row is not left somewhere off-screen.
 */
export function scrollOffsetForRow(
    index: number,
    rowHeight: number,
    expandedIndex: number | null,
    expandedExtraHeight: number
): number {
    return Math.max(0, rowOffset(index, rowHeight, expandedIndex, expandedExtraHeight));
}
