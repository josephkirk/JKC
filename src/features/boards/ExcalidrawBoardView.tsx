import React, { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw, convertToExcalidrawElements, viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";
import type { BinaryFileData, DataURL, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import { useApp } from "../../context/AppContext.tsx";
import { api, getThumbnailUrl } from "../../lib/api.ts";
import type { BoardDocument, BoardMathItem, BoardMediaItem, BoardSummary } from "../../lib/contracts.ts";
import katex from "katex";
import "katex/dist/katex.min.css";
import { documentWithScene, elementDescriptorsForMath, elementDescriptorsForMedia, sceneFromDocument, type ExcalidrawScene } from "./excalidrawAdapter.ts";

type ThumbnailData = { dataURL: DataURL; mimeType: BinaryFileData["mimeType"] };

async function thumbnailDataUrl(mediaId: string, version?: string | number): Promise<ThumbnailData | undefined> {
  try {
    const response = await fetch(getThumbnailUrl(mediaId, version), { cache: "no-store" });
    if (!response.ok || !response.headers.get("content-type")?.startsWith("image/")) return undefined;
    const mimeType = response.headers.get("content-type") as BinaryFileData["mimeType"];
    const blob = await response.blob();
    const dataURL = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    return { dataURL: dataURL as DataURL, mimeType };
  } catch {
    return undefined;
  }
}
function mathDataUrl(formula: string): DataURL {
  const rendered = katex.renderToString(formula, { displayMode: true, throwOnError: false, output: "mathml" });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="100"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="background:#202938;color:#f8fafc;padding:16px;font-family:'Cambria Math',serif;font-size:24px">${rendered}</div></foreignObject></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` as DataURL;
}
async function hydrateMediaScene(
  document: BoardDocument,
  baseScene: ExcalidrawScene,
  replaceLegacy: boolean,
): Promise<{ scene: ExcalidrawScene; correctedLegacyAspect: boolean }> {
  const mediaItems = document.items.filter((item): item is BoardMediaItem => item.type === "image" || item.type === "video");
  const results = await Promise.all(
    mediaItems.map(async (item) => {
      try {
        const detail = await api.getMedia(item.mediaId);
        const thumbnail = await thumbnailDataUrl(item.mediaId, `${detail.sizeBytes}-${detail.modifiedMs}`);
        return { item, detail, thumbnail };
      } catch {
        return { item, detail: null, thumbnail: await thumbnailDataUrl(item.mediaId) };
      }
    }),
  );

  let elements = baseScene.elements;
  const files = { ...baseScene.files };
  let correctedLegacyAspect = false;

  for (const { item, detail, thumbnail } of results) {
    if (!thumbnail) continue;

    if (replaceLegacy) {
      let width = item.width || 320;
      let height = item.height || 220;
      if (
        item.width === 320 &&
        item.height === 220 &&
        detail?.width &&
        detail?.height &&
        detail.width > 0 &&
        detail.height > 0
      ) {
        const aspect = detail.width / detail.height;
        height = Math.max(20, Math.round(width / aspect));
      }
      const replacement = convertToExcalidrawElements(
        elementDescriptorsForMedia(item.mediaId, item.type, item.id, item.x, item.y, item.mediaId, width, height),
      ) as any[];
      elements = [...elements.filter((element) => element.customData?.jkcItemId !== item.id), ...replacement];
    } else {
      // For existing scenes, safely adjust only image elements that are still at the legacy 320x220:
      // We spread the existing element so x, y, angle, groupIds, and customData are 100% preserved.
      elements = elements.map((element: any) => {
        if (
          element.customData?.jkcItemId === item.id &&
          element.type === "image" &&
          element.width === 320 &&
          element.height === 220 &&
          detail?.width &&
          detail?.height &&
          detail.width > 0 &&
          detail.height > 0
        ) {
          const aspect = detail.width / detail.height;
          const correctedHeight = Math.max(20, Math.round(element.width / aspect));
          if (correctedHeight === element.height) {
            return element;
          }
          correctedLegacyAspect = true;
          return {
            ...element,
            height: correctedHeight,
            version: (element.version || 1) + 1,
            versionNonce: Math.floor(Math.random() * 2000000000),
            updated: Date.now(),
          };
        }
        return element;
      });
    }

    files[item.mediaId] = { id: item.mediaId as any, ...thumbnail, created: Date.now() };
  }

  for (const item of document.items) {
    if (item.type !== "math") continue;
    const element = elements.find((candidate) => candidate.customData?.jkcItemId === item.id && candidate.fileId);
    if (element) {
      files[element.fileId] = {
        id: element.fileId as any,
        mimeType: "image/svg+xml",
        dataURL: mathDataUrl(item.formula),
        created: Date.now(),
      };
    }
  }

  return { scene: { ...baseScene, elements, files }, correctedLegacyAspect };
}
function parseMediaIds(event: React.DragEvent): string[] {
  const custom = event.dataTransfer.getData("application/jkc-media-ids");
  if (custom) {
    try {
      const ids = JSON.parse(custom);
      if (Array.isArray(ids)) return ids.filter((id): id is string => typeof id === "string");
    } catch {
      // Fall through to the text payload.
    }
  }
  const text = event.dataTransfer.getData("text/plain");
  if (text.startsWith("jkc-media:")) {
    try {
      const ids = JSON.parse(text.slice("jkc-media:".length));
      if (Array.isArray(ids)) return ids.filter((id): id is string => typeof id === "string");
    } catch {
      // Invalid external payload.
    }
  }
  const single = event.dataTransfer.getData("application/jkc-media-id");
  return single ? [single] : [];
}

export const ExcalidrawBoardView: React.FC = () => {
  const { activeBoardId, setActiveBoardId, pendingBoardMediaIds, clearPendingBoardMedia, setSaveStatus, setSaveErrorMessage, registerSaveFlusher, openMediaInPlayer } = useApp();
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [document, setDocument] = useState<BoardDocument | null>(null);
  const [scene, setScene] = useState<ExcalidrawScene | null>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const documentRef = useRef<BoardDocument | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const addMediaPromiseRef = useRef<Promise<void>>(Promise.resolve());
  const hydratingRef = useRef(false);
  const sceneRef = useRef<ExcalidrawScene | null>(null);
  const lastMediaPointerRef = useRef<{ mediaId: string; at: number } | null>(null);
  const [formula, setFormula] = useState("E = mc^2");

  const loadBoards = useCallback(async () => {
    let list = await api.listBoards();
    if (list.length === 0) {
      const created = await api.createBoard("Untitled Board");
      list = [{ id: created.id, name: created.name, itemCount: created.items.length }];
    }
    setBoards(list);
    if (!activeBoardId && list[0]) setActiveBoardId(list[0].id);
  }, [activeBoardId, setActiveBoardId]);

  useEffect(() => {
    void loadBoards().catch((error) => console.error("Failed to load boards:", error));
  }, [loadBoards]);

  useEffect(() => {
    if (!activeBoardId) {
      setDocument(null);
      setScene(null);
      documentRef.current = null;
      return;
    }
    let cancelled = false;
    void api.getBoard(activeBoardId).then(async (loaded) => {
      if (cancelled) return;
      const migrated = !loaded.excalidrawScene;
      const initialScene = sceneFromDocument(loaded);
      const nextDocument = documentWithScene(loaded, initialScene);
      documentRef.current = nextDocument;
      sceneRef.current = initialScene;
      setDocument(nextDocument);
      setScene(initialScene);
      setSaveStatus("saved");
      const { scene: hydratedScene, correctedLegacyAspect } = await hydrateMediaScene(loaded, initialScene, migrated);
      if (cancelled) return;
      sceneRef.current = hydratedScene;
      setScene(hydratedScene);
      if (apiRef.current) {
        hydratingRef.current = true;
        const files = Object.values(hydratedScene.files) as BinaryFileData[];
        if (files.length) apiRef.current.addFiles(files);
        apiRef.current.updateScene({ elements: hydratedScene.elements, appState: hydratedScene.appState as any });
        window.setTimeout(() => { hydratingRef.current = false; }, 0);
      }
      const hydratedDocument = documentWithScene(documentRef.current ?? loaded, hydratedScene);
      documentRef.current = hydratedDocument;
      setDocument(hydratedDocument);
      if (migrated || correctedLegacyAspect) await enqueueSave(hydratedDocument);
    }).catch((error) => {
      if (!cancelled) setSaveErrorMessage(error instanceof Error ? error.message : "Failed to load board");
    });
    return () => {
      cancelled = true;
    };
  }, [activeBoardId, setSaveErrorMessage, setSaveStatus]);
  const enqueueSave = useCallback((nextDocument: BoardDocument) => {
    const write = saveChainRef.current.then(() => api.saveBoard(nextDocument));
    saveChainRef.current = write.catch(() => undefined);
    return write;
  }, []);

  const saveScene = useCallback((nextScene: ExcalidrawScene) => {
    const current = documentRef.current;
    if (!current) return;
    sceneRef.current = nextScene;
    const nextDocument = documentWithScene(current, nextScene);
    documentRef.current = nextDocument;
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      setSaveStatus("saving");
      void enqueueSave(nextDocument).then(() => setSaveStatus("saved")).catch((error) => {
        setSaveStatus("error");
        setSaveErrorMessage(error instanceof Error ? error.message : "Failed to save board");
      });
    }, 500);
  }, [enqueueSave, setSaveErrorMessage, setSaveStatus]);
  const flushScene = useCallback(async () => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setSaveStatus("saving");
    await addMediaPromiseRef.current.catch(() => undefined);
    const current = documentRef.current;
    if (!current) return;
    await enqueueSave(current);
    setSaveStatus("saved");
  }, [enqueueSave, setSaveStatus]);

  useEffect(() => registerSaveFlusher(flushScene), [flushScene, registerSaveFlusher]);

  const addMedia = useCallback(async (ids: string[], x: number, y: number) => {
    if (!apiRef.current || !documentRef.current) return;
    const originId = documentRef.current.id;
    const media = await Promise.all(ids.map((id) => api.getMedia(id)));
    const placements = await Promise.all(media.map(async (item, index) => ({
      item,
      id: crypto.randomUUID(),
      x: x + index * 36,
      y: y + index * 36,
      dataUrl: await thumbnailDataUrl(item.id, `${item.sizeBytes}-${item.modifiedMs}`),
    })));
    if (documentRef.current?.id !== originId) throw new Error("Board changed while loading media");
    const descriptors = placements.flatMap(({ item, id, x: itemX, y: itemY, dataUrl }) => {
      const aspect = item.width && item.height && item.width > 0 && item.height > 0
        ? item.width / item.height
        : (item.kind === "video" ? 16 / 9 : 1);
      const width = 320;
      const height = Math.max(20, Math.round(width / aspect));
      return elementDescriptorsForMedia(
        item.id,
        item.kind === "video" ? "video" : "image",
        id,
        itemX,
        itemY,
        dataUrl ? item.id : undefined,
        width,
        height,
      );
    });
    const items: BoardMediaItem[] = placements.map(({ item, id, x: itemX, y: itemY }, index) => {
      const aspect = item.width && item.height && item.width > 0 && item.height > 0
        ? item.width / item.height
        : (item.kind === "video" ? 16 / 9 : 1);
      const width = 320;
      const height = Math.max(20, Math.round(width / aspect));
      return {
        id,
        type: item.kind === "video" ? "video" : "image",
        mediaId: item.id,
        x: itemX,
        y: itemY,
        width,
        height,
        rotation: 0,
        zIndex: documentRef.current!.items.length + index,
      };
    });
    const currentScene = sceneRef.current ?? { elements: [], appState: {}, files: {} };
    const elements = convertToExcalidrawElements(descriptors) as any[];
    const nextScene = {
      ...currentScene,
      elements: [...currentScene.elements, ...elements],
      files: {
        ...currentScene.files,
        ...Object.fromEntries(placements.filter((placement) => placement.dataUrl).map((placement) => [
          placement.item.id,
          { id: placement.item.id as any, mimeType: placement.dataUrl!.mimeType, dataURL: placement.dataUrl!.dataURL, created: Date.now() },
        ])),
      },
    };
    const nextDocument = { ...documentRef.current, items: [...documentRef.current.items, ...items] };
    sceneRef.current = nextScene;
    documentRef.current = nextDocument;
    setDocument(nextDocument);
    apiRef.current.addFiles(Object.values(nextScene.files));
    apiRef.current.updateScene({ elements: nextScene.elements });
    saveScene(nextScene);

  }, []);
  const runAddMedia = useCallback((ids: string[], x: number, y: number) => {
    const run = addMediaPromiseRef.current.then(() => addMedia(ids, x, y));
    addMediaPromiseRef.current = run.catch(() => undefined);
    return run;
  }, [addMedia]);

  useEffect(() => {
    if (pendingBoardMediaIds.length === 0 || !apiRef.current || !documentRef.current) return;
    void runAddMedia(pendingBoardMediaIds, 120, 120).then(() => clearPendingBoardMedia()).catch((error) => {
      setSaveErrorMessage(error instanceof Error ? error.message : "Failed to add media to board");
    });
  }, [clearPendingBoardMedia, pendingBoardMediaIds, runAddMedia, setSaveErrorMessage]);
  const insertMath = () => {
    if (!documentRef.current || !apiRef.current || !formula.trim()) return;
    const item: BoardMathItem = { id: crypto.randomUUID(), type: "math", formula: formula.trim(), x: 120, y: 120, width: 360, height: 100, rotation: 0, zIndex: documentRef.current.items.length };
    const mathFile = mathDataUrl(item.formula);
    const elements = convertToExcalidrawElements(elementDescriptorsForMath(item.formula, item.id, item.x, item.y, item.id, item.width, item.height)) as any[];
    const currentScene = sceneRef.current ?? { elements: [], appState: {}, files: {} };
    const nextScene = { ...currentScene, elements: [...currentScene.elements, ...elements], files: { ...currentScene.files, [item.id]: { id: item.id as any, mimeType: "image/svg+xml" as BinaryFileData["mimeType"], dataURL: mathFile, created: Date.now() } } };
    const nextDocument = { ...documentRef.current, items: [...documentRef.current.items, item] };
    documentRef.current = nextDocument;
    setDocument(nextDocument);
    apiRef.current.addFiles([nextScene.files[item.id]]);
    apiRef.current.updateScene({ elements: nextScene.elements });
    saveScene(nextScene);
  };
  const editSelectedMath = () => {
    const excalidrawApi = apiRef.current;
    const currentDocument = documentRef.current;
    if (!excalidrawApi || !currentDocument) return;
    const selectedIds = excalidrawApi.getAppState().selectedElementIds;
    const selected = (sceneRef.current?.elements ?? []).find((element) => selectedIds[element.id] && element.customData?.jkcType === "math");
    if (!selected) return;
    const nextFormula = window.prompt("Math formula", selected.customData.jkcFormula)?.trim();
    if (!nextFormula) return;
    setFormula(nextFormula);
    const itemId = selected.customData.jkcItemId as string;
    const item = currentDocument.items.find((candidate) => candidate.id === itemId && candidate.type === "math");
    if (!item || item.type !== "math") return;
    const nextFile = mathDataUrl(nextFormula);
    const fileId = `${itemId}-${crypto.randomUUID()}`;
    const replacement = convertToExcalidrawElements(elementDescriptorsForMath(nextFormula, itemId, selected.x, selected.y, fileId, selected.width, selected.height)) as any[];
    const currentScene = sceneRef.current ?? { elements: [], appState: {}, files: {} };
    const remainingFiles = { ...currentScene.files };
    delete remainingFiles[selected.fileId ?? itemId];
    const nextScene = { ...currentScene, elements: [...currentScene.elements.filter((element) => element.customData?.jkcItemId !== itemId), ...replacement], files: { ...remainingFiles, [fileId]: { id: fileId as any, mimeType: "image/svg+xml" as BinaryFileData["mimeType"], dataURL: nextFile, created: Date.now() } } };
    const nextDocument: BoardDocument = { ...currentDocument, items: currentDocument.items.map((candidate) => candidate.id === itemId ? { ...candidate, formula: nextFormula } : candidate) };
    documentRef.current = nextDocument;
    setDocument(nextDocument);
    excalidrawApi.addFiles([nextScene.files[fileId]]);
    excalidrawApi.updateScene({ elements: nextScene.elements });
    saveScene(nextScene);
  };

  const formulaPreview = (() => {
    try {
      return katex.renderToString(formula || "\\text{Enter a formula}", { throwOnError: false, displayMode: true });
    } catch {
      return "<span>Invalid formula</span>";
    }
  })();

  const createBoard = async () => {
    await flushScene();
    const created = await api.createBoard(`Board ${boards.length + 1}`);
    setBoards((current) => [...current, { id: created.id, name: created.name, itemCount: 0 }]);
    setActiveBoardId(created.id);
  };

  const renameBoard = async () => {
    if (!document) return;
    const name = window.prompt("Board name", document.name)?.trim();
    if (!name || name === document.name) return;
    const next = { ...document, name };
    documentRef.current = next;
    setDocument(next);
    await flushScene();
    setBoards((current) => current.map((board) => board.id === next.id ? { ...board, name } : board));
  };

  const deleteBoard = async () => {
    if (!document || !window.confirm(`Delete "${document.name}"?`)) return;
    await flushScene();
    await api.deleteBoard(document.id);
    setDocument(null);
    setScene(null);
    documentRef.current = null;
    setActiveBoardId(null);
    await loadBoards();
  };

  const switchBoard = async (id: string) => {
    await flushScene();
    setActiveBoardId(id);
  };


  if (!document || !scene) {
    return <div className="empty-state"><div className="empty-state-title">Loading canvas…</div></div>;
  }

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--border-color)", background: "var(--bg-secondary)" }}>
        <select className="input-select" value={document.id} onChange={(event) => void switchBoard(event.target.value)} aria-label="Board">
          {boards.map((board) => <option key={board.id} value={board.id}>{board.name}</option>)}
        </select>
        <button type="button" className="btn" onClick={() => void createBoard()}>New</button>
        <button type="button" className="btn" onClick={() => void renameBoard()}>Rename</button>
        <button type="button" className="btn btn-danger" onClick={() => void deleteBoard()}>Delete</button>
        <input className="input-text" value={formula} onChange={(event) => setFormula(event.target.value)} aria-label="Math formula" placeholder="x^2 + y^2 = z^2" style={{ width: 180 }} />
        <button type="button" className="btn" onClick={insertMath}>Insert Math</button>
        <button type="button" className="btn" onClick={editSelectedMath}>Edit Selected Math</button>
        <span aria-live="polite" style={{ color: "var(--text-muted)", fontSize: 12 }} dangerouslySetInnerHTML={{ __html: formulaPreview }} />
        <span style={{ marginLeft: "auto", color: "var(--text-muted)", fontSize: 11 }}>
          Tip: Hold Shift while dragging corner/side handles to resize images non-uniformly.
        </span>
      </div>
      <div
        style={{ flex: 1, minHeight: 0, position: "relative", outline: isDropTarget ? "2px solid var(--accent)" : undefined }}
        onDragEnter={() => setIsDropTarget(true)}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
        onDragLeave={() => setIsDropTarget(false)}
        onDrop={(event) => {
          event.preventDefault();
          setIsDropTarget(false);
          const ids = parseMediaIds(event);
          if (!ids.length) return;
          const appState = apiRef.current?.getAppState();
          if (!appState) return;
          const point = viewportCoordsToSceneCoords(
            { clientX: event.clientX, clientY: event.clientY },
            {
              zoom: appState.zoom,
              offsetLeft: appState.offsetLeft,
              offsetTop: appState.offsetTop,
              scrollX: appState.scrollX,
              scrollY: appState.scrollY,
            },
          );
          void runAddMedia(ids, point.x, point.y).catch((error) => setSaveErrorMessage(error instanceof Error ? error.message : "Failed to add media to board"));
        }}
      >
        <Excalidraw
          key={document.id}
          initialData={{ elements: scene.elements, appState: scene.appState as any, files: scene.files as any }}
          excalidrawAPI={(instance) => { apiRef.current = instance; }}
          onPointerDown={(_tool, pointerState) => {
            const mediaId = pointerState.hit.element?.customData?.jkcMediaId;
            const mediaKind = pointerState.hit.element?.customData?.jkcMediaKind;
            if (typeof mediaId !== "string" || (mediaKind !== "image" && mediaKind !== "video")) return;
            const now = Date.now();
            const previous = lastMediaPointerRef.current;
            if (previous?.mediaId === mediaId && now - previous.at < 350) {
              openMediaInPlayer(mediaId);
              lastMediaPointerRef.current = null;
            } else {
              lastMediaPointerRef.current = { mediaId, at: now };
            }
          }}
          onChange={(elements, appState, files) => {
            if (hydratingRef.current) return;
            saveScene({ elements: [...elements], appState: { viewBackgroundColor: appState.viewBackgroundColor, theme: appState.theme, scrollX: appState.scrollX, scrollY: appState.scrollY, zoom: appState.zoom }, files });
          }}
        />
        {isDropTarget && <div style={{ position: "absolute", inset: 16, border: "2px dashed var(--accent)", pointerEvents: "none", display: "grid", placeItems: "center", color: "var(--accent)", fontWeight: 600 }}>Drop media onto canvas</div>}
      </div>
    </div>
  );
};
