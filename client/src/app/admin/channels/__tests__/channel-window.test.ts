import { computeWindow, rowOffset, scrollOffsetForRow } from '../channel-window';

const ROW = 48;
const VIEWPORT = 600;

const base = {
    rowHeight: ROW,
    viewportHeight: VIEWPORT,
    buffer: 6
};

describe('computeWindow', () => {
    it('renders from the top when not scrolled', () => {
        const result = computeWindow({ ...base, totalRows: 2000, scrollTop: 0 });
        expect(result.startIndex).toBe(0);
        expect(result.paddingTop).toBe(0);
        expect(result.endIndex).toBeGreaterThan(12);
    });

    it('reserves the full height of the list, so the scrollbar is honest', () => {
        const result = computeWindow({ ...base, totalRows: 2000, scrollTop: 0 });
        expect(result.totalHeight).toBe(2000 * ROW);
        expect(result.paddingTop + (result.endIndex - result.startIndex) * ROW + result.paddingBottom)
            .toBe(result.totalHeight);
    });

    it('reaches the last channel of two thousand — the point of the slice', () => {
        const totalRows = 2000;
        const result = computeWindow({
            ...base,
            totalRows,
            scrollTop: totalRows * ROW // clamped to the bottom
        });
        expect(result.endIndex).toBe(totalRows);
        expect(result.paddingBottom).toBe(0);
    });

    it('every row is reachable by some scroll position', () => {
        const totalRows = 2000;
        const seen = new Set<number>();
        for (let scrollTop = 0; scrollTop <= totalRows * ROW; scrollTop += VIEWPORT / 2) {
            const w = computeWindow({ ...base, totalRows, scrollTop });
            for (let i = w.startIndex; i < w.endIndex; i++) seen.add(i);
        }
        expect(seen.size).toBe(totalRows);
    });

    it('windows around the scroll position rather than from the start', () => {
        const result = computeWindow({ ...base, totalRows: 2000, scrollTop: 1000 * ROW });
        expect(result.startIndex).toBe(1000 - 6);
        expect(result.paddingTop).toBe((1000 - 6) * ROW);
    });

    it('keeps the rendered set small regardless of list size', () => {
        const small = computeWindow({ ...base, totalRows: 100, scrollTop: 0 });
        const huge = computeWindow({ ...base, totalRows: 50_000, scrollTop: 0 });
        expect(huge.endIndex - huge.startIndex).toBe(small.endIndex - small.startIndex);
        expect(huge.endIndex - huge.startIndex).toBeLessThan(40);
    });

    it('handles an empty list', () => {
        expect(computeWindow({ ...base, totalRows: 0, scrollTop: 0 })).toEqual({
            startIndex: 0, endIndex: 0, paddingTop: 0, paddingBottom: 0, totalHeight: 0
        });
    });

    it('handles a list shorter than the viewport', () => {
        const result = computeWindow({ ...base, totalRows: 3, scrollTop: 0 });
        expect(result.startIndex).toBe(0);
        expect(result.endIndex).toBe(3);
        expect(result.paddingBottom).toBe(0);
    });

    it('ignores a negative or overscrolled position', () => {
        expect(computeWindow({ ...base, totalRows: 100, scrollTop: -500 }).startIndex).toBe(0);
        const over = computeWindow({ ...base, totalRows: 100, scrollTop: 999_999 });
        expect(over.endIndex).toBe(100);
    });
});

describe('an expanded row', () => {
    const EXTRA = 260;

    it('adds its height to the total', () => {
        const result = computeWindow({
            ...base, totalRows: 500, scrollTop: 0, expandedIndex: 10, expandedExtraHeight: EXTRA
        });
        expect(result.totalHeight).toBe(500 * ROW + EXTRA);
    });

    it('does not shift rows above it', () => {
        expect(rowOffset(5, ROW, 10, EXTRA)).toBe(5 * ROW);
    });

    it('pushes rows below it down by exactly its extra height', () => {
        expect(rowOffset(11, ROW, 10, EXTRA)).toBe(11 * ROW + EXTRA);
    });

    it('keeps padding consistent with the rendered rows', () => {
        const result = computeWindow({
            ...base, totalRows: 500, scrollTop: 40 * ROW, expandedIndex: 10, expandedExtraHeight: EXTRA
        });
        const renderedHeight = (result.endIndex - result.startIndex) * ROW
            + (result.startIndex <= 10 && 10 < result.endIndex ? EXTRA : 0);
        expect(result.paddingTop + renderedHeight + result.paddingBottom).toBe(result.totalHeight);
    });

    it('still lands on the right row when scrolled past the expansion', () => {
        const scrollTop = 100 * ROW + EXTRA;
        const result = computeWindow({
            ...base, totalRows: 500, scrollTop, expandedIndex: 10, expandedExtraHeight: EXTRA
        });
        expect(result.startIndex).toBe(100 - 6);
    });

    it('resolves a position inside the expanded row to that row', () => {
        const scrollTop = 10 * ROW + EXTRA / 2;
        const result = computeWindow({
            ...base, totalRows: 500, scrollTop, expandedIndex: 10, expandedExtraHeight: EXTRA, buffer: 0
        });
        expect(result.startIndex).toBeLessThanOrEqual(10);
        expect(result.endIndex).toBeGreaterThan(10);
    });

    it('behaves like an unexpanded list when nothing is expanded', () => {
        const collapsed = computeWindow({ ...base, totalRows: 500, scrollTop: 300, expandedIndex: null });
        const plain = computeWindow({ ...base, totalRows: 500, scrollTop: 300 });
        expect(collapsed).toEqual(plain);
    });

    it('ignores a zero extra height', () => {
        const zero = computeWindow({
            ...base, totalRows: 500, scrollTop: 300, expandedIndex: 3, expandedExtraHeight: 0
        });
        expect(zero.totalHeight).toBe(500 * ROW);
    });
});

describe('scrollOffsetForRow', () => {
    it('returns the top of the row', () => {
        expect(scrollOffsetForRow(20, ROW, null, 0)).toBe(20 * ROW);
    });

    it('accounts for an expansion above it', () => {
        expect(scrollOffsetForRow(20, ROW, 5, 200)).toBe(20 * ROW + 200);
    });

    it('never goes negative', () => {
        expect(scrollOffsetForRow(-3, ROW, null, 0)).toBe(0);
    });
});
