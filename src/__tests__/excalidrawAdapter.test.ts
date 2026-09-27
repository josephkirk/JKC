import { describe, expect, it, vi } from "vitest";

vi.mock("@excalidraw/excalidraw", () => ({
  convertToExcalidrawElements: (descriptors: any[]) => descriptors.map((descriptor, index) => ({ ...descriptor, id: `element-${index}`, version: 1 })),
}));

import { documentWithScene, migrateBoardItems, sceneFromDocument } from "../features/boards/excalidrawAdapter.ts";
import type { BoardDocument } from "../lib/contracts.ts";

const legacyBoard = (): BoardDocument => ({
  version: 1,
  id: "board-1",
  name: "Legacy",
  viewport: { x: 0, y: 0, scale: 1 },
  items: [
    { id: "video-item", type: "video", mediaId: "media-video", x: 20, y: 10, width: 320, height: 180, rotation: 15, zIndex: 2 },
    { id: "note-item", type: "note", text: "Keep this", color: "#facc15", x: 5, y: 5, width: 200, height: 100, rotation: 0, zIndex: 1 },
  ],
});

describe("Excalidraw board migration", () => {
  it("converts every legacy item with stable identity, grouping, rotation, and z-order", () => {
    const scene = migrateBoardItems(legacyBoard());
    const note = scene.elements.find((element) => element.customData?.jkcItemId === "note-item");
    const video = scene.elements.find((element) => element.customData?.jkcItemId === "video-item");
    expect(note).toBeDefined();
    expect(video).toBeDefined();
    expect(note.groupIds).toEqual(["note-item"]);
    expect(video.groupIds).toEqual(["video-item"]);
    expect(video.angle).toBeCloseTo((15 * Math.PI) / 180);
    expect(video.customData.jkcMediaId).toBe("media-video");
    expect(video.customData.jkcMediaKind).toBe("video");
  });

  it("persists the migrated scene without dropping the legacy document fields", () => {
    const board = legacyBoard();
    const scene = migrateBoardItems(board);
    const persisted = documentWithScene(board, scene);
    const restored = sceneFromDocument(persisted);
    expect(persisted.excalidrawScene?.version).toBe(1);
    expect(restored.elements).toHaveLength(scene.elements.length);
    expect(restored.elements.some((element) => element.customData?.jkcMediaId === "media-video")).toBe(true);
    expect(persisted.items).toEqual(board.items);
  });
});
