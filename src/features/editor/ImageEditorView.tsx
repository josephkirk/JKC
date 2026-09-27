import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  FilePlus,
  FolderOpen,
  Download,
  Crop as CropIcon,
  Pencil,
  Eraser,
  Eye,
  EyeOff,
  Plus,
  Trash2,
  Copy,
  ArrowUp,
  ArrowDown,
  Undo2,
  Redo2,
  Maximize2,
  ZoomIn,
  ZoomOut,
  Check,
  X,
  Layers,
} from "lucide-react";
import { useApp } from "../../context/AppContext.tsx";
import { api, getEditorAssetUrl, getThumbnailUrl } from "../../lib/api.ts";
import { QueuedDocumentWriter } from "../../lib/queuedWriter.ts";
import type { EditorDocument, EditorLayer, EditorSummary, MediaItem } from "../../lib/contracts.ts";
interface UndoStep {
  doc: EditorDocument;
  layerData: Map<string, ImageData>;
}

export const ImageEditorView: React.FC = () => {
  const {
    activeEditorId,
    setActiveEditorId,
    setSaveStatus,
    setSaveErrorMessage,
    registerSaveFlusher,
  } = useApp();

  const [editorsList, setEditorsList] = useState<EditorSummary[]>([]);
  const [doc, setDoc] = useState<EditorDocument | null>(null);
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null);

  // Tools: brush, eraser, crop
  const [tool, setTool] = useState<"brush" | "eraser" | "crop">("brush");
  const [brushColor, setBrushColor] = useState("#3b82f6");
  const [brushSize, setBrushSize] = useState(12);

  // Viewport Pan/Zoom
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const isPanningRef = useRef(false);
  const lastPanPosRef = useRef({ x: 0, y: 0 });
  const spaceDownRef = useRef(false);

  // Crop State
  const [isCropping, setIsCropping] = useState(false);
  const [cropRect, setCropRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const cropStartRef = useRef<{ x: number; y: number } | null>(null);

  // Undo / Redo (capped at 50)
  const undoStackRef = useRef<UndoStep[]>([]);
  const redoStackRef = useRef<UndoStep[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // Offscreen layer canvases cache
  const layerCanvasesRef = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const [, setCanvasTick] = useState(0);

  // Modals
  const [showNewModal, setShowNewModal] = useState(false);
  const [newWidth, setNewWidth] = useState(1920);
  const [newHeight, setNewHeight] = useState(1080);
  const [newName, setNewName] = useState("Untitled Artwork");

  const [showLibraryModal, setShowLibraryModal] = useState(false);
  const [libraryImages, setLibraryImages] = useState<MediaItem[]>([]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const displayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDrawingRef = useRef(false);
  const lastDocPointRef = useRef<{ x: number; y: number } | null>(null);

  const writerRef = useRef<QueuedDocumentWriter<EditorDocument> | null>(null);
  const isDirtyRef = useRef(false);
  const currentRevisionRef = useRef(0);
  const hydratedEditorIdRef = useRef<string | null>(null);
  const loadSeqRef = useRef(0);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pendingRasterPromisesRef = useRef<Set<Promise<void>>>(new Set());

  const trackRasterCommit = useCallback((task: Promise<void>) => {
    isDirtyRef.current = true;
    pendingRasterPromisesRef.current.add(task);
    task
      .catch((err) => console.error("Raster commit error:", err))
      .finally(() => {
        pendingRasterPromisesRef.current.delete(task);
      });
  }, []);

  // Load Editors list
  const loadEditorsList = useCallback(async () => {
    try {
      const list = await api.listEditors();
      setEditorsList(list);
      if (list.length > 0 && !activeEditorId) {
        setActiveEditorId(list[0].id);
      }
    } catch (err) {
      console.error("Failed to load editors:", err);
    }
  }, [activeEditorId, setActiveEditorId]);

  useEffect(() => {
    loadEditorsList();
  }, [loadEditorsList]);

  // Load active editor document
  useEffect(() => {
    clearTimeout(saveTimeoutRef.current ?? undefined);
    if (!activeEditorId) {
      setDoc(null);
      hydratedEditorIdRef.current = null;
      return;
    }

    const seq = ++loadSeqRef.current;
    hydratedEditorIdRef.current = null;
    currentRevisionRef.current = 0;
    isDirtyRef.current = false;

    api
      .getEditor(activeEditorId)
      .then(async (loadedDoc) => {
        if (seq !== loadSeqRef.current) return;
        setDoc(loadedDoc);
        if (loadedDoc.layers.length > 0) {
          setActiveLayerId(loadedDoc.layers[0].id);
        }

        // Initialize Layer Canvases
        const newMap = new Map<string, HTMLCanvasElement>();
        for (const layer of loadedDoc.layers) {
          const c = document.createElement("canvas");
          c.width = loadedDoc.width;
          c.height = loadedDoc.height;
          const ctx = c.getContext("2d");
          if (ctx) {
            // Load layer PNG asset
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.src = getEditorAssetUrl(layer.assetId);
            await new Promise<void>((resolve) => {
              img.onload = () => {
                ctx.drawImage(img, 0, 0);
                resolve();
              };
              img.onerror = () => resolve();
            });
          }
          newMap.set(layer.id, c);
        }
        layerCanvasesRef.current = newMap;
        hydratedEditorIdRef.current = loadedDoc.id;
        isDirtyRef.current = false;
        undoStackRef.current = [];
        redoStackRef.current = [];
        setCanUndo(false);
        setCanRedo(false);
        setSaveStatus("saved");
        setCanvasTick((t) => t + 1);
      })
      .catch((err) => {
        if (seq !== loadSeqRef.current) return;
        console.error("Failed to load editor document:", err);
      });
  }, [activeEditorId, setSaveStatus]);

  // Queued Auto-Save Writer
  useEffect(() => {
    writerRef.current = new QueuedDocumentWriter<EditorDocument>(
      async (d) => {
        setSaveStatus("saving");
        await api.saveEditor(d);
      },
      (savedRevision) => {
        if (currentRevisionRef.current === savedRevision) {
          isDirtyRef.current = false;
        }
        setSaveStatus("saved");
        setSaveErrorMessage(null);
        loadEditorsList();
      },
      (err) => {
        setSaveStatus("error");
        const msg = err && typeof err === "object" && "message" in err ? String(err.message) : "Failed to save editor document";
        setSaveErrorMessage(msg);
      }
    );
  }, [setSaveStatus, setSaveErrorMessage, loadEditorsList]);

  const scheduleSave = useCallback(
    (nextDoc: EditorDocument) => {
      if (!nextDoc || hydratedEditorIdRef.current !== nextDoc.id) return;
      currentRevisionRef.current += 1;
      const rev = currentRevisionRef.current;
      isDirtyRef.current = true;
      clearTimeout(saveTimeoutRef.current ?? undefined);
      setSaveStatus("saving");
      saveTimeoutRef.current = setTimeout(async () => {
        if (writerRef.current) {
          await writerRef.current.enqueue(nextDoc, rev);
        }
      }, 500);
    },
    [setSaveStatus]
  );

  const flushSave = useCallback(async () => {
    clearTimeout(saveTimeoutRef.current ?? undefined);
    if (pendingRasterPromisesRef.current.size > 0) {
      await Promise.all(Array.from(pendingRasterPromisesRef.current));
    }
    if (isDirtyRef.current && doc && writerRef.current) {
      await writerRef.current.enqueue(doc, currentRevisionRef.current);
    }
    if (writerRef.current) {
      await writerRef.current.flush();
    }
  }, [doc]);

  useEffect(() => {
    return registerSaveFlusher(flushSave);
  }, [registerSaveFlusher, flushSave]);

  // Spacebar pan listener
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

  // Composite layers to main display canvas
  const compositeDisplay = useCallback(() => {
    const display = displayCanvasRef.current;
    if (!display || !doc) return;
    const ctx = display.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, doc.width, doc.height);

    // Draw layers from bottom to top
    for (const layer of doc.layers) {
      if (!layer.visible || layer.opacity <= 0) continue;
      const layerCanvas = layerCanvasesRef.current.get(layer.id);
      if (layerCanvas) {
        ctx.globalAlpha = layer.opacity;
        ctx.drawImage(layerCanvas, 0, 0);
      }
    }
    ctx.globalAlpha = 1.0;
  }, [doc]);

  useEffect(() => {
    compositeDisplay();
  }, [compositeDisplay, doc]);

  // Snapshot layer data for undo
  const captureUndoSnapshot = useCallback((clearRedo = true) => {
    if (!doc) return;
    const map = new Map<string, ImageData>();
    for (const layer of doc.layers) {
      const c = layerCanvasesRef.current.get(layer.id);
      if (c) {
        const ctx = c.getContext("2d");
        if (ctx) {
          map.set(layer.id, ctx.getImageData(0, 0, doc.width, doc.height));
        }
      }
    }
    const step: UndoStep = { doc: { ...doc }, layerData: map };
    undoStackRef.current.push(step);
    if (undoStackRef.current.length > 50) {
      undoStackRef.current.shift();
    }
    if (clearRedo) {
      redoStackRef.current = [];
    }
    setCanUndo(true);
    setCanRedo(redoStackRef.current.length > 0);
  }, [doc]);

  const handleUndo = useCallback(() => {
    if (undoStackRef.current.length === 0 || !doc) return;
    const prev = undoStackRef.current.pop()!;
    // Capture current for redo
    const currentMap = new Map<string, ImageData>();
    for (const layer of doc.layers) {
      const c = layerCanvasesRef.current.get(layer.id);
      if (c) {
        const ctx = c.getContext("2d");
        if (ctx) currentMap.set(layer.id, ctx.getImageData(0, 0, doc.width, doc.height));
      }
    }
    redoStackRef.current.push({ doc: { ...doc }, layerData: currentMap });

    // Restore doc and layers
    setDoc(prev.doc);
    for (const [lid, data] of prev.layerData.entries()) {
      let c = layerCanvasesRef.current.get(lid);
      if (!c || c.width !== prev.doc.width || c.height !== prev.doc.height) {
        c = document.createElement("canvas");
        c.width = prev.doc.width;
        c.height = prev.doc.height;
        layerCanvasesRef.current.set(lid, c);
      }
      const ctx = c.getContext("2d");
      if (ctx) ctx.putImageData(data, 0, 0);
    }

    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(true);

    isDirtyRef.current = true;
    setSaveStatus("saving");
    const rasterTasks: Promise<void>[] = [];
    for (const [lid] of prev.layerData.entries()) {
      const layer = prev.doc.layers.find((l) => l.id === lid);
      const c = layerCanvasesRef.current.get(lid);
      if (layer && c) {
        const dataUrl = c.toDataURL("image/png");
        rasterTasks.push(api.saveLayerRaster(layer.assetId, dataUrl).then(() => {}));
      }
    }
    const commitAll = (async () => {
      await Promise.all(rasterTasks);
      scheduleSave(prev.doc);
    })();
    trackRasterCommit(commitAll);
    compositeDisplay();
  }, [doc, compositeDisplay, scheduleSave, trackRasterCommit, setSaveStatus]);

  const handleRedo = useCallback(() => {
    if (redoStackRef.current.length === 0 || !doc) return;
    const next = redoStackRef.current.pop()!;
    captureUndoSnapshot(false);

    setDoc(next.doc);
    for (const [lid, data] of next.layerData.entries()) {
      let c = layerCanvasesRef.current.get(lid);
      if (!c || c.width !== next.doc.width || c.height !== next.doc.height) {
        c = document.createElement("canvas");
        c.width = next.doc.width;
        c.height = next.doc.height;
        layerCanvasesRef.current.set(lid, c);
      }
      const ctx = c.getContext("2d");
      if (ctx) ctx.putImageData(data, 0, 0);
    }

    setCanUndo(true);
    setCanRedo(redoStackRef.current.length > 0);

    isDirtyRef.current = true;
    setSaveStatus("saving");
    const rasterTasks: Promise<void>[] = [];
    for (const [lid] of next.layerData.entries()) {
      const layer = next.doc.layers.find((l) => l.id === lid);
      const c = layerCanvasesRef.current.get(lid);
      if (layer && c) {
        const dataUrl = c.toDataURL("image/png");
        rasterTasks.push(api.saveLayerRaster(layer.assetId, dataUrl).then(() => {}));
      }
    }
    const commitAll = (async () => {
      await Promise.all(rasterTasks);
      scheduleSave(next.doc);
    })();
    trackRasterCommit(commitAll);
    compositeDisplay();
  }, [doc, captureUndoSnapshot, compositeDisplay, scheduleSave, trackRasterCommit, setSaveStatus]);

  // Pointer event helpers for document pixel transformation
  const getDocCoordinates = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const display = displayCanvasRef.current;
    if (!display || !doc) return null;
    const rect = display.getBoundingClientRect();
    const docX = Math.floor((clientX - rect.left) / zoom);
    const docY = Math.floor((clientY - rect.top) / zoom);
    return { x: docX, y: docY };
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1 || spaceDownRef.current) {
      isPanningRef.current = true;
      lastPanPosRef.current = { x: e.clientX, y: e.clientY };
      return;
    }

    if (!doc || !activeLayerId) return;

    if (tool === "crop") {
      const pt = getDocCoordinates(e.clientX, e.clientY);
      if (pt) {
        cropStartRef.current = pt;
        setCropRect({ x: pt.x, y: pt.y, w: 0, h: 0 });
        setIsCropping(true);
      }
      return;
    }

    // Brush or Eraser drawing
    const pt = getDocCoordinates(e.clientX, e.clientY);
    if (!pt) return;

    captureUndoSnapshot();
    isDrawingRef.current = true;
    lastDocPointRef.current = pt;

    const layerCanvas = layerCanvasesRef.current.get(activeLayerId);
    if (layerCanvas) {
      const ctx = layerCanvas.getContext("2d");
      if (ctx) {
        ctx.lineWidth = brushSize;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        if (tool === "eraser") {
          ctx.globalCompositeOperation = "destination-out";
        } else {
          ctx.globalCompositeOperation = "source-over";
          ctx.strokeStyle = brushColor;
        }
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, brushSize / 2, 0, Math.PI * 2);
        if (tool === "eraser") {
          ctx.fill();
        } else {
          ctx.fillStyle = brushColor;
          ctx.fill();
        }
        compositeDisplay();
      }
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isPanningRef.current) {
      const dx = e.clientX - lastPanPosRef.current.x;
      const dy = e.clientY - lastPanPosRef.current.y;
      lastPanPosRef.current = { x: e.clientX, y: e.clientY };
      setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
      return;
    }

    if (isCropping && cropStartRef.current) {
      const pt = getDocCoordinates(e.clientX, e.clientY);
      if (pt) {
        const start = cropStartRef.current;
        const x = Math.min(start.x, pt.x);
        const y = Math.min(start.y, pt.y);
        const w = Math.abs(pt.x - start.x);
        const h = Math.abs(pt.y - start.y);
        setCropRect({ x, y, w, h });
      }
      return;
    }

    if (!isDrawingRef.current || !lastDocPointRef.current || !activeLayerId || !doc) return;
    const pt = getDocCoordinates(e.clientX, e.clientY);
    if (!pt) return;

    const layerCanvas = layerCanvasesRef.current.get(activeLayerId);
    if (layerCanvas) {
      const ctx = layerCanvas.getContext("2d");
      if (ctx) {
        ctx.lineWidth = brushSize;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        if (tool === "eraser") {
          ctx.globalCompositeOperation = "destination-out";
        } else {
          ctx.globalCompositeOperation = "source-over";
          ctx.strokeStyle = brushColor;
        }
        ctx.beginPath();
        ctx.moveTo(lastDocPointRef.current.x, lastDocPointRef.current.y);
        ctx.lineTo(pt.x, pt.y);
        ctx.stroke();
        lastDocPointRef.current = pt;
        compositeDisplay();
      }
    }
  };

  const handleMouseUp = async () => {
    isPanningRef.current = false;
    if (isCropping) {
      setIsCropping(false);
      return;
    }

    if (isDrawingRef.current && activeLayerId && doc) {
      isDrawingRef.current = false;
      lastDocPointRef.current = null;

      // Save raster asset to app data
      const layer = doc.layers.find((l) => l.id === activeLayerId);
      const layerCanvas = layerCanvasesRef.current.get(activeLayerId);
      if (layer && layerCanvas) {
        isDirtyRef.current = true;
        setSaveStatus("saving");
        const dataUrl = layerCanvas.toDataURL("image/png");
        const commitPromise = (async () => {
          await api.saveLayerRaster(layer.assetId, dataUrl);
          scheduleSave(doc);
        })();
        trackRasterCommit(commitPromise);
      }
    }
  };

  // Apply Crop across ALL layers
  const handleApplyCrop = async () => {
    if (!doc || !cropRect || cropRect.w <= 0 || cropRect.h <= 0) return;
    captureUndoSnapshot();

    const { x, y, w, h } = cropRect;
    const newLayersMap = new Map<string, HTMLCanvasElement>();

    for (const layer of doc.layers) {
      const oldCanvas = layerCanvasesRef.current.get(layer.id);
      const cropped = document.createElement("canvas");
      cropped.width = w;
      cropped.height = h;
      const ctx = cropped.getContext("2d");
      if (ctx && oldCanvas) {
        ctx.drawImage(oldCanvas, x, y, w, h, 0, 0, w, h);
      }
      newLayersMap.set(layer.id, cropped);

      // Save cropped raster
      const dataUrl = cropped.toDataURL("image/png");
      await api.saveLayerRaster(layer.assetId, dataUrl);
    }

    layerCanvasesRef.current = newLayersMap;
    const updatedDoc: EditorDocument = {
      ...doc,
      width: w,
      height: h,
    };

    setDoc(updatedDoc);
    setCropRect(null);
    setTool("brush");
    scheduleSave(updatedDoc);
    compositeDisplay();
  };

  const handleCancelCrop = () => {
    setCropRect(null);
    setTool("brush");
  };

  // Layer Operations
  const handleAddLayer = async () => {
    if (!doc) return;
    captureUndoSnapshot();

    const layerAssetId = `layer_${crypto.randomUUID()}.png`;
    const newLayer: EditorLayer = {
      id: crypto.randomUUID(),
      name: `Layer ${doc.layers.length + 1}`,
      visible: true,
      opacity: 1.0,
      assetId: layerAssetId,
    };

    const c = document.createElement("canvas");
    c.width = doc.width;
    c.height = doc.height;
    layerCanvasesRef.current.set(newLayer.id, c);

    // Save empty raster
    await api.saveLayerRaster(layerAssetId, c.toDataURL("image/png"));

    const updatedDoc: EditorDocument = {
      ...doc,
      layers: [newLayer, ...doc.layers],
    };

    setDoc(updatedDoc);
    setActiveLayerId(newLayer.id);
    scheduleSave(updatedDoc);
    compositeDisplay();
  };

  const handleDuplicateLayer = async (layerId: string) => {
    if (!doc) return;
    const srcLayer = doc.layers.find((l) => l.id === layerId);
    const srcCanvas = layerCanvasesRef.current.get(layerId);
    if (!srcLayer || !srcCanvas) return;

    captureUndoSnapshot();
    const newAssetId = `layer_${crypto.randomUUID()}.png`;
    const clonedLayer: EditorLayer = {
      ...srcLayer,
      id: crypto.randomUUID(),
      name: `${srcLayer.name} Copy`,
      assetId: newAssetId,
    };

    const clonedCanvas = document.createElement("canvas");
    clonedCanvas.width = doc.width;
    clonedCanvas.height = doc.height;
    const ctx = clonedCanvas.getContext("2d");
    if (ctx) ctx.drawImage(srcCanvas, 0, 0);
    layerCanvasesRef.current.set(clonedLayer.id, clonedCanvas);

    await api.saveLayerRaster(newAssetId, clonedCanvas.toDataURL("image/png"));

    const idx = doc.layers.findIndex((l) => l.id === layerId);
    const newLayers = [...doc.layers];
    newLayers.splice(idx, 0, clonedLayer);

    const updatedDoc: EditorDocument = { ...doc, layers: newLayers };
    setDoc(updatedDoc);
    setActiveLayerId(clonedLayer.id);
    scheduleSave(updatedDoc);
    compositeDisplay();
  };

  const handleDeleteLayer = (layerId: string) => {
    if (!doc) return;
    captureUndoSnapshot();

    let newLayers = doc.layers.filter((l) => l.id !== layerId);
    // Keep at least one layer by replacing final deleted layer with an empty one
    if (newLayers.length === 0) {
      const blankAssetId = `layer_${crypto.randomUUID()}.png`;
      const blankLayer: EditorLayer = {
        id: crypto.randomUUID(),
        name: "Layer 1",
        visible: true,
        opacity: 1.0,
        assetId: blankAssetId,
      };
      const c = document.createElement("canvas");
      c.width = doc.width;
      c.height = doc.height;
      layerCanvasesRef.current.set(blankLayer.id, c);
      api.saveLayerRaster(blankAssetId, c.toDataURL("image/png")).catch(console.error);
      newLayers = [blankLayer];
    }

    const updatedDoc: EditorDocument = { ...doc, layers: newLayers };
    setDoc(updatedDoc);
    setActiveLayerId(newLayers[0].id);
    scheduleSave(updatedDoc);
    compositeDisplay();
  };

  const handleReorderLayer = (layerId: string, direction: "up" | "down") => {
    if (!doc) return;
    const idx = doc.layers.findIndex((l) => l.id === layerId);
    if (idx === -1) return;
    if (direction === "up" && idx === 0) return;
    if (direction === "down" && idx === doc.layers.length - 1) return;

    captureUndoSnapshot();
    const newLayers = [...doc.layers];
    const targetIdx = direction === "up" ? idx - 1 : idx + 1;
    const [moved] = newLayers.splice(idx, 1);
    newLayers.splice(targetIdx, 0, moved);

    const updatedDoc: EditorDocument = { ...doc, layers: newLayers };
    setDoc(updatedDoc);
    scheduleSave(updatedDoc);
    compositeDisplay();
  };

  const handleToggleVisibility = (layerId: string) => {
    if (!doc) return;
    const updatedLayers = doc.layers.map((l) => (l.id === layerId ? { ...l, visible: !l.visible } : l));
    const updatedDoc = { ...doc, layers: updatedLayers };
    setDoc(updatedDoc);
    scheduleSave(updatedDoc);
    compositeDisplay();
  };

  const handleOpacityChange = (layerId: string, opacity: number) => {
    if (!doc) return;
    const updatedLayers = doc.layers.map((l) => (l.id === layerId ? { ...l, opacity } : l));
    const updatedDoc = { ...doc, layers: updatedLayers };
    setDoc(updatedDoc);
    scheduleSave(updatedDoc);
    compositeDisplay();
  };

  // Export Flattened Image
  const handleExportImage = async (format: "png" | "jpeg") => {
    if (!doc) return;
    const ext = format === "jpeg" ? "jpg" : "png";
    const defaultName = `${doc.name}.${ext}`;
    const target = await api.saveFile(defaultName, [{ name: format.toUpperCase(), extensions: [ext] }]);
    if (!target) return;

    try {
      await api.exportEditorComposite({
        editorId: doc.id,
        format,
        targetPath: target,
        quality: 0.92,
      });
      alert(`Exported composite ${format.toUpperCase()} successfully.`);
    } catch (err) {
      console.error("Failed to export image:", err);
      alert(err && typeof err === "object" && "message" in err ? String(err.message) : "Failed to export image");
    }
  };
  const handleSwitchEditor = async (newId: string) => {
    if (newId === activeEditorId) return;
    try {
      await flushSave();
    } catch (err) {
      console.warn("Editor switch aborted due to save error:", err);
      return;
    }
    setActiveEditorId(newId);
  };

  // Create New Document Handler
  const handleCreateNewDocument = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newWidth <= 0 || newHeight <= 0) {
      alert("Dimensions must be positive integers.");
      return;
    }
    if (newWidth * newHeight > 16_777_216) {
      alert("Total pixels exceed maximum limit of 16,777,216.");
      return;
    }

    try {
      await flushSave();
    } catch (err) {
      console.warn("Create document aborted due to save error:", err);
      return;
    }

    try {
      const newDoc = await api.createEditor(newName.trim() || "Untitled", newWidth, newHeight);
      setShowNewModal(false);
      await loadEditorsList();
      setActiveEditorId(newDoc.id);
    } catch (err) {
      console.error("Failed to create document:", err);
      alert(err && typeof err === "object" && "message" in err ? String(err.message) : "Failed to create document");
    }
  };

  // Open Image from Library Handler
  const handleOpenFromLibrary = async (mediaId: string) => {
    try {
      await flushSave();
    } catch (err) {
      console.warn("Import from library aborted due to save error:", err);
      return;
    }

    try {
      const newDoc = await api.createEditorFromMedia(mediaId);
      setShowLibraryModal(false);
      await loadEditorsList();
      setActiveEditorId(newDoc.id);
    } catch (err) {
      console.error("Failed to import image into editor:", err);
      alert(err && typeof err === "object" && "message" in err ? String(err.message) : "Failed to import image");
    }
  };
  const handleLibraryDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const primaryId = e.dataTransfer.getData("application/jkc-media-id");
    let mediaId = primaryId;
    if (!mediaId) {
      const plain = e.dataTransfer.getData("text/plain");
      if (plain.startsWith("jkc-media:")) {
        try {
          const parsed = JSON.parse(plain.slice("jkc-media:".length));
          if (Array.isArray(parsed) && typeof parsed[0] === "string") mediaId = parsed[0];
        } catch {
          // Ignore unrelated text drops.
        }
      }
    }
    if (!mediaId) return;
    try {
      const media = await api.getMedia(mediaId);
      if (media.kind !== "image") {
        alert("Image Editor accepts image assets. Drop an image from Library.");
        return;
      }
      await handleOpenFromLibrary(media.id);
    } catch (err) {
      console.error("Failed to import dropped library asset:", err);
    }
  };

  const handleLibraryDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  return (
    <div style={{ display: "flex", flex: 1, height: "100%", overflow: "hidden" }}>
      {/* Center Image Workspace */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
        {/* Top Editor Toolbar */}
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
          {/* Document Switcher & New / Open */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <select
              value={activeEditorId || ""}
              onChange={(e) => handleSwitchEditor(e.target.value)}
              className="input-text"
              style={{ fontWeight: 600, padding: "4px 8px" }}
            >
              {editorsList.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} ({e.width}×{e.height})
                </option>
              ))}
            </select>

            <button type="button" className="btn" onClick={() => setShowNewModal(true)} title="New Artwork">
              <FilePlus size={14} /> New...
            </button>

            <button
              type="button"
              className="btn"
              onClick={async () => {
                const res = await api.queryMedia({ kind: "image", page: 0, pageSize: 50 });
                setLibraryImages(res.items);
                setShowLibraryModal(true);
              }}
              title="Open Image from Library"
            >
              <FolderOpen size={14} /> Library...
            </button>
          </div>

          {/* Center Tools: Brush, Eraser, Crop, Undo/Redo, Zoom */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              className={`btn btn-icon ${tool === "brush" ? "btn-primary" : ""}`}
              onClick={() => setTool("brush")}
              title="Paint Brush"
            >
              <Pencil size={14} />
            </button>

            <button
              type="button"
              className={`btn btn-icon ${tool === "eraser" ? "btn-primary" : ""}`}
              onClick={() => setTool("eraser")}
              title="Eraser (destination-out)"
            >
              <Eraser size={14} />
            </button>

            {tool !== "crop" && (
              <>
                <input
                  type="color"
                  value={brushColor}
                  onChange={(e) => setBrushColor(e.target.value)}
                  style={{ width: 24, height: 24, padding: 0, border: "none", cursor: "pointer", background: "none" }}
                  title="Brush Color"
                />
                <input
                  type="range"
                  min={1}
                  max={80}
                  value={brushSize}
                  onChange={(e) => setBrushSize(Number(e.target.value))}
                  style={{ width: 70, accentColor: "var(--accent)" }}
                  title={`Size: ${brushSize}px`}
                />
                <span style={{ fontSize: 11, color: "var(--text-muted)", width: 28 }}>{brushSize}px</span>
              </>
            )}

            <div style={{ width: 1, height: 18, background: "var(--border-color)", margin: "0 2px" }} />

            {/* Crop Button */}
            <button
              type="button"
              className={`btn ${tool === "crop" ? "btn-primary" : ""}`}
              onClick={() => {
                setTool("crop");
                setCropRect({ x: 50, y: 50, w: Math.max(100, (doc?.width || 800) - 100), h: Math.max(100, (doc?.height || 600) - 100) });
              }}
              title="Crop Canvas Dimensions"
            >
              <CropIcon size={14} /> Crop
            </button>

            {/* Crop Apply/Cancel */}
            {tool === "crop" && cropRect && (
              <div style={{ display: "flex", gap: 4 }}>
                <button type="button" className="btn btn-primary" onClick={handleApplyCrop} title="Apply Crop Rectangle">
                  <Check size={14} /> Apply ({cropRect.w}×{cropRect.h})
                </button>
                <button type="button" className="btn btn-danger" onClick={handleCancelCrop} title="Cancel Crop">
                  <X size={14} />
                </button>
              </div>
            )}

            <div style={{ width: 1, height: 18, background: "var(--border-color)", margin: "0 2px" }} />

            {/* Undo / Redo */}
            <button type="button" className="btn btn-icon" disabled={!canUndo} onClick={handleUndo} title="Undo">
              <Undo2 size={14} />
            </button>
            <button type="button" className="btn btn-icon" disabled={!canRedo} onClick={handleRedo} title="Redo">
              <Redo2 size={14} />
            </button>

            {/* Zoom Controls */}
            <button type="button" className="btn btn-icon" onClick={() => setZoom((z) => Math.max(0.1, z - 0.2))} title="Zoom Out">
              <ZoomOut size={14} />
            </button>
            <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
              {Math.round(zoom * 100)}%
            </span>
            <button type="button" className="btn btn-icon" onClick={() => setZoom((z) => Math.min(5, z + 0.2))} title="Zoom In">
              <ZoomIn size={14} />
            </button>
            <button type="button" className="btn btn-icon" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} title="Reset 100%">
              <Maximize2 size={14} />
            </button>
          </div>

          {/* Right Export Buttons */}
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" className="btn" onClick={() => handleExportImage("png")} title="Export as PNG with transparency">
              <Download size={14} /> Export PNG
            </button>
            <button type="button" className="btn" onClick={() => handleExportImage("jpeg")} title="Export as JPEG (0.92 quality)">
              <Download size={14} /> Export JPEG
            </button>
          </div>
        </div>

        {/* Canvas Display Viewport */}
        <div
          ref={containerRef}
          onDragOver={handleLibraryDragOver}
          onDrop={handleLibraryDrop}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          style={{
            flex: 1,
            position: "relative",
            overflow: "hidden",
            background: "#080a0f",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: spaceDownRef.current ? "grab" : tool === "brush" || tool === "eraser" ? "crosshair" : "default",
          }}
        >
          {doc && (
            <div
              style={{
                position: "relative",
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: "center center",
                boxShadow: "0 10px 40px rgba(0,0,0,0.8)",
                border: "1px solid #334155",
                background: "repeating-conic-gradient(#1e293b 0% 25%, #0f172a 0% 50%) 50% / 20px 20px",
                width: doc.width,
                height: doc.height,
              }}
            >
              <canvas
                ref={displayCanvasRef}
                width={doc.width}
                height={doc.height}
                style={{ width: "100%", height: "100%", display: "block" }}
              />

              {/* Crop Overlay Rectangle */}
              {tool === "crop" && cropRect && (
                <div
                  style={{
                    position: "absolute",
                    left: cropRect.x,
                    top: cropRect.y,
                    width: cropRect.w,
                    height: cropRect.h,
                    border: "2px dashed #3b82f6",
                    background: "rgba(59, 130, 246, 0.15)",
                    pointerEvents: "none",
                  }}
                />
              )}
            </div>
          )}
        </div>
      </div>

      {/* Right Layers Panel */}
      {doc && (
        <aside
          style={{
            width: 280,
            minWidth: 280,
            background: "var(--bg-secondary)",
            borderLeft: "1px solid var(--border-color)",
            display: "flex",
            flexDirection: "column",
            height: "100%",
          }}
        >
          {/* Layers Header */}
          <div
            style={{
              padding: "12px 16px",
              borderBottom: "1px solid var(--border-color)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, fontSize: 13 }}>
              <Layers size={16} /> Layers ({doc.layers.length})
            </div>
            <button type="button" className="btn btn-icon btn-primary" onClick={handleAddLayer} title="Add New Layer">
              <Plus size={14} />
            </button>
          </div>

          {/* Layer List (Top to Bottom) */}
          <div style={{ flex: 1, overflowY: "auto", padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            {doc.layers.map((layer) => (
              <div
                key={layer.id}
                onClick={() => setActiveLayerId(layer.id)}
                style={{
                  padding: 8,
                  borderRadius: 6,
                  background: activeLayerId === layer.id ? "var(--bg-active)" : "var(--bg-tertiary)",
                  border: `1px solid ${activeLayerId === layer.id ? "var(--accent)" : "var(--border-color)"}`,
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {/* Visibility Toggle */}
                  <button
                    type="button"
                    style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 2 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleToggleVisibility(layer.id);
                    }}
                    title={layer.visible ? "Hide Layer" : "Show Layer"}
                  >
                    {layer.visible ? <Eye size={15} color="var(--text-primary)" /> : <EyeOff size={15} />}
                  </button>

                  <span style={{ flex: 1, fontSize: 12, fontWeight: 500, color: "var(--text-primary)" }}>
                    {layer.name}
                  </span>

                  {/* Actions: Up, Down, Duplicate, Delete */}
                  <button
                    type="button"
                    style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 2 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleReorderLayer(layer.id, "up");
                    }}
                    title="Move Layer Up"
                  >
                    <ArrowUp size={12} />
                  </button>
                  <button
                    type="button"
                    style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 2 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleReorderLayer(layer.id, "down");
                    }}
                    title="Move Layer Down"
                  >
                    <ArrowDown size={12} />
                  </button>
                  <button
                    type="button"
                    style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 2 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDuplicateLayer(layer.id);
                    }}
                    title="Duplicate Layer"
                  >
                    <Copy size={12} />
                  </button>
                  <button
                    type="button"
                    style={{ background: "none", border: "none", color: "var(--danger)", cursor: "pointer", padding: 2 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteLayer(layer.id);
                    }}
                    title="Delete Layer"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>

                {/* Opacity slider */}
                <div style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 22 }}>
                  <span style={{ fontSize: 10, color: "var(--text-muted)" }}>Opacity:</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={layer.opacity}
                    onChange={(e) => handleOpacityChange(layer.id, Number(e.target.value))}
                    style={{ flex: 1, accentColor: "var(--accent)", height: 4 }}
                  />
                  <span style={{ fontSize: 10, color: "var(--text-muted)", width: 28, textAlign: "right" }}>
                    {Math.round(layer.opacity * 100)}%
                  </span>
                </div>
              </div>
            ))}
          </div>

          {/* Layer Panel Footer Info */}
          <div
            style={{
              padding: "10px 16px",
              borderTop: "1px solid var(--border-color)",
              fontSize: 11,
              color: "var(--text-muted)",
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <span>Dimensions</span>
            <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>
              {doc.width} × {doc.height} px
            </span>
          </div>
        </aside>
      )}

      {/* New Artwork Modal */}
      {showNewModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.75)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
          }}
        >
          <form
            onSubmit={handleCreateNewDocument}
            style={{
              width: 360,
              background: "var(--bg-secondary)",
              border: "1px solid var(--border-color)",
              borderRadius: 8,
              padding: 24,
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}
          >
            <h3 style={{ fontSize: 16, fontWeight: 600 }}>Create New Artwork</h3>

            <div>
              <label style={{ fontSize: 12, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
                Document Name
              </label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="input-text"
                style={{ width: "100%" }}
              />
            </div>

            <div style={{ display: "flex", gap: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
                  Width (px)
                </label>
                <input
                  type="number"
                  min={1}
                  max={4096}
                  value={newWidth}
                  onChange={(e) => setNewWidth(Number(e.target.value))}
                  className="input-text"
                  style={{ width: "100%" }}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
                  Height (px)
                </label>
                <input
                  type="number"
                  min={1}
                  max={4096}
                  value={newHeight}
                  onChange={(e) => setNewHeight(Number(e.target.value))}
                  className="input-text"
                  style={{ width: "100%" }}
                />
              </div>
            </div>

            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
              Total pixels: {(newWidth * newHeight).toLocaleString()} / 16,777,216 limit
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
              <button type="button" className="btn" onClick={() => setShowNewModal(false)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary">
                Create
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Open Image from Library Modal */}
      {showLibraryModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.75)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
          }}
        >
          <div
            style={{
              width: 540,
              maxHeight: "80vh",
              background: "var(--bg-secondary)",
              border: "1px solid var(--border-color)",
              borderRadius: 8,
              padding: 24,
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ fontSize: 16, fontWeight: 600 }}>Open Image from Library</h3>
              <button type="button" className="btn btn-icon" onClick={() => setShowLibraryModal(false)}>
                <X size={16} />
              </button>
            </div>

            <div
              style={{
                flex: 1,
                overflowY: "auto",
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 12,
                maxHeight: 400,
              }}
            >
              {libraryImages.map((img) => (
                <div
                  key={img.id}
                  onClick={() => handleOpenFromLibrary(img.id)}
                  style={{
                    background: "var(--bg-tertiary)",
                    borderRadius: 6,
                    border: "1px solid var(--border-color)",
                    padding: 8,
                    cursor: "pointer",
                    textAlign: "center",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <img
                    src={getThumbnailUrl(img.id)}
                    alt={img.name}
                    style={{ width: "100%", height: 80, objectFit: "contain", borderRadius: 4 }}
                    onError={(e) => {
                      (e.target as HTMLElement).style.display = "none";
                    }}
                  />
                  <div style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", width: "100%" }}>
                    {img.name}
                  </div>
                </div>
              ))}
              {libraryImages.length === 0 && (
                <div style={{ gridColumn: "1 / -1", textAlign: "center", color: "var(--text-muted)", padding: 24 }}>
                  No images in library. Add a folder to Library first.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
