import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  AppError,
  AppSettings,
  BoardDocument,
  BoardSummary,
  CaptureStillRequest,
  EditorDocument,
  EditorExportRequest,
  EditorSummary,
  ExportTakeRequest,
  LibraryPageResult,
  LibraryQuery,
  MediaItem,
  ReviewDocument,
  RootFolder,
  ScanSummary,
  SystemInfo,
} from "./contracts.ts";

function assetOrigin(): string {
  return "http://jkc-asset.localhost";
}

export function getMediaAssetUrl(mediaId: string, version?: string | number): string {
  const query = version !== undefined && version !== null ? `?v=${encodeURIComponent(String(version))}` : "";
  return `${assetOrigin()}/media/${encodeURIComponent(mediaId)}${query}`;
}

export function getThumbnailUrl(mediaId: string, version?: string | number): string {
  const query = version !== undefined && version !== null ? `?v=${encodeURIComponent(String(version))}` : "";
  return `${assetOrigin()}/thumb/${encodeURIComponent(mediaId)}${query}`;
}

export function getProxyAssetUrl(mediaId: string): string {
  return `${assetOrigin()}/proxy/${encodeURIComponent(mediaId)}`;
}

export function getEditorAssetUrl(assetId: string): string {
  return `${assetOrigin()}/editor/${encodeURIComponent(assetId)}`;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "code" in err && "message" in err) {
      throw err as AppError;
    }
    throw {
      code: "INVOKE_ERROR",
      message: typeof err === "string" ? err : JSON.stringify(err),
    } as AppError;
  }
}

export const api = {
  exitApp: () => call<void>("exit_app"),
  // System & Settings
  getSystemInfo: () => call<SystemInfo>("get_system_info"),
  getSettings: () => call<AppSettings>("get_settings"),
  saveSettings: (settings: Partial<AppSettings>) => call<void>("save_settings", { settings }),
  setToolsDir: (toolsDir: string) => call<SystemInfo>("set_tools_dir", { toolsDir }),

  // Library / Roots
  listRoots: () => call<RootFolder[]>("list_roots"),
  addRootFolder: (path: string) => call<RootFolder>("add_root_folder", { path }),
  removeRootFolder: (rootId: string) => call<void>("remove_root_folder", { rootId }),
  scanRoot: (rootId: string) => call<ScanSummary>("scan_root", { rootId }),
  refreshLibrary: () => call<ScanSummary>("refresh_library"),
  queryMedia: (query: LibraryQuery) => call<LibraryPageResult>("query_media", { query }),
  getMedia: (id: string) => call<MediaItem>("get_media", { id }),
  setFavorite: (id: string, favorite: boolean) => call<void>("set_favorite", { id, favorite }),
  setTags: (mediaId: string, tags: string[]) => call<void>("set_tags", { mediaId, tags }),
  getAllTags: () => call<string[]>("get_all_tags"),
  pickRelinkMedia: (mediaId: string) => call<MediaItem | null>("pick_relink_media", { mediaId }),

  // Review & Video
  getReview: (mediaId: string) => call<ReviewDocument>("get_review", { mediaId }),
  saveReview: (review: ReviewDocument) => call<void>("save_review", { review }),
  generateProxy: (mediaId: string) => call<string>("generate_proxy", { mediaId }),
  captureStill: (req: CaptureStillRequest) => call<void>("capture_still", { req }),
  exportTake: (req: ExportTakeRequest) => call<string>("export_take", { req }),
  detectShots: (mediaId: string) => call<number[]>("detect_shots", { mediaId }),
  cancelJob: (jobId: string) => call<void>("cancel_job", { jobId }),

  // Boards
  listBoards: () => call<BoardSummary[]>("list_boards"),
  getBoard: (id: string) => call<BoardDocument>("get_board", { id }),
  saveBoard: (board: BoardDocument) => call<void>("save_board", { board }),
  createBoard: (name: string) => call<BoardDocument>("create_board", { name }),
  deleteBoard: (id: string) => call<void>("delete_board", { id }),

  // Image Editor
  listEditors: () => call<EditorSummary[]>("list_editors"),
  getEditor: (id: string) => call<EditorDocument>("get_editor", { id }),
  saveEditor: (editor: EditorDocument) => call<void>("save_editor", { editor }),
  createEditor: (name: string, width: number, height: number) =>
    call<EditorDocument>("create_editor", { name, width, height }),
  createEditorFromMedia: (mediaId: string) =>
    call<EditorDocument>("create_editor_from_media", { mediaId }),
  deleteEditor: (id: string) => call<void>("delete_editor", { id }),
  saveLayerRaster: (assetId: string, pngBytesBase64: string) =>
    call<string>("save_layer_raster", { assetId, pngBytesBase64 }),
  exportEditorComposite: (req: EditorExportRequest) =>
    call<void>("export_editor_composite", { req }),

  // Native Dialogs
  pickFolder: async (): Promise<string | null> => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select Folder to Add to Library",
    });
    return typeof selected === "string" ? selected : null;
  },


  saveFile: async (defaultPath: string, filters: { name: string; extensions: string[] }[]): Promise<string | null> => {
    const selected = await save({
      defaultPath,
      filters,
      title: "Save As",
    });
    return selected ?? null;
  },
};
