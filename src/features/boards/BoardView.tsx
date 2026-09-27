import React, { useState, useEffect, useRef, useCallback, useReducer } from "react";
import {
  Stage,
  Layer,
  Rect,
  Text as KonvaText,
  Line as KonvaLine,
  Image as KonvaImage,
  Group,
  Transformer,
} from "react-konva";
import type { KonvaEventObject } from "konva/lib/Node";
import type { Box } from "konva/lib/shapes/Transformer";
import type Konva from "konva";
import { QueuedDocumentWriter } from "../../lib/queuedWriter.ts";
import {
  Plus,
  Trash2,
  Undo2,
  Redo2,
  Maximize2,
  StickyNote,
  Type,
  Pencil,
  Copy,
  ArrowUp,
  ArrowDown,
  X,
  FolderOpen,
} from "lucide-react";
import { useApp } from "../../context/AppContext.tsx";
import { api, getThumbnailUrl, getMediaAssetUrl, getProxyAssetUrl } from "../../lib/api.ts";
import type {
  BoardDocument,
  BoardItem,
  BoardMediaItem,
  BoardNoteItem,
  BoardSummary,
  BoardTextItem,
  BoardDrawingItem,
  BoardViewport,
  MediaItem,
} from "../../lib/contracts.ts";

interface BoardState {
  doc: BoardDocument | null;
  history: BoardDocument[];
  historyIndex: number;
  isDirty: boolean;
  revision: number;
}

type BoardAction =
  | { type: "LOAD_BOARD"; payload: BoardDocument }
  | { type: "SET_VIEWPORT"; viewport: BoardViewport }
  | { type: "ADD_ITEM"; item: BoardItem }
  | { type: "UPDATE_ITEMS"; items: BoardItem[] }
  | { type: "DELETE_ITEMS"; ids: string[] }
  | { type: "DUPLICATE_ITEMS"; ids: string[] }
  | { type: "REORDER_ITEMS"; id: string; direction: "front" | "back" }
  | { type: "RENAME_BOARD"; name: string }
  | { type: "UNDO" }
  | { type: "REDO" }
  | { type: "MARK_SAVED"; savedRevision: number };

const initialBoardState: BoardState = {
  doc: null,
  history: [],
  historyIndex: -1,
  isDirty: false,
  revision: 0,
};

function pushHistory(history: BoardDocument[], index: number, nextDoc: BoardDocument): { history: BoardDocument[]; index: number } {
  const sliced = history.slice(0, index + 1);
  sliced.push(nextDoc);
  if (sliced.length > 50) {
    sliced.shift();
  }
  return { history: sliced, index: sliced.length - 1 };
}

function boardReducer(state: BoardState, action: BoardAction): BoardState {
  switch (action.type) {
    case "LOAD_BOARD": {
      return {
        doc: action.payload,
        history: [action.payload],
        historyIndex: 0,
        isDirty: false,
        revision: state.revision + 1,
      };
    }
    case "SET_VIEWPORT": {
      if (!state.doc) return state;
      const updatedDoc: BoardDocument = {
        ...state.doc,
        viewport: action.viewport,
      };
      return {
        ...state,
        doc: updatedDoc,
        isDirty: true,
        revision: state.revision + 1,
      };
    }
    case "ADD_ITEM": {
      if (!state.doc) return state;
      const updatedDoc: BoardDocument = {
        ...state.doc,
        items: [...state.doc.items, action.item],
      };
      const { history, index } = pushHistory(state.history, state.historyIndex, updatedDoc);
      return {
        ...state,
        doc: updatedDoc,
        history,
        historyIndex: index,
        isDirty: true,
        revision: state.revision + 1,
      };
    }
    case "UPDATE_ITEMS": {
      if (!state.doc) return state;
      const map = new Map(action.items.map((i) => [i.id, i]));
      const updatedItems = state.doc.items.map((existing) => map.get(existing.id) || existing);
      const updatedDoc: BoardDocument = {
        ...state.doc,
        items: updatedItems,
      };
      const { history, index } = pushHistory(state.history, state.historyIndex, updatedDoc);
      return {
        ...state,
        doc: updatedDoc,
        history,
        historyIndex: index,
        isDirty: true,
        revision: state.revision + 1,
      };
    }
    case "DELETE_ITEMS": {
      if (!state.doc) return state;
      const idsSet = new Set(action.ids);
      const updatedItems = state.doc.items.filter((i) => !idsSet.has(i.id));
      const updatedDoc: BoardDocument = {
        ...state.doc,
        items: updatedItems,
      };
      const { history, index } = pushHistory(state.history, state.historyIndex, updatedDoc);
      return {
        ...state,
        doc: updatedDoc,
        history,
        historyIndex: index,
        isDirty: true,
        revision: state.revision + 1,
      };
    }
    case "DUPLICATE_ITEMS": {
      if (!state.doc) return state;
      const idsSet = new Set(action.ids);
      const clones: BoardItem[] = [];
      let maxZ = state.doc.items.reduce((acc, cur) => Math.max(acc, cur.zIndex), 0);

      for (const item of state.doc.items) {
        if (idsSet.has(item.id)) {
          maxZ += 1;
          clones.push({
            ...item,
            id: crypto.randomUUID(),
            x: item.x + 30,
            y: item.y + 30,
            zIndex: maxZ,
          });
        }
      }
      const updatedDoc: BoardDocument = {
        ...state.doc,
        items: [...state.doc.items, ...clones],
      };
      const { history, index } = pushHistory(state.history, state.historyIndex, updatedDoc);
      return {
        ...state,
        doc: updatedDoc,
        history,
        historyIndex: index,
        isDirty: true,
        revision: state.revision + 1,
      };
    }
    case "REORDER_ITEMS": {
      if (!state.doc) return state;
      const item = state.doc.items.find((i) => i.id === action.id);
      if (!item) return state;

      let newZ = item.zIndex;
      if (action.direction === "front") {
        const maxZ = state.doc.items.reduce((acc, cur) => Math.max(acc, cur.zIndex), 0);
        newZ = maxZ + 1;
      } else {
        const minZ = state.doc.items.reduce((acc, cur) => Math.min(acc, cur.zIndex), 1);
        newZ = Math.max(0, minZ - 1);
      }

      const updatedItems = state.doc.items.map((i) => (i.id === action.id ? { ...i, zIndex: newZ } : i));
      const updatedDoc: BoardDocument = {
        ...state.doc,
        items: updatedItems,
      };
      const { history, index } = pushHistory(state.history, state.historyIndex, updatedDoc);
      return {
        ...state,
        doc: updatedDoc,
        history,
        historyIndex: index,
        isDirty: true,
        revision: state.revision + 1,
      };
    }
    case "RENAME_BOARD": {
      if (!state.doc) return state;
      const updatedDoc: BoardDocument = {
        ...state.doc,
        name: action.name,
      };
      return {
        ...state,
        doc: updatedDoc,
        isDirty: true,
        revision: state.revision + 1,
      };
    }
    case "UNDO": {
      if (state.historyIndex > 0) {
        const nextIndex = state.historyIndex - 1;
        return {
          ...state,
          doc: state.history[nextIndex],
          historyIndex: nextIndex,
          isDirty: true,
          revision: state.revision + 1,
        };
      }
      return state;
    }
    case "REDO": {
      if (state.historyIndex < state.history.length - 1) {
        const nextIndex = state.historyIndex + 1;
        return {
          ...state,
          doc: state.history[nextIndex],
          historyIndex: nextIndex,
          isDirty: true,
          revision: state.revision + 1,
        };
      }
      return state;
    }
    case "MARK_SAVED": {
      if (state.revision === action.savedRevision) {
        return {
          ...state,
          isDirty: false,
        };
      }
      return state;
    }
    default:
      return state;
  }
}

export const BoardView: React.FC = () => {
  const {
    activeBoardId,
    setActiveBoardId,
    setSaveStatus,
    setSaveErrorMessage,
    registerSaveFlusher,
    openMediaInPlayer,
  } = useApp();

  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [boardState, dispatch] = useReducer(boardReducer, initialBoardState);
  const [hydratedBoardId, setHydratedBoardId] = useState<string | null>(null);
  const loadSeqRef = useRef(0);

  // Selected item IDs
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [activeTool, setActiveTool] = useState<"select" | "draw" | "note" | "text">("select");
  const [activeDrawingColor, setActiveDrawingColor] = useState("#3b82f6");

  // Active playing video overlay
  const [activeVideoId, setActiveVideoId] = useState<string | null>(null);

  // Text inline editing overlay
  const [editingTextItem, setEditingTextItem] = useState<{ id: string; text: string; x: number; y: number; width: number; height: number } | null>(null);

  // Loaded media cache for boards
  const [mediaMap, setMediaMap] = useState<Map<string, MediaItem>>(new Map());

  // Drawing state
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentLine, setCurrentLine] = useState<{ x: number; y: number }[]>([]);

  // Stage references & size
  const stageRef = useRef<Konva.Stage | null>(null);
  const transformerRef = useRef<Konva.Transformer | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [stageDimensions, setStageDimensions] = useState({ width: 800, height: 600 });
  const isPanningRef = useRef(false);
  const lastPanPosRef = useRef({ x: 0, y: 0 });
  const spaceDownRef = useRef(false);

  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Load Boards list
  const loadBoardsList = useCallback(async () => {
    try {
      const list = await api.listBoards();
      setBoards(list);
      if (list.length > 0 && !activeBoardId) {
        setActiveBoardId(list[0].id);
      }
    } catch (err) {
      console.error("Failed to load boards list:", err);
    }
  }, [activeBoardId, setActiveBoardId]);

  useEffect(() => {
    loadBoardsList();
  }, [loadBoardsList]);
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceDownRef.current = true;
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceDownRef.current = false;
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);


  // Load active board document
  useEffect(() => {
    clearTimeout(saveTimeoutRef.current ?? undefined);
    if (!activeBoardId) {
      setHydratedBoardId(null);
      return;
    }

    const seq = ++loadSeqRef.current;
    setHydratedBoardId(null);
    setActiveVideoId(null);
    setEditingTextItem(null);
    setSelectedIds([]);

    api
      .getBoard(activeBoardId)
      .then(async (doc) => {
        if (seq !== loadSeqRef.current) return;
        dispatch({ type: "LOAD_BOARD", payload: doc });
        setHydratedBoardId(doc.id);
        setSaveStatus("saved");

        // Preload referenced media items
        const mediaIds = doc.items
          .filter((i): i is BoardMediaItem => i.type === "image" || i.type === "video")
          .map((i) => i.mediaId);

        const map = new Map<string, MediaItem>();
        for (const mid of mediaIds) {
          try {
            const m = await api.getMedia(mid);
            map.set(mid, m);
          } catch {
            // Missing media remains missing
          }
        }
        setMediaMap(map);
      })
      .catch((err) => {
        if (seq !== loadSeqRef.current) return;
        console.error("Failed to load board:", err);
      });
  }, [activeBoardId, setSaveStatus]);

  // Auto-save Board Document when dirty
  const writerRef = useRef<QueuedDocumentWriter<BoardDocument> | null>(null);

  useEffect(() => {
    writerRef.current = new QueuedDocumentWriter<BoardDocument>(
      async (doc) => {
        setSaveStatus("saving");
        await api.saveBoard(doc);
      },
      (savedRev) => {
        dispatch({ type: "MARK_SAVED", savedRevision: savedRev });
        setSaveStatus("saved");
        setSaveErrorMessage(null);
        loadBoardsList();
      },
      (err) => {
        setSaveStatus("error");
        const msg = err && typeof err === "object" && "message" in err ? String(err.message) : "Failed to save board";
        setSaveErrorMessage(msg);
      }
    );
  }, [setSaveStatus, setSaveErrorMessage, loadBoardsList]);

  // Auto-save Board Document through queued single writer
  const performSave = useCallback(async () => {
    if (!boardState.doc || hydratedBoardId !== boardState.doc.id || !boardState.isDirty) {
      return;
    }
    if (writerRef.current) {
      await writerRef.current.enqueue(boardState.doc, boardState.revision);
    }
  }, [boardState.doc, boardState.revision, boardState.isDirty, hydratedBoardId]);

  const flushSave = useCallback(async () => {
    clearTimeout(saveTimeoutRef.current ?? undefined);
    if (boardState.isDirty) {
      await performSave();
    }
    if (writerRef.current) {
      await writerRef.current.flush();
    }
  }, [performSave, boardState.isDirty]);

  useEffect(() => {
    if (!boardState.doc || hydratedBoardId !== boardState.doc.id || !boardState.isDirty) {
      return;
    }

    clearTimeout(saveTimeoutRef.current ?? undefined);
    setSaveStatus("saving");
    saveTimeoutRef.current = setTimeout(() => {
      performSave();
    }, 500);

    return () => {
      clearTimeout(saveTimeoutRef.current ?? undefined);
    };
  }, [boardState.revision, boardState.isDirty, boardState.doc, hydratedBoardId, performSave, setSaveStatus]);

  useEffect(() => {
    return registerSaveFlusher(flushSave);
  }, [registerSaveFlusher, flushSave]);
  // Handle Container Dimensions
  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setStageDimensions({ width: rect.width, height: rect.height });
      }
    };
    updateSize();
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, []);

  // Update Konva Transformer for selected items
  useEffect(() => {
    if (!transformerRef.current || !stageRef.current) return;
    const stage = stageRef.current;
    const nodes = selectedIds
      .map((id) => stage.findOne(`#item-${id}`))
      .filter((n) => n != null);
    transformerRef.current.nodes(nodes);
    transformerRef.current.getLayer()?.batchDraw();
  }, [selectedIds, boardState.doc?.items]);

  // Cursor-centered Wheel Zoom (clamped 0.1 to 4.0)
  const handleWheel = (e: KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    if (!stage || !boardState.doc) return;

    const oldScale = boardState.doc.viewport.scale;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;

    const mousePointTo = {
      x: (pointer.x - boardState.doc.viewport.x) / oldScale,
      y: (pointer.y - boardState.doc.viewport.y) / oldScale,
    };

    const scaleFactor = e.evt.deltaY < 0 ? 1.1 : 0.9;
    const newScale = Math.min(4.0, Math.max(0.1, oldScale * scaleFactor));

    const newViewport: BoardViewport = {
      scale: newScale,
      x: pointer.x - mousePointTo.x * newScale,
      y: pointer.y - mousePointTo.y * newScale,
    };

    dispatch({ type: "SET_VIEWPORT", viewport: newViewport });
  };

  // Pan with middle button or Space-drag
  const handleMouseDown = (e: KonvaEventObject<MouseEvent>) => {
    if (e.evt.button === 1 || spaceDownRef.current || (activeTool === "select" && e.target === stageRef.current)) {
      isPanningRef.current = true;
      lastPanPosRef.current = { x: e.evt.clientX, y: e.evt.clientY };
    }

    if (e.target === stageRef.current) {
      setSelectedIds([]);
      setActiveVideoId(null);

      // Start drawing if tool is draw
      if (activeTool === "draw" && boardState.doc) {
        const stage = stageRef.current;
        const ptr = stage?.getPointerPosition();
        if (ptr) {
          const worldX = (ptr.x - boardState.doc.viewport.x) / boardState.doc.viewport.scale;
          const worldY = (ptr.y - boardState.doc.viewport.y) / boardState.doc.viewport.scale;
          setIsDrawing(true);
          setCurrentLine([{ x: worldX, y: worldY }]);
        }
      }
    }
  };

  const handleMouseMove = (e: KonvaEventObject<MouseEvent>) => {
    if (isPanningRef.current && boardState.doc) {
      const dx = e.evt.clientX - lastPanPosRef.current.x;
      const dy = e.evt.clientY - lastPanPosRef.current.y;
      lastPanPosRef.current = { x: e.evt.clientX, y: e.evt.clientY };

      dispatch({
        type: "SET_VIEWPORT",
        viewport: {
          ...boardState.doc.viewport,
          x: boardState.doc.viewport.x + dx,
          y: boardState.doc.viewport.y + dy,
        },
      });
      return;
    }

    if (isDrawing && activeTool === "draw" && boardState.doc) {
      const stage = stageRef.current;
      const ptr = stage?.getPointerPosition();
      if (ptr) {
        const worldX = (ptr.x - boardState.doc.viewport.x) / boardState.doc.viewport.scale;
        const worldY = (ptr.y - boardState.doc.viewport.y) / boardState.doc.viewport.scale;
        setCurrentLine((prev) => [...prev, { x: worldX, y: worldY }]);
      }
    }
  };

  const handleMouseUp = () => {
    isPanningRef.current = false;

    if (isDrawing && activeTool === "draw" && currentLine.length > 1 && boardState.doc) {
      setIsDrawing(false);

      // Calculate bounding box of line
      const xs = currentLine.map((p) => p.x);
      const ys = currentLine.map((p) => p.y);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const maxX = Math.max(...xs);
      const maxY = Math.max(...ys);
      const w = Math.max(10, maxX - minX);
      const h = Math.max(10, maxY - minY);

      // Store points relative to item (x, y)
      const relPoints = currentLine.map((p) => ({ x: p.x - minX, y: p.y - minY }));

      const maxZ = boardState.doc.items.reduce((acc, cur) => Math.max(acc, cur.zIndex), 0);
      const drawingItem: BoardDrawingItem = {
        id: crypto.randomUUID(),
        type: "drawing",
        x: minX,
        y: minY,
        width: w,
        height: h,
        rotation: 0,
        zIndex: maxZ + 1,
        color: activeDrawingColor,
        strokeWidth: 4,
        points: relPoints,
      };

      dispatch({ type: "ADD_ITEM", item: drawingItem });
      setCurrentLine([]);
    }
  };

  // Fit Content
  const handleFitContent = () => {
    if (!boardState.doc || boardState.doc.items.length === 0) return;
    const items = boardState.doc.items;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;

    for (const item of items) {
      minX = Math.min(minX, item.x);
      minY = Math.min(minY, item.y);
      maxX = Math.max(maxX, item.x + item.width);
      maxY = Math.max(maxY, item.y + item.height);
    }

    const padding = 60;
    const contentW = maxX - minX + padding * 2;
    const contentH = maxY - minY + padding * 2;

    const scaleX = stageDimensions.width / contentW;
    const scaleY = stageDimensions.height / contentH;
    const newScale = Math.min(1.5, Math.max(0.1, Math.min(scaleX, scaleY)));

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    dispatch({
      type: "SET_VIEWPORT",
      viewport: {
        scale: newScale,
        x: stageDimensions.width / 2 - centerX * newScale,
        y: stageDimensions.height / 2 - centerY * newScale,
      },
    });
  };

  // Add Board Item Helpers
  const handleAddStickyNote = (color: string) => {
    if (!boardState.doc) return;
    const maxZ = boardState.doc.items.reduce((acc, cur) => Math.max(acc, cur.zIndex), 0);
    const view = boardState.doc.viewport;
    const worldX = (stageDimensions.width / 2 - view.x) / view.scale;
    const worldY = (stageDimensions.height / 2 - view.y) / view.scale;

    const noteItem: BoardNoteItem = {
      id: crypto.randomUUID(),
      type: "note",
      x: worldX - 100,
      y: worldY - 100,
      width: 200,
      height: 180,
      rotation: 0,
      zIndex: maxZ + 1,
      text: "Double-click to edit note...",
      color,
    };
    dispatch({ type: "ADD_ITEM", item: noteItem });
    setSelectedIds([noteItem.id]);
  };

  const handleAddText = () => {
    if (!boardState.doc) return;
    const maxZ = boardState.doc.items.reduce((acc, cur) => Math.max(acc, cur.zIndex), 0);
    const view = boardState.doc.viewport;
    const worldX = (stageDimensions.width / 2 - view.x) / view.scale;
    const worldY = (stageDimensions.height / 2 - view.y) / view.scale;

    const textItem: BoardTextItem = {
      id: crypto.randomUUID(),
      type: "text",
      x: worldX - 120,
      y: worldY - 30,
      width: 240,
      height: 60,
      rotation: 0,
      zIndex: maxZ + 1,
      text: "Double-click to edit text",
      fontSize: 24,
      color: "#ffffff",
    };
    dispatch({ type: "ADD_ITEM", item: textItem });
    setSelectedIds([textItem.id]);
  };

  // Handle Drag & Drop Media onto Canvas
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    if (!boardState.doc) return;

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const dropClientX = e.clientX - rect.left;
    const dropClientY = e.clientY - rect.top;

    const view = boardState.doc.viewport;
    const worldX = (dropClientX - view.x) / view.scale;
    const worldY = (dropClientY - view.y) / view.scale;

    const primaryId = e.dataTransfer.getData("application/jkc-media-id");
    let droppedIds: string[] = [];
    try {
      const parsed = JSON.parse(e.dataTransfer.getData("application/jkc-media-ids") || "[]");
      if (Array.isArray(parsed)) droppedIds = parsed.filter((id): id is string => typeof id === "string");
    } catch {
      droppedIds = [];
    }
    if (primaryId && !droppedIds.includes(primaryId)) droppedIds.unshift(primaryId);
    if (droppedIds.length === 0) return;

    try {
      const mediaItems = await Promise.all(droppedIds.map((id) => api.getMedia(id)));
      const maxZ = boardState.doc.items.reduce((acc, cur) => Math.max(acc, cur.zIndex), 0);
      const newItems: BoardMediaItem[] = mediaItems.map((media, index) => {
        const aspect = media.width && media.height ? media.width / media.height : 1.77;
        const w = 320;
        const h = Math.round(w / aspect);
        return {
          id: crypto.randomUUID(),
          type: media.kind,
          mediaId: media.id,
          x: worldX - w / 2 + index * 30,
          y: worldY - h / 2 + index * 30,
          width: w,
          height: h,
          rotation: 0,
          zIndex: maxZ + index + 1,
        };
      });
      for (const item of newItems) dispatch({ type: "ADD_ITEM", item });
      setMediaMap((prev) => {
        const next = new Map(prev);
        mediaItems.forEach((media) => next.set(media.id, media));
        return next;
      });
      setSelectedIds(newItems.map((item) => item.id));
    } catch (err) {
      console.error("Failed to add dropped media to board:", err);
    }
  };
  const handleSwitchBoard = async (newId: string) => {
    if (newId === activeBoardId) return;
    try {
      await flushSave();
    } catch (err) {
      console.warn("Board switch aborted due to save error:", err);
      return;
    }
    setActiveBoardId(newId);
  };

  // Create new board
  const handleCreateBoard = async () => {
    const name = prompt("Enter new board name:", `Board ${boards.length + 1}`);
    if (!name?.trim()) return;
    try {
      await flushSave();
    } catch (err) {
      console.warn("Create board aborted due to save error:", err);
      return;
    }
    try {
      const newDoc = await api.createBoard(name.trim());
      await loadBoardsList();
      setActiveBoardId(newDoc.id);
    } catch (err) {
      console.error("Failed to create board:", err);
    }
  };

  // Delete current board
  const handleDeleteBoard = async () => {
    if (!boardState.doc) return;
    if (!confirm(`Delete board "${boardState.doc.name}"? Media files and other boards will not be affected.`)) {
      return;
    }
    try {
      await api.deleteBoard(boardState.doc.id);
      setActiveBoardId(null);
      await loadBoardsList();
    } catch (err) {
      console.error("Failed to delete board:", err);
    }
  };
  const handleDuplicateSelected = () => {
    if (selectedIds.length > 0) {
      dispatch({ type: "DUPLICATE_ITEMS", ids: selectedIds });
    }
  };

  const handleDeleteSelected = () => {
    if (selectedIds.length > 0) {
      dispatch({ type: "DELETE_ITEMS", ids: selectedIds });
      setSelectedIds([]);
      setActiveVideoId(null);
    }
  };

  const handleReorder = (direction: "front" | "back") => {
    if (selectedIds.length === 1) {
      dispatch({ type: "REORDER_ITEMS", id: selectedIds[0], direction });
    }
  };

  if (!boardState.doc) {
    return (
      <div className="workspace-view">
        <div className="empty-state">
          <FolderOpen className="empty-state-icon" />
          <div className="empty-state-title">No Board Selected</div>
          <div className="empty-state-desc">Create or choose an immersion board to organize media and notes spatially.</div>
          <button type="button" className="btn btn-primary" onClick={handleCreateBoard} style={{ marginTop: 12 }}>
            <Plus size={14} /> Create New Board
          </button>
        </div>
      </div>
    );
  }

  // Sorted items by stacking order
  const sortedItems = [...boardState.doc.items].sort((a, b) => a.zIndex - b.zIndex);

  return (
    <div style={{ display: "flex", flex: 1, height: "100%", overflow: "hidden", flexDirection: "column" }}>
      {/* Top Boards Toolbar */}
      <div
        style={{
          background: "var(--bg-secondary)",
          borderBottom: "1px solid var(--border-color)",
          padding: "8px 16px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          zIndex: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Board Selector */}
          <select
            value={activeBoardId || ""}
            onChange={(e) => handleSwitchBoard(e.target.value)}
            className="input-text"
            style={{ fontWeight: 600, padding: "4px 8px" }}
          >
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} ({b.itemCount} items)
              </option>
            ))}
          </select>

          <button type="button" className="btn btn-icon" onClick={handleCreateBoard} title="New Board">
            <Plus size={14} />
          </button>

          <button
            type="button"
            className="btn btn-icon"
            onClick={handleDeleteBoard}
            title="Delete Current Board"
            style={{ color: "var(--danger)" }}
          >
            <Trash2 size={14} />
          </button>
        </div>

        {/* Center Tools: Sticky Note, Text, Drawing, Fit */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {/* Sticky Notes */}
          <div style={{ display: "flex", gap: 3, background: "var(--bg-tertiary)", padding: 2, borderRadius: 6 }}>
            <button
              type="button"
              className="btn btn-icon"
              style={{ background: "#fef08a", color: "#854d0e", border: "none" }}
              onClick={() => handleAddStickyNote("#fef08a")}
              title="Add Yellow Sticky Note"
            >
              <StickyNote size={14} />
            </button>
            <button
              type="button"
              className="btn btn-icon"
              style={{ background: "#bae6fd", color: "#0369a1", border: "none" }}
              onClick={() => handleAddStickyNote("#bae6fd")}
              title="Add Blue Sticky Note"
            >
              <StickyNote size={14} />
            </button>
            <button
              type="button"
              className="btn btn-icon"
              style={{ background: "#fbcfe8", color: "#9d174d", border: "none" }}
              onClick={() => handleAddStickyNote("#fbcfe8")}
              title="Add Pink Sticky Note"
            >
              <StickyNote size={14} />
            </button>
          </div>

          {/* Text Tool */}
          <button type="button" className="btn" onClick={handleAddText} title="Add Text Header">
            <Type size={14} /> Text
          </button>

          {/* Drawing Tool */}
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <button
              type="button"
              className={`btn btn-icon ${activeTool === "draw" ? "btn-primary" : ""}`}
              onClick={() => setActiveTool(activeTool === "draw" ? "select" : "draw")}
              title="Freehand Canvas Pen"
            >
              <Pencil size={14} />
            </button>
            {activeTool === "draw" && (
              <input
                type="color"
                value={activeDrawingColor}
                onChange={(e) => setActiveDrawingColor(e.target.value)}
                style={{ width: 24, height: 24, padding: 0, border: "none", cursor: "pointer", background: "none" }}
              />
            )}
          </div>

          <div style={{ width: 1, height: 20, background: "var(--border-color)", margin: "0 4px" }} />

          {/* Fit Content */}
          <button type="button" className="btn" onClick={handleFitContent} title="Fit Content to View">
            <Maximize2 size={14} /> Fit
          </button>

          {/* Undo / Redo */}
          <button
            type="button"
            className="btn btn-icon"
            disabled={boardState.historyIndex <= 0}
            onClick={() => dispatch({ type: "UNDO" })}
            title="Undo"
          >
            <Undo2 size={14} />
          </button>
          <button
            type="button"
            className="btn btn-icon"
            disabled={boardState.historyIndex >= boardState.history.length - 1}
            onClick={() => dispatch({ type: "REDO" })}
            title="Redo"
          >
            <Redo2 size={14} />
          </button>
        </div>

        {/* Right Tools: Duplicate, Reorder, Delete Selected */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {selectedIds.length > 0 && (
            <>
              <button type="button" className="btn btn-icon" onClick={handleDuplicateSelected} title="Duplicate Selected">
                <Copy size={14} />
              </button>
              <button type="button" className="btn btn-icon" onClick={() => handleReorder("front")} title="Bring to Front">
                <ArrowUp size={14} />
              </button>
              <button type="button" className="btn btn-icon" onClick={() => handleReorder("back")} title="Send to Back">
                <ArrowDown size={14} />
              </button>
              <button
                type="button"
                className="btn btn-icon btn-danger"
                onClick={handleDeleteSelected}
                title="Remove from Board"
              >
                <Trash2 size={14} />
              </button>
            </>
          )}

          <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            {Math.round(boardState.doc.viewport.scale * 100)}%
          </span>
        </div>
      </div>

      {/* Main Canvas Area */}
      <div
        ref={containerRef}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        style={{
          flex: 1,
          position: "relative",
          overflow: "hidden",
          background: "#090b10",
          cursor: activeTool === "draw" ? "crosshair" : "default",
        }}
      >
        <Stage
          ref={stageRef}
          width={stageDimensions.width}
          height={stageDimensions.height}
          scaleX={boardState.doc.viewport.scale}
          scaleY={boardState.doc.viewport.scale}
          x={boardState.doc.viewport.x}
          y={boardState.doc.viewport.y}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
        >
          <Layer>
            {/* Render Items */}
            {sortedItems.map((item) => (
              <BoardItemRenderer
                key={item.id}
                item={item}
                media={
                  item.type === "image" || item.type === "video" ? mediaMap.get(item.mediaId) : undefined
                }
                isSelected={selectedIds.includes(item.id)}
                onSelect={(e) => {
                  e.cancelBubble = true;
                  if (e.evt.shiftKey) {
                    setSelectedIds((prev) => (prev.includes(item.id) ? prev.filter((id) => id !== item.id) : [...prev, item.id]));
                  } else {
                    setSelectedIds([item.id]);
                  }
                }}
                onDragEnd={(e) => {
                  const updated: BoardItem = {
                    ...item,
                    x: Math.round(e.target.x()),
                    y: Math.round(e.target.y()),
                  };
                  dispatch({ type: "UPDATE_ITEMS", items: [updated] });
                }}
                onTransformEnd={(e) => {
                  const node = e.target;
                  const scaleX = node.scaleX();
                  const scaleY = node.scaleY();
                  node.scaleX(1);
                  node.scaleY(1);

                  const updated: BoardItem = {
                    ...item,
                    x: Math.round(node.x()),
                    y: Math.round(node.y()),
                    width: Math.max(20, Math.round(node.width() * scaleX)),
                    height: Math.max(20, Math.round(node.height() * scaleY)),
                    rotation: Math.round(node.rotation()),
                  };
                  dispatch({ type: "UPDATE_ITEMS", items: [updated] });
                }}
                onDoubleClick={() => {
                  if (item.type === "video") {
                    setActiveVideoId(item.id);
                  } else if (item.type === "image") {
                    openMediaInPlayer(item.mediaId);
                  } else if (item.type === "text" || item.type === "note") {
                    setEditingTextItem({
                      id: item.id,
                      text: item.text,
                      x: item.x,
                      y: item.y,
                      width: item.width,
                      height: item.height,
                    });
                  }
                }}
              />
            ))}

            {/* Currently drawing active line */}
            {isDrawing && currentLine.length > 1 && (
              <KonvaLine
                points={currentLine.flatMap((p) => [p.x, p.y])}
                stroke={activeDrawingColor}
                strokeWidth={4 / boardState.doc.viewport.scale}
                tension={0.5}
                lineCap="round"
                lineJoin="round"
              />
            )}

            {/* Transformer for selected items */}
            <Transformer
              ref={transformerRef}
              boundBoxFunc={(oldBox: Box, newBox: Box) => {
                if (newBox.width < 20 || newBox.height < 20) {
                  return oldBox;
                }
                return newBox;
              }}
              rotateEnabled={true}
              anchorFill="#3b82f6"
              anchorStroke="#ffffff"
              borderStroke="#3b82f6"
            />
          </Layer>
        </Stage>

        {/* Aligned HTML Overlay for Double-Clicked Active Video Tile */}
        {activeVideoId && (() => {
          const item = boardState.doc.items.find((i) => i.id === activeVideoId && i.type === "video") as BoardMediaItem | undefined;
          if (!item) return null;
          const view = boardState.doc.viewport;
          const screenX = item.x * view.scale + view.x;
          const screenY = item.y * view.scale + view.y;
          const screenW = item.width * view.scale;
          const screenH = item.height * view.scale;
          const media = mediaMap.get(item.mediaId);
          const videoSrc = media?.hasProxy ? getProxyAssetUrl(media.id) : getMediaAssetUrl(item.mediaId);

          return (
            <div
              style={{
                position: "absolute",
                left: screenX,
                top: screenY,
                width: screenW,
                height: screenH,
                zIndex: 50,
                background: "#000",
                boxShadow: "0 8px 32px rgba(0,0,0,0.8)",
                borderRadius: 4,
                overflow: "hidden",
                border: "2px solid var(--accent)",
              }}
            >
              <div style={{ position: "absolute", top: 4, right: 4, zIndex: 60 }}>
                <button
                  type="button"
                  className="btn btn-icon"
                  style={{ background: "rgba(0,0,0,0.7)", border: "none", color: "#fff" }}
                  onClick={() => setActiveVideoId(null)}
                  title="Close Playback"
                >
                  <X size={14} />
                </button>
              </div>
              <video
                src={videoSrc}
                controls
                autoPlay
                style={{ width: "100%", height: "100%", objectFit: "contain" }}
              />
            </div>
          );
        })()}

        {/* Accessible Inline HTML Text Editing Overlay for Text/Note */}
        {editingTextItem && (() => {
          const view = boardState.doc.viewport;
          const screenX = editingTextItem.x * view.scale + view.x;
          const screenY = editingTextItem.y * view.scale + view.y;
          const screenW = editingTextItem.width * view.scale;
          const screenH = editingTextItem.height * view.scale;

          return (
            <div
              style={{
                position: "absolute",
                left: screenX,
                top: screenY,
                width: Math.max(160, screenW),
                height: Math.max(80, screenH),
                zIndex: 60,
              }}
            >
              <textarea
                autoFocus
                value={editingTextItem.text}
                onChange={(e) => setEditingTextItem((prev) => prev ? { ...prev, text: e.target.value } : null)}
                onBlur={() => {
                  const targetItem = boardState.doc?.items.find((i) => i.id === editingTextItem.id);
                  if (targetItem && (targetItem.type === "text" || targetItem.type === "note")) {
                    dispatch({
                      type: "UPDATE_ITEMS",
                      items: [{ ...targetItem, text: editingTextItem.text }],
                    });
                  }
                  setEditingTextItem(null);
                }}
                className="input-text"
                style={{
                  width: "100%",
                  height: "100%",
                  resize: "none",
                  fontSize: 14,
                  lineHeight: 1.4,
                  background: "var(--bg-secondary)",
                  color: "var(--text-primary)",
                  boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
                }}
              />
            </div>
          );
        })()}
      </div>
    </div>
  );
};

// Item Renderer within Konva Stage
interface ItemRendererProps {
  item: BoardItem;
  media?: MediaItem;
  isSelected: boolean;
  onSelect: (e: KonvaEventObject<MouseEvent | TouchEvent>) => void;
  onDragEnd: (e: KonvaEventObject<DragEvent>) => void;
  onTransformEnd: (e: KonvaEventObject<Event>) => void;
  onDoubleClick: () => void;
}

const BoardItemRenderer: React.FC<ItemRendererProps> = ({
  item,
  media,
  isSelected,
  onSelect,
  onDragEnd,
  onTransformEnd,
  onDoubleClick,
}) => {
  const [imageObj, setImageObj] = useState<HTMLImageElement | null>(null);

  // Load thumbnail image for media items
  useEffect(() => {
    if (item.type === "image" || item.type === "video") {
      const img = new window.Image();
      img.src = getThumbnailUrl(item.mediaId);
      img.onload = () => setImageObj(img);
    }
  }, [item]);

  const isMissing = (item.type === "image" || item.type === "video") && (!media || media.missing);

  return (
    <Group
      id={`item-${item.id}`}
      x={item.x}
      y={item.y}
      width={item.width}
      height={item.height}
      rotation={item.rotation}
      draggable={true}
      onClick={onSelect}
      onTap={onSelect}
      onDragEnd={onDragEnd}
      onTransformEnd={onTransformEnd}
      onDblClick={onDoubleClick}
    >
      {/* Sticky Note */}
      {item.type === "note" && (
        <>
          <Rect
            width={item.width}
            height={item.height}
            fill={item.color || "#fef08a"}
            shadowColor="rgba(0,0,0,0.3)"
            shadowBlur={8}
            shadowOffset={{ x: 2, y: 3 }}
            shadowOpacity={0.6}
            cornerRadius={4}
          />
          <KonvaText
            x={12}
            y={12}
            width={item.width - 24}
            height={item.height - 24}
            text={item.text}
            fontSize={14}
            fill="#1e293b"
            wrap="word"
            fontFamily="sans-serif"
          />
        </>
      )}

      {/* Text Item */}
      {item.type === "text" && (
        <KonvaText
          width={item.width}
          height={item.height}
          text={item.text}
          fontSize={item.fontSize || 24}
          fill={item.color || "#ffffff"}
          fontStyle="bold"
          wrap="word"
          fontFamily="sans-serif"
        />
      )}

      {/* Drawing Item */}
      {item.type === "drawing" && (
        <KonvaLine
          points={item.points.flatMap((p) => [p.x, p.y])}
          stroke={item.color}
          strokeWidth={item.strokeWidth}
          tension={0.5}
          lineCap="round"
          lineJoin="round"
        />
      )}

      {/* Media Tile (Image or Video) */}
      {(item.type === "image" || item.type === "video") && (
        <>
          {/* Background card */}
          <Rect
            width={item.width}
            height={item.height}
            fill="#161a23"
            stroke={isSelected ? "#3b82f6" : "#272d3d"}
            strokeWidth={isSelected ? 2 : 1}
            cornerRadius={4}
            shadowColor="rgba(0,0,0,0.4)"
            shadowBlur={6}
          />

          {/* Render thumbnail if available */}
          {imageObj && !isMissing && (
            <KonvaImage
              image={imageObj}
              width={item.width}
              height={item.height}
              cornerRadius={4}
            />
          )}

          {/* Missing Media labeled indicator */}
          {isMissing && (
            <>
              <Rect
                width={item.width}
                height={item.height}
                fill="rgba(239, 68, 68, 0.15)"
                stroke="#ef4444"
                strokeWidth={2}
                cornerRadius={4}
              />
              <KonvaText
                x={10}
                y={item.height / 2 - 16}
                width={item.width - 20}
                text="Missing Media&#10;Original File Disappeared"
                align="center"
                fontSize={12}
                fontStyle="bold"
                fill="#ef4444"
              />
            </>
          )}

          {/* Video play badge */}
          {item.type === "video" && !isMissing && (
            <Group x={item.width / 2 - 16} y={item.height / 2 - 16}>
              <Rect
                width={32}
                height={32}
                fill="rgba(0,0,0,0.7)"
                cornerRadius={16}
              />
              <KonvaText
                x={11}
                y={8}
                text="▶"
                fontSize={14}
                fill="#ffffff"
              />
            </Group>
          )}
        </>
      )}
    </Group>
  );
};
