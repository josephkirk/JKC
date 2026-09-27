import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { BoardDocument, BoardItem, BoardNoteItem, BoardTextItem, BoardDrawingItem, ExcalidrawSceneDocument } from "../../lib/contracts.ts";

export type ExcalidrawScene = { elements: any[]; appState: Record<string, unknown>; files: Record<string, any> };

const customData = (item: BoardItem) => ({
  jkcItemId: item.id,
  jkcType: item.type,
  ...(item.type === "image" || item.type === "video" ? { jkcMediaId: item.mediaId, jkcMediaKind: item.type } : {}),
  ...(item.type === "math" ? { jkcFormula: item.formula } : {}),
});

function legacyElementDescriptors(item: BoardItem): any[] {
  const shared = { angle: item.rotation * Math.PI / 180, groupIds: [item.id], customData: customData(item) };
  if (item.type === "drawing") {
    const drawing = item as BoardDrawingItem;
    return [{ type: "freedraw", x: item.x, y: item.y, points: drawing.points.map((point) => [point.x, point.y]), strokeColor: drawing.color, strokeWidth: drawing.strokeWidth, ...shared }];
  }
  const label = item.type === "image" || item.type === "video" ? `${item.type}: ${item.mediaId}` : item.type === "math" ? item.formula : (item as BoardTextItem | BoardNoteItem).text;
  return [
    { type: "rectangle", x: item.x, y: item.y, width: item.width, height: item.height, backgroundColor: item.type === "note" ? (item as BoardNoteItem).color : "#202938", fillStyle: "solid", strokeColor: "#6b7280", ...shared },
    { type: "text", x: item.x + 12, y: item.y + 12, text: label, fontSize: item.type === "text" ? (item as BoardTextItem).fontSize : item.type === "math" ? 28 : 16, strokeColor: item.type === "text" ? (item as BoardTextItem).color : "#f8fafc", ...shared },
  ];
}

export function migrateBoardItems(document: BoardDocument): ExcalidrawScene {
  const elements = convertToExcalidrawElements([...document.items].sort((a, b) => a.zIndex - b.zIndex).flatMap(legacyElementDescriptors)) as any[];
  return { elements, appState: { viewBackgroundColor: "#090b10", theme: "dark" }, files: {} };
}

export function sceneFromDocument(document: BoardDocument): ExcalidrawScene {
  if (document.excalidrawScene?.version === 1) return { elements: document.excalidrawScene.elements as any[], appState: document.excalidrawScene.appState ?? { viewBackgroundColor: "#090b10", theme: "dark" }, files: {} };
  return migrateBoardItems(document);
}

export function documentWithScene(document: BoardDocument, scene: ExcalidrawScene): BoardDocument {
  const elements = scene.elements.filter((element) => !element.isDeleted);
  return { ...document, excalidrawScene: { version: 1, elements, appState: { viewBackgroundColor: scene.appState.viewBackgroundColor, theme: scene.appState.theme, scrollX: scene.appState.scrollX, scrollY: scene.appState.scrollY, zoom: scene.appState.zoom } } satisfies ExcalidrawSceneDocument };
}

export function mediaIdFromElement(element: any): string | null {
  const id = element?.customData?.jkcMediaId;
  return typeof id === "string" ? id : null;
}

export function elementDescriptorsForMedia(mediaId: string, kind: "image" | "video", itemId: string, x: number, y: number, fileId?: string, width = 320, height = 220): any[] {
  const data = { jkcItemId: itemId, jkcMediaId: mediaId, jkcType: kind, jkcMediaKind: kind };
  if (fileId) return [{ type: "image", x, y, width, height, fileId, groupIds: [itemId], customData: data }];
  return [{ type: "rectangle", x, y, width, height, backgroundColor: "#202938", fillStyle: "solid", strokeColor: "#60a5fa", groupIds: [itemId], customData: data }, { type: "text", x: x + 12, y: y + 12, text: `${kind}: ${mediaId}`, fontSize: 16, strokeColor: "#f8fafc", groupIds: [itemId], customData: data }];
}

export function elementDescriptorsForMath(formula: string, itemId: string, x: number, y: number, fileId?: string, width = 360, height = 100): any[] {
  const data = { jkcItemId: itemId, jkcType: "math", jkcFormula: formula };
  if (fileId) return [{ type: "image", x, y, width, height, fileId, groupIds: [itemId], customData: data }];
  return [{ type: "text", x, y, text: formula, width, height, fontSize: 28, strokeColor: "#f8fafc", groupIds: [itemId], customData: data }];
}
