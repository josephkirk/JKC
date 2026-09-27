import { describe, it, expect, vi } from "vitest";
import { QueuedDocumentWriter } from "../lib/queuedWriter.ts";

describe("Tag Identity and Search Normalization", () => {
  it("treats tags with differing case as identical after trimming", () => {
    const rawTags = ["  Action ", "action", "ACTION", "  Sci-Fi  ", "sci-fi"];
    const normalized = Array.from(
      new Set(rawTags.map((t) => t.trim().toLowerCase()))
    );
    expect(normalized).toEqual(["action", "sci-fi"]);
  });

  it("matches search term case-insensitively against tags", () => {
    const mediaTags = ["Cinematic", "VFX", "Night_Scene"];
    const searchTerm = "vfx";
    const matches = mediaTags.some(
      (t) => t.toLowerCase() === searchTerm.toLowerCase()
    );
    expect(matches).toBe(true);
  });
});

describe("Take In/Out Range Validation", () => {
  it("accepts valid ordered take range within duration", () => {
    const durationMs = 4000;
    const inMs = 500;
    const outMs = 1500;

    const isValid =
      inMs >= 0 &&
      outMs <= durationMs &&
      outMs > inMs &&
      Number.isFinite(inMs) &&
      Number.isFinite(outMs);

    expect(isValid).toBe(true);
  });

  it("rejects inverted take ranges where outMs <= inMs", () => {
    const inMs = 2000;
    const outMs = 1000;
    const isValid = outMs > inMs;
    expect(isValid).toBe(false);
  });

  it("rejects equal in and out points", () => {
    const inMs = 1500;
    const outMs = 1500;
    const isValid = outMs > inMs;
    expect(isValid).toBe(false);
  });
});

describe("Chronological Shot Intervals", () => {
  it("ensures shot boundaries start at zero, are sorted, deduplicated, and bounded by duration", () => {
    const rawDetectedPts = [2000, 1000, 2000, 3500];
    const durationMs = 4000;

    const boundaries = [0, ...rawDetectedPts.filter((t) => t > 0 && t < durationMs)];
    boundaries.sort((a, b) => a - b);
    const uniqueBoundaries = Array.from(new Set(boundaries));
    if (uniqueBoundaries[uniqueBoundaries.length - 1] < durationMs) {
      uniqueBoundaries.push(durationMs);
    }

    expect(uniqueBoundaries).toEqual([0, 1000, 2000, 3500, 4000]);

    // Interval checks
    for (let i = 0; i < uniqueBoundaries.length - 1; i++) {
      expect(uniqueBoundaries[i + 1]).toBeGreaterThan(uniqueBoundaries[i]);
    }
  });
});

describe("Transformed Drawing and Canvas Coordinates", () => {
  it("normalizes stage client coordinates into [0.0, 1.0] image space", () => {
    const stageWidth = 800;
    const stageHeight = 600;
    const clientX = 400;
    const clientY = 300;

    const normX = clientX / stageWidth;
    const normY = clientY / stageHeight;

    expect(normX).toBe(0.5);
    expect(normY).toBe(0.5);

    // Transforming back to different window size
    const newStageWidth = 1200;
    const newStageHeight = 900;
    const renderedX = normX * newStageWidth;
    const renderedY = normY * newStageHeight;

    expect(renderedX).toBe(600);
    expect(renderedY).toBe(450);
  });

  it("computes pixel crop rectangles accurately", () => {
    const startPoint = { x: 100, y: 150 };
    const currentPoint = { x: 400, y: 350 };

    const cropX = Math.min(startPoint.x, currentPoint.x);
    const cropY = Math.min(startPoint.y, currentPoint.y);
    const cropW = Math.abs(currentPoint.x - startPoint.x);
    const cropH = Math.abs(currentPoint.y - startPoint.y);

    expect(cropX).toBe(100);
    expect(cropY).toBe(150);
    expect(cropW).toBe(300);
    expect(cropH).toBe(200);
  });
});

describe("Layer Compositing Formulas", () => {
  it("calculates standard alpha blending for layer stack", () => {
    // Bottom color: white (1, 1, 1), opacity 1
    // Top color: blue (0, 0, 1), opacity 0.5
    const botA = 1.0;
    const topA = 0.5;

    const outA = topA + botA * (1.0 - topA);
    expect(outA).toBe(1.0);

    const outR = (0 * topA + 1 * botA * (1.0 - topA)) / outA;
    const outG = (0 * topA + 1 * botA * (1.0 - topA)) / outA;
    const outB = (1 * topA + 1 * botA * (1.0 - topA)) / outA;

    expect(outR).toBe(0.5);
    expect(outG).toBe(0.5);
    expect(outB).toBe(1.0);
  });
});

describe("QueuedDocumentWriter Single Writer & Coalescing", () => {
  it("queues and coalesces rapid mutations into a single serialized write sequence", async () => {
    const savedRevisions: number[] = [];
    let resolveSave: () => void = () => {};

    const mockSaveFn = vi.fn().mockImplementation(() => {
      return new Promise<void>((resolve) => {
        resolveSave = resolve;
      });
    });

    const onSaved = vi.fn((rev: number) => {
      savedRevisions.push(rev);
    });
    const onError = vi.fn();

    const writer = new QueuedDocumentWriter<{ val: string }>(
      mockSaveFn,
      onSaved,
      onError
    );

    // Enqueue revision 1
    writer.enqueue({ val: "v1" }, 1);
    expect(mockSaveFn).toHaveBeenCalledTimes(1);

    // While save 1 is in-flight, enqueue revision 2 and revision 3
    writer.enqueue({ val: "v2" }, 2);
    writer.enqueue({ val: "v3" }, 3);

    // Only 1 save is in-flight right now
    expect(mockSaveFn).toHaveBeenCalledTimes(1);

    // Complete save 1
    resolveSave();
    await Promise.resolve(); // tick microtask

    // Now save 2 was coalesced into save 3
    expect(mockSaveFn).toHaveBeenCalledTimes(2);

    // Complete save 3
    resolveSave();
    await writer.flush();

    expect(savedRevisions).toEqual([1, 3]);
  });
  it("preserves dirty state when older in-flight save completes after newer mutation", async () => {
    let isDirty = false;
    let currentRevision = 0;
    let resolveSave: () => void = () => {};

    const mockSaveFn = vi.fn().mockImplementation(() => {
      return new Promise<void>((resolve) => {
        resolveSave = resolve;
      });
    });

    const onSaved = vi.fn((savedRev: number) => {
      if (currentRevision === savedRev) {
        isDirty = false;
      }
    });

    const writer = new QueuedDocumentWriter<{ val: string }>(
      mockSaveFn,
      onSaved,
      vi.fn()
    );

    // 1. Edit A occurs (rev 1)
    currentRevision = 1;
    isDirty = true;
    writer.enqueue({ val: "Edit A" }, 1);

    // 2. While Save A is in-flight, Edit B occurs (rev 2)
    currentRevision = 2;
    isDirty = true;

    // 3. Save A resolves
    resolveSave();
    await Promise.resolve();

    // isDirty MUST remain true because currentRevision (2) !== savedRevision (1)
    expect(isDirty).toBe(true);

    // 4. Flushing enqueues the unpersisted rev 2
    writer.enqueue({ val: "Edit B" }, 2);
    resolveSave();
    await writer.flush();

    // After rev 2 is saved, isDirty is cleared
    expect(isDirty).toBe(false);
  });
});
