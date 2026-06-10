import { describe, expect, it } from "vitest";
import {
  type DagOrderable,
  needsReorder,
  orderByParentChain,
} from "../src/dag.js";

describe("dag", () => {
  describe("needsReorder", () => {
    it("returns false for empty array", () => {
      expect(needsReorder([])).toBe(false);
    });

    it("returns false for single item", () => {
      expect(needsReorder([{ id: "a", parentUuid: null }])).toBe(false);
    });

    it("returns false when items are in correct order", () => {
      const items: DagOrderable[] = [
        { id: "a", parentUuid: null },
        { id: "b", parentUuid: "a" },
        { id: "c", parentUuid: "b" },
      ];
      expect(needsReorder(items)).toBe(false);
    });

    it("returns true when parent comes after child", () => {
      const items: DagOrderable[] = [
        { id: "b", parentUuid: "a" }, // parent "a" not seen yet
        { id: "a", parentUuid: null },
      ];
      expect(needsReorder(items)).toBe(true);
    });

    it("returns true when items are in reverse order", () => {
      const items: DagOrderable[] = [
        { id: "c", parentUuid: "b" },
        { id: "b", parentUuid: "a" },
        { id: "a", parentUuid: null },
      ];
      expect(needsReorder(items)).toBe(true);
    });

    it("handles items without parentUuid as roots", () => {
      const items: DagOrderable[] = [
        { id: "a" }, // no parentUuid = root
        { id: "b", parentUuid: "a" },
      ];
      expect(needsReorder(items)).toBe(false);
    });

    it("handles undefined parentUuid as root", () => {
      const items: DagOrderable[] = [
        { id: "a", parentUuid: undefined },
        { id: "b", parentUuid: "a" },
      ];
      expect(needsReorder(items)).toBe(false);
    });

    it("returns false when a parent is absent from the array entirely", () => {
      // Normal shape of pagination windows and transcripts whose hidden
      // connector rows (attachment/system) were never delivered.
      const items: DagOrderable[] = [
        { id: "b", parentUuid: "not-in-array" },
        { id: "c", parentUuid: "b" },
      ];
      expect(needsReorder(items)).toBe(false);
    });
  });

  describe("orderByParentChain", () => {
    it("returns empty array unchanged", () => {
      expect(orderByParentChain([])).toEqual([]);
    });

    it("returns single item unchanged", () => {
      const items = [{ id: "a", parentUuid: null }];
      expect(orderByParentChain(items)).toEqual(items);
    });

    it("returns already-ordered items unchanged (same reference)", () => {
      const items: DagOrderable[] = [
        { id: "a", parentUuid: null },
        { id: "b", parentUuid: "a" },
        { id: "c", parentUuid: "b" },
      ];
      // Should return same array reference when no reorder needed
      expect(orderByParentChain(items)).toBe(items);
    });

    it("reorders when parent comes after child", () => {
      const items: DagOrderable[] = [
        { id: "b", parentUuid: "a" },
        { id: "a", parentUuid: null },
      ];
      const result = orderByParentChain(items);
      expect(result.map((i) => i.id)).toEqual(["a", "b"]);
    });

    it("reorders chain from reverse order", () => {
      const items: DagOrderable[] = [
        { id: "c", parentUuid: "b" },
        { id: "b", parentUuid: "a" },
        { id: "a", parentUuid: null },
      ];
      const result = orderByParentChain(items);
      expect(result.map((i) => i.id)).toEqual(["a", "b", "c"]);
    });

    it("handles race condition: agent response before user message", () => {
      // This is the exact race condition we're fixing
      const items: DagOrderable[] = [
        { id: "agent-1", parentUuid: "user-1" }, // agent response arrived first
        { id: "user-1", parentUuid: null }, // user message arrived second
      ];
      const result = orderByParentChain(items);
      expect(result.map((i) => i.id)).toEqual(["user-1", "agent-1"]);
    });

    it("handles longer race condition scenario", () => {
      // Multi-turn conversation with out-of-order arrival
      const items: DagOrderable[] = [
        { id: "agent-2", parentUuid: "user-2" },
        { id: "user-2", parentUuid: "agent-1" },
        { id: "agent-1", parentUuid: "user-1" },
        { id: "user-1", parentUuid: null },
      ];
      const result = orderByParentChain(items);
      expect(result.map((i) => i.id)).toEqual([
        "user-1",
        "agent-1",
        "user-2",
        "agent-2",
      ]);
    });

    it("keeps items with missing parents in place", () => {
      // A parent absent from the array gives no better position to move
      // the child to; input position is the best available evidence.
      const items: DagOrderable[] = [
        { id: "a", parentUuid: null },
        { id: "orphan", parentUuid: "missing-parent" }, // parent doesn't exist
        { id: "b", parentUuid: "a" },
      ];
      const result = orderByParentChain(items);
      expect(result.map((i) => i.id)).toEqual(["a", "orphan", "b"]);
    });

    it("moves only the out-of-order item, not disconnected segments", () => {
      const items: DagOrderable[] = [
        // Segment whose parent chain starts at a row absent from the array
        { id: "s1", parentUuid: "missing-connector" },
        { id: "s2", parentUuid: "s1" },
        // Out-of-order pair: child before parent
        { id: "late-child", parentUuid: "late-parent" },
        { id: "late-parent", parentUuid: "s2" },
        // Trailing row already in order
        { id: "tail", parentUuid: "late-child" },
      ];
      const result = orderByParentChain(items);
      expect(result.map((i) => i.id)).toEqual([
        "s1",
        "s2",
        "late-parent",
        "late-child",
        "tail",
      ]);
    });

    it("does not scramble a transcript with hidden connector rows and stream-only rows (task 024 shape)", () => {
      // Modeled on a real Claude session: every assistant turn chains
      // through an `attachment` connector row, a system/api_error row is a
      // fork point, and live stream rows arrive without parentUuid. If the
      // connector rows are missing client-side and one streamed row never
      // received its JSONL parentUuid, the old root-walk reorder pulled the
      // live tail to the front and dumped the dead branch at the bottom.
      const items: DagOrderable[] = [
        // Tail window: first row's parent predates the window
        { id: "u183", parentUuid: "a180-outside-window" },
        // Dead branch; parent att184 (attachment row) absent from array
        { id: "a185", parentUuid: "att184" },
        { id: "a198", parentUuid: "a185" },
        // Live branch via system/api_error row, also absent
        { id: "u202", parentUuid: "sys201" },
        // Streamed row: real uuid, never got parentUuid from JSONL
        { id: "a203" },
        // Later JSONL rows chain through the streamed row
        { id: "a204", parentUuid: "a203" },
        { id: "a205", parentUuid: "a204" },
      ];
      const result = orderByParentChain(items);
      // Nothing is out of order (no present parent appears after its
      // child), so input order must be preserved exactly.
      expect(result.map((i) => i.id)).toEqual([
        "u183",
        "a185",
        "a198",
        "u202",
        "a203",
        "a204",
        "a205",
      ]);
    });

    it("recovers from a parentUuid cycle without dropping rows", () => {
      const items: DagOrderable[] = [
        { id: "a", parentUuid: null },
        { id: "x", parentUuid: "y" },
        { id: "y", parentUuid: "x" },
      ];
      const result = orderByParentChain(items);
      expect(result.map((i) => i.id).sort()).toEqual(["a", "x", "y"]);
      expect(result[0]?.id).toBe("a");
    });

    it("handles items without parentUuid field as roots", () => {
      const items: DagOrderable[] = [
        { id: "b", parentUuid: "a" },
        { id: "a" }, // no parentUuid field = root
      ];
      const result = orderByParentChain(items);
      expect(result.map((i) => i.id)).toEqual(["a", "b"]);
    });

    it("handles multiple roots (branches)", () => {
      const items: DagOrderable[] = [
        { id: "b1", parentUuid: "a1" },
        { id: "a1", parentUuid: null },
        { id: "b2", parentUuid: "a2" },
        { id: "a2", parentUuid: null },
      ];
      const result = orderByParentChain(items);
      // Both branches should be traversed, order depends on input order
      expect(result.length).toBe(4);
      // a1 should come before b1, a2 should come before b2
      const ids = result.map((i) => i.id);
      expect(ids.indexOf("a1")).toBeLessThan(ids.indexOf("b1"));
      expect(ids.indexOf("a2")).toBeLessThan(ids.indexOf("b2"));
    });

    it("preserves extra properties on items", () => {
      interface ExtendedItem extends DagOrderable {
        type: string;
        content: string;
      }
      const items: ExtendedItem[] = [
        { id: "b", parentUuid: "a", type: "assistant", content: "Hello" },
        { id: "a", parentUuid: null, type: "user", content: "Hi" },
      ];
      const result = orderByParentChain(items);
      expect(result[0]).toEqual({
        id: "a",
        parentUuid: null,
        type: "user",
        content: "Hi",
      });
      expect(result[1]).toEqual({
        id: "b",
        parentUuid: "a",
        type: "assistant",
        content: "Hello",
      });
    });
  });
});
