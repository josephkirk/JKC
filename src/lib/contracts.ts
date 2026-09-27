export interface AppError {
  code: string;
  message: string;
  details?: string;
}

export type MediaKind = "image" | "video";

export interface MediaItem {
  id: string;
  rootId: string;
  path: string;
  kind: MediaKind;
  name: string;
  sizeBytes: number;
  modifiedMs: number;
  contentHash?: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  favorite: boolean;
  missing: boolean;
  tags: string[];
  thumbnailUrl?: string;
  assetUrl?: string;
  proxyUrl?: string | null;
  hasProxy?: boolean;
}

export interface RootFolder {
  id: string;
  path: string;
  name: string;
  missing?: boolean;
  mediaCount?: number;
}

export interface LibraryQuery {
  rootId?: string | null;
  search?: string;
  kind?: "all" | "image" | "video";
  favoriteOnly?: boolean;
  tag?: string | null;
  page?: number; // 0-based
  pageSize?: number;
}

export interface LibraryPageResult {
  items: MediaItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ScanSummary {
  added: number;
  updated: number;
  missing: number;
  skipped: number;
  errors: string[];
}

// Review Document (Version 1)
export interface ReviewComment {
  id: string;
  timeMs: number;
  text: string;
  createdAt: number;
}

export interface ReviewTake {
  id: string;
  name: string;
  inMs: number;
  outMs: number;
}

export interface NormalizedPoint {
  x: number; // 0.0 to 1.0 relative to video/image width
  y: number; // 0.0 to 1.0 relative to video/image height
}

export type StrokeTool = "freehand" | "line" | "rect" | "text";

export interface ReviewStroke {
  id: string;
  tool: StrokeTool;
  color: string;
  strokeWidth: number; // normalized relative to min(width, height) or standard scale
  points: NormalizedPoint[];
  text?: string;
  fontSize?: number;
}

export interface ReviewAnnotation {
  id: string;
  timeMs: number;
  strokes: ReviewStroke[];
}

export interface ReviewDocument {
  version: 1;
  mediaId: string;
  comments: ReviewComment[];
  takes: ReviewTake[];
  shotBoundariesMs: number[];
  annotations: ReviewAnnotation[];
}

// Board Document (Version 1)
export interface BoardViewport {
  x: number;
  y: number;
  scale: number;
}

export type BoardItemType = "image" | "video" | "text" | "note" | "drawing";

export interface BoardItemBase {
  id: string;
  type: BoardItemType;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  zIndex: number;
}

export interface BoardMediaItem extends BoardItemBase {
  type: "image" | "video";
  mediaId: string;
}

export interface BoardTextItem extends BoardItemBase {
  type: "text";
  text: string;
  fontSize: number;
  color: string;
}

export interface BoardNoteItem extends BoardItemBase {
  type: "note";
  text: string;
  color: string;
}

export interface BoardDrawingPoint {
  x: number;
  y: number;
}

export interface BoardDrawingItem extends BoardItemBase {
  type: "drawing";
  color: string;
  strokeWidth: number;
  points: BoardDrawingPoint[];
}

export type BoardItem = BoardMediaItem | BoardTextItem | BoardNoteItem | BoardDrawingItem;

export interface BoardDocument {
  version: 1;
  id: string;
  name: string;
  viewport: BoardViewport;
  items: BoardItem[];
}

export interface BoardSummary {
  id: string;
  name: string;
  itemCount: number;
}

// Image Editor Document (Version 1)
export interface EditorLayer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number; // 0..1
  assetId: string; // e.g. "layer_<uuid>.png"
}

export interface EditorDocument {
  version: 1;
  id: string;
  name: string;
  width: number;
  height: number;
  layers: EditorLayer[];
}

export interface EditorSummary {
  id: string;
  name: string;
  width: number;
  height: number;
  layerCount: number;
}

// Background jobs & progress
export type JobType =
  | "thumbnail"
  | "proxy"
  | "still"
  | "shots"
  | "export_mp4"
  | "export_gif"
  | "scan";

export type JobStatus = "running" | "completed" | "failed" | "cancelled";

export interface JobProgressEvent {
  jobId: string;
  jobType: JobType;
  targetId: string;
  status: JobStatus;
  progress: number; // 0.0 - 1.0
  message?: string;
  outputFilePath?: string;
}

export interface AppSettings {
  lastView: "library" | "player" | "boards" | "editor" | "settings";
  lastMediaId?: string | null;
  lastBoardId?: string | null;
  lastEditorId?: string | null;
  toolsDir?: string | null;
}

export interface SystemInfo {
  ffmpegAvailable: boolean;
  ffmpegVersion: string | null;
  ffprobeAvailable: boolean;
  ffprobeVersion: string | null;
  resolvedFfmpegPath: string | null;
  resolvedFfprobePath: string | null;
  appDataDir: string;
}

export interface ExportTakeRequest {
  mediaId: string;
  inMs: number;
  outMs: number;
  format: "mp4" | "gif";
  targetPath: string;
}

export interface CaptureStillRequest {
  mediaId: string;
  timeMs: number;
  targetPath: string;
}

export interface EditorExportRequest {
  editorId: string;
  format: "png" | "jpeg";
  targetPath: string;
  quality?: number; // 0.92 for jpeg
}
