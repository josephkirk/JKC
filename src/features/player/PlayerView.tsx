import React, { useState, useEffect, useRef, useCallback, useReducer } from "react";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  RotateCcw,
  Camera,
  Download,
  Flame,
  MessageSquare,
  Scissors,
  Repeat,
  Plus,
  Trash2,
  Pencil,
  Square,
  Type,
  Minus,
  ZoomIn,
  ZoomOut,
  Undo2,
  Redo2,
  AlertCircle,
  Loader2,
  Sparkles,
  Film,
  X,
} from "lucide-react";
import { Stage, Layer, Line as KonvaLine, Rect as KonvaRect, Text as KonvaText } from "react-konva";
import type { KonvaEventObject } from "konva/lib/Node";
import { useApp } from "../../context/AppContext.tsx";
import { api, getMediaAssetUrl, getProxyAssetUrl } from "../../lib/api.ts";
import { getDocument } from "pdfjs-dist";
import { QueuedDocumentWriter } from "../../lib/queuedWriter.ts";
import type {
  ReviewAnnotation,
  ReviewComment,
  ReviewDocument,
  ReviewStroke,
  ReviewTake,
  StrokeTool,
} from "../../lib/contracts.ts";

interface ReviewState {
  comments: ReviewComment[];
  takes: ReviewTake[];
  shotBoundariesMs: number[];
  annotations: ReviewAnnotation[];
  annotationHistory: ReviewAnnotation[][];
  historyIndex: number;
  isDirty: boolean;
  revision: number;
}

type ReviewAction =
  | { type: "LOAD_REVIEW"; payload: ReviewDocument }
  | { type: "ADD_COMMENT"; payload: ReviewComment }
  | { type: "DELETE_COMMENT"; id: string }
  | { type: "ADD_TAKE"; payload: ReviewTake }
  | { type: "DELETE_TAKE"; id: string }
  | { type: "SET_SHOTS"; payload: number[] }
  | { type: "CONVERT_SHOT_TO_TAKE"; inMs: number; outMs: number; name: string }
  | { type: "COMMIT_STROKE"; stroke: ReviewStroke; timeMs: number }
  | { type: "UNDO_ANNOTATION" }
  | { type: "REDO_ANNOTATION" }
  | { type: "MARK_SAVED"; savedRevision: number };
const initialReviewState: ReviewState = {
  comments: [],
  takes: [],
  shotBoundariesMs: [],
  annotations: [],
  annotationHistory: [[]],
  historyIndex: 0,
  isDirty: false,
  revision: 0,
};

function reviewReducer(state: ReviewState, action: ReviewAction): ReviewState {
  switch (action.type) {
    case "LOAD_REVIEW": {
      const ann = action.payload.annotations || [];
      return {
        comments: action.payload.comments || [],
        takes: action.payload.takes || [],
        shotBoundariesMs: action.payload.shotBoundariesMs || [],
        annotations: ann,
        annotationHistory: [ann],
        historyIndex: 0,
        isDirty: false,
        revision: state.revision + 1,
      };
    }
    case "ADD_COMMENT": {
      const updated = [...state.comments, action.payload].sort((a, b) => a.timeMs - b.timeMs);
      return {
        ...state,
        comments: updated,
        isDirty: true,
        revision: state.revision + 1,
      };
    }
    case "DELETE_COMMENT": {
      return {
        ...state,
        comments: state.comments.filter((c) => c.id !== action.id),
        isDirty: true,
        revision: state.revision + 1,
      };
    }
    case "ADD_TAKE": {
      const updated = [...state.takes, action.payload].sort((a, b) => a.inMs - b.inMs);
      return {
        ...state,
        takes: updated,
        isDirty: true,
        revision: state.revision + 1,
      };
    }
    case "DELETE_TAKE": {
      return {
        ...state,
        takes: state.takes.filter((t) => t.id !== action.id),
        isDirty: true,
        revision: state.revision + 1,
      };
    }
    case "SET_SHOTS": {
      return {
        ...state,
        shotBoundariesMs: action.payload,
        isDirty: true,
        revision: state.revision + 1,
      };
    }
    case "CONVERT_SHOT_TO_TAKE": {
      const newTake: ReviewTake = {
        id: crypto.randomUUID(),
        name: action.name,
        inMs: action.inMs,
        outMs: action.outMs,
      };
      const updated = [...state.takes, newTake].sort((a, b) => a.inMs - b.inMs);
      return {
        ...state,
        takes: updated,
        isDirty: true,
        revision: state.revision + 1,
      };
    }
    case "COMMIT_STROKE": {
      const existingIdx = state.annotations.findIndex((a) => Math.abs(a.timeMs - action.timeMs) <= 17);
      let updatedAnn: ReviewAnnotation[];
      if (existingIdx >= 0) {
        updatedAnn = state.annotations.map((a, i) =>
          i === existingIdx ? { ...a, strokes: [...a.strokes, action.stroke] } : a
        );
      } else {
        const newAnn: ReviewAnnotation = {
          id: crypto.randomUUID(),
          timeMs: action.timeMs,
          strokes: [action.stroke],
        };
        updatedAnn = [...state.annotations, newAnn];
      }
      const newHist = state.annotationHistory.slice(0, state.historyIndex + 1);
      newHist.push(updatedAnn);
      return {
        ...state,
        annotations: updatedAnn,
        annotationHistory: newHist,
        historyIndex: newHist.length - 1,
        isDirty: true,
        revision: state.revision + 1,
      };
    }
    case "UNDO_ANNOTATION": {
      if (state.historyIndex > 0) {
        const nextIdx = state.historyIndex - 1;
        return {
          ...state,
          annotations: state.annotationHistory[nextIdx],
          historyIndex: nextIdx,
          isDirty: true,
          revision: state.revision + 1,
        };
      }
      return state;
    }
    case "REDO_ANNOTATION": {
      if (state.historyIndex < state.annotationHistory.length - 1) {
        const nextIdx = state.historyIndex + 1;
        return {
          ...state,
          annotations: state.annotationHistory[nextIdx],
          historyIndex: nextIdx,
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
const PdfPages: React.FC<{ url: string; name: string }> = ({ url, name }) => {
  const [pages, setPages] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPages([]);
    setError(null);
    void getDocument({ url } as any).promise.then(async (pdf) => {
      const rendered: string[] = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        if (cancelled) return;
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1.5 });
        const canvas = window.document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Could not create PDF page canvas");
        await page.render({ canvasContext: context, canvas, viewport }).promise;
        rendered.push(canvas.toDataURL("image/png"));
      }
      if (!cancelled) setPages(rendered);
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : "Failed to render PDF");
    });
    return () => { cancelled = true; };
  }, [url]);

  if (error) return <div className="empty-state"><div className="empty-state-title">PDF preview failed</div><div className="empty-state-desc">{error}</div></div>;
  if (pages.length === 0) return <div className="empty-state"><div className="empty-state-title">Loading PDF pages…</div></div>;
  return (
    <div style={{ width: "100%", height: "100%", overflow: "auto", display: "grid", gap: 16, justifyItems: "center", padding: 16 }}>
      {pages.map((page, index) => <img key={`${name}-${index}`} src={page} alt={`${name}, page ${index + 1}`} style={{ maxWidth: "100%", boxShadow: "0 2px 12px rgba(0,0,0,.45)" }} />)}
    </div>
  );
};


export interface PlayerViewProps {
  floating?: boolean;
}

export const PlayerView: React.FC<PlayerViewProps> = ({ floating = false }) => {
  const {
    activeMedia,
    closePlayerPalette,
    openMediaInPlayer,
    setSaveStatus,
    setSaveErrorMessage,
    registerSaveFlusher,
    jobs,
  } = useApp();
  const [proxyJobId, setProxyJobId] = useState<string | null>(null);
  const [hydratedMediaId, setHydratedMediaId] = useState<string | null>(null);
  const loadSeqRef = useRef(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [dialogPos, setDialogPos] = useState({ x: 160, y: 80 });
  const dragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (!dragRef.current) return;
      setDialogPos({
        x: Math.max(12, dragRef.current.left + event.clientX - dragRef.current.x),
        y: Math.max(12, dragRef.current.top + event.clientY - dragRef.current.y),
      });
    };

    const handlePointerUp = () => {
      dragRef.current = null;
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, []);

  const beginDialogDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!floating || (event.target as HTMLElement).closest("button")) return;
    dragRef.current = { x: event.clientX, y: event.clientY, left: dialogPos.x, top: dialogPos.y };
  };

  // Video State
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const [imagePreviewError, setImagePreviewError] = useState<string | null>(null);
  const [useProxy, setUseProxy] = useState(false);
  const [isGeneratingProxy, setIsGeneratingProxy] = useState(false);

  // Review Document Reducer State
  const [reviewState, dispatch] = useReducer(reviewReducer, initialReviewState);

  // Take In/Out range marker
  const [takeInMs, setTakeInMs] = useState<number | null>(null);
  const [takeOutMs, setTakeOutMs] = useState<number | null>(null);
  const [newTakeName, setNewTakeName] = useState("");
  const [loopTakeId, setLoopTakeId] = useState<string | null>(null);

  // Comment input
  const [commentText, setCommentText] = useState("");

  // Annotation Drawing Tool
  const [selectedTool, setSelectedTool] = useState<StrokeTool | "none">("none");
  const [strokeColor, setStrokeColor] = useState("#ef4444");
  const [strokeWidth, setStrokeWidth] = useState(3);
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentStroke, setCurrentStroke] = useState<ReviewStroke | null>(null);
  const [explicitAnnotationTime, setExplicitAnnotationTime] = useState<number | null>(null);

  // Image zoom state (for image media)
  const [imageZoom, setImageZoom] = useState<"fit" | "actual">("fit");

  // Export take modal
  const [exportModalTake, setExportModalTake] = useState<ReviewTake | null>(null);
  const [exportFormat, setExportFormat] = useState<"mp4" | "gif">("mp4");

  // Shot detection loading
  const [isDetectingShots, setIsDetectingShots] = useState(false);

  // Dimensions of video container for coordinate normalization
  const [stageSize, setStageSize] = useState({ width: 640, height: 360 });

  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Load Review Document when activeMedia changes
  useEffect(() => {
    clearTimeout(saveTimeoutRef.current ?? undefined);
    if (!activeMedia) {
      setHydratedMediaId(null);
      return;
    }

    const seq = ++loadSeqRef.current;
    setHydratedMediaId(null);
    setPlaybackFailed(false);
    setImagePreviewError(null);
    setUseProxy(false);
    setIsPlaying(false);
    setCurrentTimeMs(0);
    setTakeInMs(null);
    setTakeOutMs(null);
    setLoopTakeId(null);

    api
      .getReview(activeMedia.id)
      .then((doc) => {
        if (seq !== loadSeqRef.current) return;
        dispatch({ type: "LOAD_REVIEW", payload: doc });
        setHydratedMediaId(activeMedia.id);
        setSaveStatus("saved");
      })
      .catch((err) => {
        if (seq !== loadSeqRef.current) return;
        console.error("Failed to load review document:", err);
      });
  }, [activeMedia, setSaveStatus]);

  // Monitor proxy generation job completion
  useEffect(() => {
    if (!proxyJobId || !jobs[proxyJobId]) return;
    const job = jobs[proxyJobId];
    if (job.status === "completed") {
      setUseProxy(true);
      setPlaybackFailed(false);
      setIsGeneratingProxy(false);
      setProxyJobId(null);
    } else if (job.status === "failed" || job.status === "cancelled") {
      setIsGeneratingProxy(false);
      setProxyJobId(null);
      if (job.message) {
        alert(`Proxy generation failed: ${job.message}`);
      }
    }
  }, [jobs, proxyJobId]);
  const writerRef = useRef<QueuedDocumentWriter<ReviewDocument> | null>(null);

  useEffect(() => {
    writerRef.current = new QueuedDocumentWriter<ReviewDocument>(
      async (doc) => {
        setSaveStatus("saving");
        await api.saveReview(doc);
      },
      (savedRev) => {
        dispatch({ type: "MARK_SAVED", savedRevision: savedRev });
        setSaveStatus("saved");
        setSaveErrorMessage(null);
      },
      (err) => {
        setSaveStatus("error");
        const msg = err && typeof err === "object" && "message" in err ? String(err.message) : "Failed to save review";
        setSaveErrorMessage(msg);
      }
    );
  }, [setSaveStatus, setSaveErrorMessage]);

  // Auto-save Review Document through queued single writer
  const performSave = useCallback(async () => {
    if (!activeMedia || hydratedMediaId !== activeMedia.id || !reviewState.isDirty) {
      return;
    }
    const doc: ReviewDocument = {
      version: 1,
      mediaId: activeMedia.id,
      comments: reviewState.comments,
      takes: reviewState.takes,
      shotBoundariesMs: reviewState.shotBoundariesMs,
      annotations: reviewState.annotations,
    };
    if (writerRef.current) {
      await writerRef.current.enqueue(doc, reviewState.revision);
    }
  }, [activeMedia, hydratedMediaId, reviewState]);

  const flushSave = useCallback(async () => {
    clearTimeout(saveTimeoutRef.current ?? undefined);
    if (reviewState.isDirty) {
      await performSave();
    }
    if (writerRef.current) {
      await writerRef.current.flush();
    }
  }, [performSave, reviewState.isDirty]);

  useEffect(() => {
    if (!activeMedia || hydratedMediaId !== activeMedia.id || !reviewState.isDirty) {
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
  }, [activeMedia, hydratedMediaId, reviewState.revision, reviewState.isDirty, performSave, setSaveStatus]);

  // Register flusher for view transitions / window close
  useEffect(() => {
    return registerSaveFlusher(flushSave);
  }, [registerSaveFlusher, flushSave]);
  // Update container size on resize
  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setStageSize({ width: rect.width, height: rect.height });
      }
    };
    updateSize();
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, []);

  // Video Time Update & Looping handler
  const handleTimeUpdate = () => {
    if (!videoRef.current) return;
    const ms = Math.round(videoRef.current.currentTime * 1000);
    setCurrentTimeMs(ms);

    if (loopTakeId) {
      const take = reviewState.takes.find((t) => t.id === loopTakeId);
      if (take && ms >= take.outMs) {
        videoRef.current.currentTime = take.inMs / 1000;
        videoRef.current.play().catch(console.error);
      }
    }
  };

  const handleLoadedMetadata = () => {
    if (!videoRef.current) return;
    const durMs = Math.round(videoRef.current.duration * 1000);
    setDurationMs(durMs);
    setPlaybackFailed(false);
  };

  const handleVideoError = () => {
    setPlaybackFailed(true);
    setIsPlaying(false);
  };

  const togglePlay = useCallback(() => {
    if (!videoRef.current) return;
    if (isPlaying) {
      videoRef.current.pause();
      setIsPlaying(false);
    } else {
      videoRef.current.play().then(() => setIsPlaying(true)).catch((e) => {
        console.error("Play failed:", e);
        setPlaybackFailed(true);
      });
    }
  }, [isPlaying]);

  const seekToMs = useCallback((ms: number) => {
    if (!videoRef.current) return;
    const clamped = Math.max(0, Math.min(ms, durationMs));
    videoRef.current.currentTime = clamped / 1000;
    setCurrentTimeMs(clamped);
  }, [durationMs]);

  // Keyboard Shortcuts (Space play/pause, left/right 1 sec, I/O takes, ignored when typing)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }

      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        seekToMs(currentTimeMs - 1000);
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        seekToMs(currentTimeMs + 1000);
      } else if (e.code === "KeyI") {
        e.preventDefault();
        setTakeInMs(currentTimeMs);
      } else if (e.code === "KeyO") {
        e.preventDefault();
        setTakeOutMs(currentTimeMs);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [togglePlay, seekToMs, currentTimeMs]);

  // Generate proxy action
  const handleGenerateProxy = async () => {
    if (!activeMedia) return;
    setIsGeneratingProxy(true);
    try {
      const jid = await api.generateProxy(activeMedia.id);
      setProxyJobId(jid);
    } catch (err) {
      console.error("Failed to start proxy generation:", err);
      setIsGeneratingProxy(false);
      alert(err && typeof err === "object" && "message" in err ? String(err.message) : "Failed to create proxy");
    }
  };

  // Add Comment
  const handleAddComment = (e: React.FormEvent) => {
    e.preventDefault();
    if (!commentText.trim()) return;
    const newComment: ReviewComment = {
      id: crypto.randomUUID(),
      timeMs: currentTimeMs,
      text: commentText.trim(),
      createdAt: Date.now(),
    };
    dispatch({ type: "ADD_COMMENT", payload: newComment });
    setCommentText("");
  };

  const handleDeleteComment = (id: string) => {
    dispatch({ type: "DELETE_COMMENT", id });
  };

  // Save Take
  const handleSaveTake = (e: React.FormEvent) => {
    e.preventDefault();
    if (takeInMs === null || takeOutMs === null) {
      alert("Please set both In and Out points for the take.");
      return;
    }
    if (takeOutMs <= takeInMs) {
      alert("Take Out-point must be greater than In-point.");
      return;
    }

    const name = newTakeName.trim() || `Take ${reviewState.takes.length + 1}`;
    const newTake: ReviewTake = {
      id: crypto.randomUUID(),
      name,
      inMs: takeInMs,
      outMs: takeOutMs,
    };

    dispatch({ type: "ADD_TAKE", payload: newTake });
    setNewTakeName("");
    setTakeInMs(null);
    setTakeOutMs(null);
  };

  const handleDeleteTake = (id: string) => {
    if (loopTakeId === id) setLoopTakeId(null);
    dispatch({ type: "DELETE_TAKE", id });
  };

  // Shot Detection
  const handleDetectShots = async () => {
    if (!activeMedia) return;
    setIsDetectingShots(true);
    try {
      const boundaries = await api.detectShots(activeMedia.id);
      dispatch({ type: "SET_SHOTS", payload: boundaries });
    } catch (err) {
      console.error("Shot detection failed:", err);
      alert(err && typeof err === "object" && "message" in err ? String(err.message) : "Shot detection failed");
    } finally {
      setIsDetectingShots(false);
    }
  };

  // Convert Shot Interval to Take
  const handleConvertShotToTake = (startIndex: number) => {
    if (startIndex >= reviewState.shotBoundariesMs.length - 1) return;
    const inMs = reviewState.shotBoundariesMs[startIndex];
    const outMs = reviewState.shotBoundariesMs[startIndex + 1];
    dispatch({
      type: "CONVERT_SHOT_TO_TAKE",
      inMs,
      outMs,
      name: `Shot ${startIndex + 1}`,
    });
  };

  // Still Capture
  const handleCaptureStill = async () => {
    if (!activeMedia) return;
    const defaultName = `${activeMedia.name}_still_${Math.round(currentTimeMs)}ms.png`;
    const target = await api.saveFile(defaultName, [{ name: "PNG Image", extensions: ["png"] }]);
    if (!target) return;

    try {
      await api.captureStill({
        mediaId: activeMedia.id,
        timeMs: currentTimeMs,
        targetPath: target,
      });
      alert("Still frame saved successfully.");
    } catch (err) {
      console.error("Still capture failed:", err);
      alert(err && typeof err === "object" && "message" in err ? String(err.message) : "Still capture failed");
    }
  };

  // Export Take Modal & Action
  const handleStartExport = async () => {
    if (!activeMedia || !exportModalTake) return;
    const ext = exportFormat;
    const defaultName = `${exportModalTake.name}.${ext}`;
    const target = await api.saveFile(defaultName, [{ name: ext.toUpperCase(), extensions: [ext] }]);
    if (!target) return;

    try {
      await api.exportTake({
        mediaId: activeMedia.id,
        inMs: exportModalTake.inMs,
        outMs: exportModalTake.outMs,
        format: exportFormat,
        targetPath: target,
      });
      setExportModalTake(null);
    } catch (err) {
      console.error("Export take failed:", err);
      alert(err && typeof err === "object" && "message" in err ? String(err.message) : "Export take failed");
    }
  };

  // Annotation Drawing Handlers (normalized coordinates 0.0 to 1.0)
  const handleStageMouseDown = (e: KonvaEventObject<MouseEvent>) => {
    if (selectedTool === "none") return;
    if (isPlaying) {
      videoRef.current?.pause();
      setIsPlaying(false);
    }

    const stage = containerRef.current?.getBoundingClientRect();
    if (!stage || stage.width === 0 || stage.height === 0) return;

    const normX = Math.max(0, Math.min(1, (e.evt.clientX - stage.left) / stage.width));
    const normY = Math.max(0, Math.min(1, (e.evt.clientY - stage.top) / stage.height));

    setIsDrawing(true);
    const stroke: ReviewStroke = {
      id: crypto.randomUUID(),
      tool: selectedTool,
      color: strokeColor,
      strokeWidth,
      points: [{ x: normX, y: normY }],
      text: selectedTool === "text" ? prompt("Enter annotation text:") || "" : undefined,
    };
    setCurrentStroke(stroke);
  };

  const handleStageMouseMove = (e: KonvaEventObject<MouseEvent>) => {
    if (!isDrawing || !currentStroke) return;
    const stage = containerRef.current?.getBoundingClientRect();
    if (!stage || stage.width === 0 || stage.height === 0) return;

    const normX = Math.max(0, Math.min(1, (e.evt.clientX - stage.left) / stage.width));
    const normY = Math.max(0, Math.min(1, (e.evt.clientY - stage.top) / stage.height));

    if (currentStroke.tool === "freehand") {
      setCurrentStroke((prev) => (prev ? { ...prev, points: [...prev.points, { x: normX, y: normY }] } : null));
    } else {
      setCurrentStroke((prev) => (prev ? { ...prev, points: [prev.points[0], { x: normX, y: normY }] } : null));
    }
  };

  const handleStageMouseUp = () => {
    if (!isDrawing || !currentStroke) return;
    setIsDrawing(false);

    dispatch({
      type: "COMMIT_STROKE",
      stroke: currentStroke,
      timeMs: currentTimeMs,
    });

    setCurrentStroke(null);
  };

  const handleUndoAnnotation = () => {
    dispatch({ type: "UNDO_ANNOTATION" });
  };

  const handleRedoAnnotation = () => {
    dispatch({ type: "REDO_ANNOTATION" });
  };

  // Visible annotations within +/- 17ms or explicit time
  const visibleAnnotations = reviewState.annotations.filter((ann) => {
    if (explicitAnnotationTime !== null && Math.abs(ann.timeMs - explicitAnnotationTime) <= 17) {
      return true;
    }
    return Math.abs(ann.timeMs - currentTimeMs) <= 17;
  });

  const formatTime = (ms: number): string => {
    const totalSecs = Math.floor(ms / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    const millis = ms % 1000;
    return `${mins}:${secs.toString().padStart(2, "0")}.${Math.floor(millis / 100)}`;
  };
  const handleLibraryDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    let mediaId = e.dataTransfer.getData("application/jkc-media-id");
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
    if (mediaId) openMediaInPlayer(mediaId);
  };

  const handleLibraryDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };
  if (!activeMedia) {
    return (
      <div
        className="workspace-view"
        onDragOver={handleLibraryDragOver}
        onDrop={handleLibraryDrop}
      >
        <div className="empty-state">
          <Film className="empty-state-icon" />
          <div className="empty-state-title">No Media Loaded</div>
          <div className="empty-state-desc">Select an image or video from the Library to start viewing and reviewing.</div>
        </div>
      </div>
    );
  }

  const isPdf = /\.pdf$/i.test(activeMedia.name);
  const isImage = activeMedia.kind === "image" && !isPdf;
  const assetVersion = `${activeMedia.sizeBytes}-${activeMedia.modifiedMs}`;
  const originalMediaUrl = getMediaAssetUrl(activeMedia.id, assetVersion);
  const mediaUrl = useProxy ? getProxyAssetUrl(activeMedia.id) : originalMediaUrl;

  return (
    <div
      className={floating ? "player-palette" : undefined}
      style={floating ? { left: dialogPos.x, top: dialogPos.y } : { display: "flex", flex: 1, height: "100%", overflow: "hidden" }}
    >
      {floating && (
        <div className="player-palette-header" onPointerDown={beginDialogDrag}>
          <Film size={15} />
          <strong>Player &amp; Review</strong>
          <span>{activeMedia.name}</span>
          <button type="button" className="btn btn-icon" onClick={closePlayerPalette} title="Close Player">
            <X size={15} />
          </button>
        </div>
      )}
      <div style={{ display: "flex", flex: 1, height: floating ? "calc(100% - 42px)" : "100%", overflow: "hidden" }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", background: "#050608" }}>
        {/* Main Canvas / Video Container */}
        <div
          ref={containerRef}
          onDragOver={handleLibraryDragOver}
          onDrop={handleLibraryDrop}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
          }}
        >
          {isPdf ? <PdfPages url={originalMediaUrl} name={activeMedia.name} /> : isImage ? (
            <div
              style={{
                width: "100%",
                height: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                overflow: imageZoom === "actual" ? "auto" : "hidden",
              }}
            >
              {imagePreviewError ? (
                <div className="empty-state" role="alert">
                  <div className="empty-state-title">Image preview unavailable</div>
                  <div className="empty-state-desc">{imagePreviewError}</div>
                </div>
              ) : (
                <img
                  key={originalMediaUrl}
                  src={originalMediaUrl}
                  alt={activeMedia.name}
                  onError={() => setImagePreviewError("The image could not be decoded. Configure FFmpeg or relink to a supported file.")}
                  style={{
                    maxWidth: imageZoom === "fit" ? "100%" : "none",
                    maxHeight: imageZoom === "fit" ? "100%" : "none",
                    objectFit: "contain",
                  }}
                />
              )}
            </div>
          ) : (
            /* Video Display Mode */
            <>
              {!playbackFailed && (
                <video
                  ref={videoRef}
                  src={mediaUrl}
                  style={{ width: "100%", height: "100%", objectFit: "contain" }}
                  onTimeUpdate={handleTimeUpdate}
                  onLoadedMetadata={handleLoadedMetadata}
                  onError={handleVideoError}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                />
              )}

              {/* Playback Fallback / Proxy Card */}
              {playbackFailed && (
                <div
                  style={{
                    padding: 24,
                    maxWidth: 440,
                    background: "var(--bg-secondary)",
                    border: "1px solid var(--border-color)",
                    borderRadius: 8,
                    textAlign: "center",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 12,
                  }}
                >
                  <AlertCircle size={36} color="var(--warning)" />
                  <div style={{ fontWeight: 600, fontSize: 14 }}>Native Video Codec Unsupported</div>
                  <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                    This video format cannot be decoded directly by the webview. You can create an H.264 preview proxy to enable full scrubbing, review, and frame drawings.
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={handleGenerateProxy}
                    disabled={isGeneratingProxy}
                  >
                    {isGeneratingProxy ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
                    {isGeneratingProxy ? "Generating Proxy..." : "Generate Preview Proxy"}
                  </button>
                </div>
              )}

              {/* Annotation Overlay Canvas (Konva) */}
              {!playbackFailed && (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    cursor: selectedTool !== "none" ? "crosshair" : "default",
                    pointerEvents: selectedTool !== "none" ? "all" : "none",
                  }}
                >
                  <Stage
                    width={stageSize.width}
                    height={stageSize.height}
                    onMouseDown={handleStageMouseDown}
                    onMouseMove={handleStageMouseMove}
                    onMouseUp={handleStageMouseUp}
                  >
                    <Layer>
                      {/* Render saved visible annotations */}
                      {visibleAnnotations.flatMap((ann) =>
                        ann.strokes.map((stroke) => {
                          const pts = stroke.points.flatMap((p) => [
                            p.x * stageSize.width,
                            p.y * stageSize.height,
                          ]);
                          if (stroke.tool === "rect" && stroke.points.length >= 2) {
                            const p1 = stroke.points[0];
                            const p2 = stroke.points[1];
                            const x = Math.min(p1.x, p2.x) * stageSize.width;
                            const y = Math.min(p1.y, p2.y) * stageSize.height;
                            const w = Math.abs(p2.x - p1.x) * stageSize.width;
                            const h = Math.abs(p2.y - p1.y) * stageSize.height;
                            return (
                              <KonvaRect
                                key={stroke.id}
                                x={x}
                                y={y}
                                width={w}
                                height={h}
                                stroke={stroke.color}
                                strokeWidth={stroke.strokeWidth}
                              />
                            );
                          }
                          if (stroke.tool === "text" && stroke.points.length >= 1) {
                            return (
                              <KonvaText
                                key={stroke.id}
                                x={stroke.points[0].x * stageSize.width}
                                y={stroke.points[0].y * stageSize.height}
                                text={stroke.text || ""}
                                fill={stroke.color}
                                fontSize={18}
                                fontStyle="bold"
                              />
                            );
                          }
                          return (
                            <KonvaLine
                              key={stroke.id}
                              points={pts}
                              stroke={stroke.color}
                              strokeWidth={stroke.strokeWidth}
                              tension={0.5}
                              lineCap="round"
                              lineJoin="round"
                            />
                          );
                        })
                      )}

                      {/* Render active currently drawing stroke */}
                      {currentStroke &&
                        (currentStroke.tool === "rect" && currentStroke.points.length >= 2 ? (
                          <KonvaRect
                            x={Math.min(currentStroke.points[0].x, currentStroke.points[1].x) * stageSize.width}
                            y={Math.min(currentStroke.points[0].y, currentStroke.points[1].y) * stageSize.height}
                            width={Math.abs(currentStroke.points[1].x - currentStroke.points[0].x) * stageSize.width}
                            height={Math.abs(currentStroke.points[1].y - currentStroke.points[0].y) * stageSize.height}
                            stroke={currentStroke.color}
                            strokeWidth={currentStroke.strokeWidth}
                          />
                        ) : (
                          <KonvaLine
                            points={currentStroke.points.flatMap((p) => [
                              p.x * stageSize.width,
                              p.y * stageSize.height,
                            ])}
                            stroke={currentStroke.color}
                            strokeWidth={currentStroke.strokeWidth}
                            tension={0.5}
                            lineCap="round"
                            lineJoin="round"
                          />
                        ))}
                    </Layer>
                  </Stage>
                </div>
              )}
            </>
          )}
        </div>

        {/* Video Scrubber & Playback Controls Toolbar */}
        {!isImage && !isPdf && (
          <div
            style={{
              background: "var(--bg-secondary)",
              borderTop: "1px solid var(--border-color)",
              padding: "10px 16px",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {/* Scrubber Timeline Bar with Markers */}
            <div style={{ position: "relative", width: "100%", height: 24, display: "flex", alignItems: "center" }}>
              <input
                type="range"
                min={0}
                max={durationMs || 100}
                value={currentTimeMs}
                onChange={(e) => {
                  setExplicitAnnotationTime(null);
                  seekToMs(Number(e.target.value));
                }}
                style={{
                  width: "100%",
                  accentColor: "var(--accent)",
                  cursor: "pointer",
                  height: 6,
                }}
              />

              {/* Take in/out range highlight on timeline */}
              {takeInMs !== null && takeOutMs !== null && durationMs > 0 && (
                <div
                  style={{
                    position: "absolute",
                    left: `${(takeInMs / durationMs) * 100}%`,
                    width: `${((takeOutMs - takeInMs) / durationMs) * 100}%`,
                    height: 6,
                    background: "rgba(59, 130, 246, 0.4)",
                    pointerEvents: "none",
                    borderRadius: 3,
                  }}
                />
              )}

              {/* Comments markers */}
              {durationMs > 0 &&
                reviewState.comments.map((c) => (
                  <div
                    key={c.id}
                    onClick={() => seekToMs(c.timeMs)}
                    style={{
                      position: "absolute",
                      left: `${(c.timeMs / durationMs) * 100}%`,
                      top: 4,
                      width: 8,
                      height: 8,
                      background: "var(--warning)",
                      borderRadius: "50%",
                      cursor: "pointer",
                      transform: "translateX(-50%)",
                    }}
                    title={`Comment: ${c.text} (${formatTime(c.timeMs)})`}
                  />
                ))}

              {/* Annotations markers */}
              {durationMs > 0 &&
                reviewState.annotations.map((a) => (
                  <div
                    key={a.id}
                    onClick={() => {
                      seekToMs(a.timeMs);
                      setExplicitAnnotationTime(a.timeMs);
                    }}
                    style={{
                      position: "absolute",
                      left: `${(a.timeMs / durationMs) * 100}%`,
                      bottom: 0,
                      width: 6,
                      height: 6,
                      background: "var(--danger)",
                      borderRadius: 2,
                      cursor: "pointer",
                      transform: "translateX(-50%)",
                    }}
                    title={`Annotation at ${formatTime(a.timeMs)}`}
                  />
                ))}

              {/* Shot detection boundaries */}
              {durationMs > 0 &&
                reviewState.shotBoundariesMs.map((s, idx) => (
                  <div
                    key={idx}
                    onClick={() => seekToMs(s)}
                    style={{
                      position: "absolute",
                      left: `${(s / durationMs) * 100}%`,
                      height: 12,
                      width: 2,
                      background: "rgba(255, 255, 255, 0.4)",
                      pointerEvents: "none",
                      transform: "translateX(-50%)",
                    }}
                  />
                ))}
            </div>

            {/* Playback Controls Row */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button type="button" className="btn btn-icon btn-primary" onClick={togglePlay} title="Play/Pause (Space)">
                  {isPlaying ? <Pause size={16} /> : <Play size={16} />}
                </button>

                <button type="button" className="btn btn-icon" onClick={() => seekToMs(0)} title="Rewind to start">
                  <RotateCcw size={14} />
                </button>

                <span style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text-primary)", marginLeft: 6 }}>
                  {formatTime(currentTimeMs)} / {formatTime(durationMs)}
                </span>
              </div>

              {/* Center In/Out Controls */}
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <button
                  type="button"
                  className={`btn ${takeInMs !== null ? "btn-primary" : ""}`}
                  style={{ padding: "4px 8px", fontSize: 11 }}
                  onClick={() => setTakeInMs(currentTimeMs)}
                  title="Mark Take In-Point (I)"
                >
                  [ In {takeInMs !== null ? `(${formatTime(takeInMs)})` : ""}
                </button>
                <button
                  type="button"
                  className={`btn ${takeOutMs !== null ? "btn-primary" : ""}`}
                  style={{ padding: "4px 8px", fontSize: 11 }}
                  onClick={() => setTakeOutMs(currentTimeMs)}
                  title="Mark Take Out-Point (O)"
                >
                  Out ] {takeOutMs !== null ? `(${formatTime(takeOutMs)})` : ""}
                </button>
              </div>

              {/* Right Side: Volume, Speed & Still */}
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <button
                  type="button"
                  className="btn btn-icon"
                  style={{ border: "none" }}
                  onClick={() => {
                    const next = !isMuted;
                    setIsMuted(next);
                    if (videoRef.current) videoRef.current.muted = next;
                  }}
                  title={isMuted ? "Unmute" : "Mute"}
                >
                  {isMuted || volume === 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={isMuted ? 0 : volume}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setVolume(val);
                    setIsMuted(false);
                    if (videoRef.current) {
                      videoRef.current.volume = val;
                      videoRef.current.muted = false;
                    }
                  }}
                  style={{ width: 60, accentColor: "var(--accent)" }}
                />

                <select
                  value={playbackRate}
                  onChange={(e) => {
                    const r = Number(e.target.value);
                    setPlaybackRate(r);
                    if (videoRef.current) videoRef.current.playbackRate = r;
                  }}
                  className="input-text"
                  style={{ padding: "3px 6px", fontSize: 11 }}
                >
                  <option value={0.5}>0.5×</option>
                  <option value={1}>1.0×</option>
                  <option value={1.5}>1.5×</option>
                  <option value={2}>2.0×</option>
                </select>

                <button type="button" className="btn" onClick={handleCaptureStill} title="Capture Still Frame as PNG">
                  <Camera size={14} /> Still
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Image Controls Toolbar */}
        {isImage && (
          <div
            style={{
              background: "var(--bg-secondary)",
              borderTop: "1px solid var(--border-color)",
              padding: "10px 16px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className={`btn ${imageZoom === "fit" ? "btn-primary" : ""}`}
                onClick={() => setImageZoom("fit")}
              >
                <ZoomOut size={14} /> Fit to Screen
              </button>
              <button
                type="button"
                className={`btn ${imageZoom === "actual" ? "btn-primary" : ""}`}
                onClick={() => setImageZoom("actual")}
              >
                <ZoomIn size={14} /> Actual Size (100%)
              </button>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              {activeMedia.width && activeMedia.height ? `${activeMedia.width} × ${activeMedia.height} px` : ""}
            </div>
          </div>
        )}
      </div>

      {/* Right Video Review Workspace Sub-Panel (Takes, Comments, Shots, Annotations) */}
      {!isImage && (
        <div
          style={{
            width: 320,
            minWidth: 320,
            background: "var(--bg-secondary)",
            borderLeft: "1px solid var(--border-color)",
            display: "flex",
            flexDirection: "column",
            height: "100%",
            overflowY: "auto",
          }}
        >
          {/* Frame Annotation Toolbar */}
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-color)" }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 8 }}>
              Frame Annotation
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button
                type="button"
                className={`btn btn-icon ${selectedTool === "freehand" ? "btn-primary" : ""}`}
                onClick={() => setSelectedTool(selectedTool === "freehand" ? "none" : "freehand")}
                title="Freehand Pen"
              >
                <Pencil size={14} />
              </button>
              <button
                type="button"
                className={`btn btn-icon ${selectedTool === "line" ? "btn-primary" : ""}`}
                onClick={() => setSelectedTool(selectedTool === "line" ? "none" : "line")}
                title="Line"
              >
                <Minus size={14} />
              </button>
              <button
                type="button"
                className={`btn btn-icon ${selectedTool === "rect" ? "btn-primary" : ""}`}
                onClick={() => setSelectedTool(selectedTool === "rect" ? "none" : "rect")}
                title="Rectangle"
              >
                <Square size={14} />
              </button>
              <button
                type="button"
                className={`btn btn-icon ${selectedTool === "text" ? "btn-primary" : ""}`}
                onClick={() => setSelectedTool(selectedTool === "text" ? "none" : "text")}
                title="Text Label"
              >
                <Type size={14} />
              </button>
              <input
                type="color"
                value={strokeColor}
                onChange={(e) => setStrokeColor(e.target.value)}
                style={{ width: 28, height: 28, padding: 0, border: "none", cursor: "pointer", background: "none" }}
                title="Stroke Color"
              />
              <select
                value={strokeWidth}
                onChange={(e) => setStrokeWidth(Number(e.target.value))}
                className="input-text"
                style={{ padding: "2px 4px", fontSize: 11 }}
                title="Stroke Width"
              >
                <option value={2}>2px</option>
                <option value={4}>4px</option>
                <option value={6}>6px</option>
                <option value={8}>8px</option>
              </select>
              <button
                type="button"
                className="btn btn-icon"
                disabled={reviewState.historyIndex <= 0}
                onClick={handleUndoAnnotation}
                title="Undo Drawing"
              >
                <Undo2 size={14} />
              </button>
              <button
                type="button"
                className="btn btn-icon"
                disabled={reviewState.historyIndex >= reviewState.annotationHistory.length - 1}
                onClick={handleRedoAnnotation}
                title="Redo Drawing"
              >
                <Redo2 size={14} />
              </button>
            </div>
          </div>

          {/* Takes Section */}
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-color)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--text-muted)" }}>
                Takes ({reviewState.takes.length})
              </span>
              <Scissors size={14} color="var(--text-muted)" />
            </div>

            {/* Save current take form */}
            {(takeInMs !== null || takeOutMs !== null) && (
              <form onSubmit={handleSaveTake} style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
                <input
                  type="text"
                  placeholder="Take name..."
                  value={newTakeName}
                  onChange={(e) => setNewTakeName(e.target.value)}
                  className="input-text"
                />
                <button type="submit" className="btn btn-primary">
                  <Plus size={13} /> Save Take
                </button>
              </form>
            )}

            {/* Saved Takes List */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {reviewState.takes.map((take) => (
                <div
                  key={take.id}
                  style={{
                    padding: "8px 10px",
                    background: "var(--bg-tertiary)",
                    borderRadius: 6,
                    border: `1px solid ${loopTakeId === take.id ? "var(--accent)" : "var(--border-color)"}`,
                    fontSize: 12,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                    <span
                      style={{ fontWeight: 600, color: "var(--text-primary)", cursor: "pointer" }}
                      onClick={() => {
                        seekToMs(take.inMs);
                        videoRef.current?.play().catch(console.error);
                      }}
                    >
                      {take.name}
                    </span>
                    <div style={{ display: "flex", gap: 4 }}>
                      <button
                        type="button"
                        className={`btn btn-icon ${loopTakeId === take.id ? "btn-primary" : ""}`}
                        style={{ padding: 3 }}
                        onClick={() => setLoopTakeId(loopTakeId === take.id ? null : take.id)}
                        title={loopTakeId === take.id ? "Disable Loop" : "Loop Take Range"}
                      >
                        <Repeat size={12} />
                      </button>
                      <button
                        type="button"
                        className="btn btn-icon"
                        style={{ padding: 3 }}
                        onClick={() => setExportModalTake(take)}
                        title="Export Take as MP4 or GIF"
                      >
                        <Download size={12} />
                      </button>
                      <button
                        type="button"
                        className="btn btn-icon"
                        style={{ padding: 3 }}
                        onClick={() => handleDeleteTake(take.id)}
                        title="Delete Take"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                    {formatTime(take.inMs)} &rarr; {formatTime(take.outMs)} (
                    {formatTime(take.outMs - take.inMs)})
                  </div>
                </div>
              ))}
              {reviewState.takes.length === 0 && (
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  Use [ In and Out ] buttons or I/O keys to mark and save takes.
                </span>
              )}
            </div>
          </div>

          {/* Shot Detection Section */}
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-color)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--text-muted)" }}>
                Shots ({Math.max(0, reviewState.shotBoundariesMs.length - 1)})
              </span>
              <button
                type="button"
                className="btn"
                style={{ padding: "2px 8px", fontSize: 11 }}
                onClick={handleDetectShots}
                disabled={isDetectingShots}
              >
                {isDetectingShots ? <Loader2 size={12} className="spin" /> : <Flame size={12} />}
                {isDetectingShots ? "Detecting..." : "Detect Cuts"}
              </button>
            </div>

            {reviewState.shotBoundariesMs.length > 1 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 160, overflowY: "auto" }}>
                {reviewState.shotBoundariesMs.slice(0, -1).map((s, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "4px 8px",
                      background: "var(--bg-tertiary)",
                      borderRadius: 4,
                      fontSize: 11,
                    }}
                  >
                    <span
                      style={{ cursor: "pointer", fontFamily: "var(--font-mono)" }}
                      onClick={() => seekToMs(s)}
                    >
                      Shot {idx + 1}: {formatTime(s)} &rarr; {formatTime(reviewState.shotBoundariesMs[idx + 1])}
                    </span>
                    <button
                      type="button"
                      className="btn"
                      style={{ padding: "2px 6px", fontSize: 10 }}
                      onClick={() => handleConvertShotToTake(idx)}
                      title="Convert to Take"
                    >
                      To Take
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Timeline Comments Section */}
          <div style={{ padding: "12px 16px", flex: 1, display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--text-muted)" }}>
                Comments ({reviewState.comments.length})
              </span>
              <MessageSquare size={14} color="var(--text-muted)" />
            </div>

            {/* Add comment form */}
            <form onSubmit={handleAddComment} style={{ display: "flex", gap: 6, marginBottom: 12 }}>
              <input
                type="text"
                placeholder={`Comment at ${formatTime(currentTimeMs)}...`}
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                className="input-text"
                style={{ flex: 1 }}
              />
              <button type="submit" className="btn btn-icon btn-primary" title="Add Comment">
                <Plus size={14} />
              </button>
            </form>

            {/* Comment list */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6, overflowY: "auto" }}>
              {reviewState.comments.map((comment) => (
                <div
                  key={comment.id}
                  style={{
                    padding: "8px 10px",
                    background: "var(--bg-tertiary)",
                    borderRadius: 6,
                    fontSize: 12,
                    border: "1px solid var(--border-color)",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        color: "var(--accent)",
                        fontSize: 11,
                        cursor: "pointer",
                        fontWeight: 600,
                      }}
                      onClick={() => seekToMs(comment.timeMs)}
                    >
                      {formatTime(comment.timeMs)}
                    </span>
                    <button
                      type="button"
                      className="btn btn-icon"
                      style={{ padding: 2, background: "none", border: "none", color: "var(--text-muted)" }}
                      onClick={() => handleDeleteComment(comment.id)}
                      title="Delete comment"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                  <div style={{ color: "var(--text-primary)" }}>{comment.text}</div>
                </div>
              ))}
              {reviewState.comments.length === 0 && (
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  Type a note above to leave a timestamped comment.
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Export Take Dialog Modal */}
      {exportModalTake && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.75)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
          }}
        >
          <div
            style={{
              width: 400,
              background: "var(--bg-secondary)",
              border: "1px solid var(--border-color)",
              borderRadius: 8,
              padding: 24,
              display: "flex",
              flexDirection: "column",
              gap: 16,
            }}
          >
            <h3 style={{ fontSize: 16, fontWeight: 600 }}>Export Take: {exportModalTake.name}</h3>

            <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              Range: {formatTime(exportModalTake.inMs)} &rarr; {formatTime(exportModalTake.outMs)} (
              {formatTime(exportModalTake.outMs - exportModalTake.inMs)})
            </div>

            <div
              style={{
                fontSize: 12,
                color: "var(--warning)",
                background: "rgba(245, 158, 11, 0.1)",
                padding: "8px 12px",
                borderRadius: 6,
              }}
            >
              Notice: Exports original video pixels without review drawing overlays.
            </div>

            <div>
              <label style={{ fontSize: 12, fontWeight: 600, display: "block", marginBottom: 6 }}>
                Export Format
              </label>
              <div style={{ display: "flex", gap: 12 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="format"
                    value="mp4"
                    checked={exportFormat === "mp4"}
                    onChange={() => setExportFormat("mp4")}
                  />
                  MP4 (H.264 / AAC)
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="format"
                    value="gif"
                    checked={exportFormat === "gif"}
                    onChange={() => setExportFormat("gif")}
                  />
                  GIF (12 fps, lanczos palette)
                </label>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
              <button type="button" className="btn" onClick={() => setExportModalTake(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={handleStartExport}>
                <Download size={14} /> Export Take...
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
};
