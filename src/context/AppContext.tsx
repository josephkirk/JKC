import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../lib/api.ts";
import type { AppSettings, JobProgressEvent, MediaItem, SystemInfo } from "../lib/contracts.ts";

export type WorkspaceView = "library" | "player" | "boards" | "editor" | "settings";
export type SaveStatus = "saved" | "saving" | "error";

interface AppContextValue {
  activeView: WorkspaceView;
  setActiveView: (view: WorkspaceView) => void;
  activeMediaId: string | null;
  activeMedia: MediaItem | null;
  setActiveMediaId: (id: string | null) => void;
  openMediaInPlayer: (id: string) => void;
  openMediaInEditor: (id: string) => void;
  activeBoardId: string | null;
  setActiveBoardId: (id: string | null) => void;
  activeEditorId: string | null;
  setActiveEditorId: (id: string | null) => void;
  libraryPaletteOpen: boolean;
  openLibraryPalette: () => void;
  closeLibraryPalette: () => void;
  toggleLibraryPalette: () => void;
  inspectorOpen: boolean;
  setInspectorOpen: (open: boolean) => void;
  toggleInspector: () => void;
  systemInfo: SystemInfo | null;
  refreshSystemInfo: () => Promise<void>;
  settings: AppSettings | null;
  saveSettings: (newSettings: Partial<AppSettings>) => Promise<void>;
  jobs: Record<string, JobProgressEvent>;
  cancelJob: (jobId: string) => Promise<void>;
  saveStatus: SaveStatus;
  setSaveStatus: (status: SaveStatus) => void;
  saveErrorMessage: string | null;
  setSaveErrorMessage: (msg: string | null) => void;
  refreshActiveMedia: () => Promise<void>;
  registerSaveFlusher: (flusher: () => Promise<void>) => () => void;
  flushPendingSave: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [activeView, setActiveViewInternal] = useState<WorkspaceView>("library");
  const [activeMediaId, setActiveMediaId] = useState<string | null>(null);
  const [activeMedia, setActiveMedia] = useState<MediaItem | null>(null);
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
  const [activeEditorId, setActiveEditorId] = useState<string | null>(null);
  const [libraryPaletteOpen, setLibraryPaletteOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [jobs, setJobs] = useState<Record<string, JobProgressEvent>>({});
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [saveErrorMessage, setSaveErrorMessage] = useState<string | null>(null);

  const saveFlushersRef = useRef<Set<() => Promise<void>>>(new Set());

  const registerSaveFlusher = useCallback((flusher: () => Promise<void>) => {
    saveFlushersRef.current.add(flusher);
    return () => {
      saveFlushersRef.current.delete(flusher);
    };
  }, []);

  const flushPendingSave = useCallback(async () => {
    const flushers = Array.from(saveFlushersRef.current);
    const errors: unknown[] = [];
    for (const f of flushers) {
      try {
        await f();
      } catch (e) {
        errors.push(e);
      }
    }
    if (errors.length > 0) {
      const firstErr = errors[0];
      setSaveStatus("error");
      const msg = firstErr && typeof firstErr === "object" && "message" in firstErr
        ? String(firstErr.message)
        : "Failed to save pending changes before navigating";
      setSaveErrorMessage(msg);
      throw firstErr;
    }
  }, []);

  const setActiveView = useCallback(
    async (view: WorkspaceView) => {
      try {
        await flushPendingSave();
      } catch (e) {
        console.warn("Navigation aborted due to save error:", e);
        return;
      }
      setActiveViewInternal(view);
      api.saveSettings({ lastView: view }).catch(console.error);
    },
    [flushPendingSave]
  );

  const refreshSystemInfo = useCallback(async () => {
    try {
      const info = await api.getSystemInfo();
      setSystemInfo(info);
    } catch (err) {
      console.error("Failed to load system info:", err);
    }
  }, []);

  const refreshActiveMedia = useCallback(async () => {
    if (!activeMediaId) {
      setActiveMedia(null);
      return;
    }
    try {
      const media = await api.getMedia(activeMediaId);
      setActiveMedia(media);
    } catch (err) {
      console.error("Failed to refresh active media:", err);
    }
  }, [activeMediaId]);

  useEffect(() => {
    refreshActiveMedia();
  }, [activeMediaId, refreshActiveMedia]);

  const openMediaInPlayer = useCallback(
    async (id: string) => {
      try {
        await flushPendingSave();
      } catch (e) {
        console.warn("Navigation to player aborted due to save error:", e);
        return;
      }
      setActiveMediaId(id);
      setActiveViewInternal("player");
      api.saveSettings({ lastView: "player", lastMediaId: id }).catch(console.error);
    },
    [flushPendingSave]
  );

  const openMediaInEditor = useCallback(
    async (id: string) => {
      try {
        await flushPendingSave();
      } catch (e) {
        console.warn("Navigation to editor aborted due to save error:", e);
        return;
      }
      try {
        setSaveStatus("saving");
        const doc = await api.createEditorFromMedia(id);
        setActiveEditorId(doc.id);
        setActiveViewInternal("editor");
        setSaveStatus("saved");
        api.saveSettings({ lastView: "editor", lastEditorId: doc.id }).catch(console.error);
      } catch (err: unknown) {
        setSaveStatus("error");
        let msg = "Failed to open media in editor";
        if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
          msg = err.message;
        }
        setSaveErrorMessage(msg);
      }
    },
    [flushPendingSave]
  );

  const openLibraryPalette = useCallback(() => setLibraryPaletteOpen(true), []);
  const closeLibraryPalette = useCallback(() => setLibraryPaletteOpen(false), []);
  const toggleLibraryPalette = useCallback(() => setLibraryPaletteOpen((open) => !open), []);

  const toggleInspector = useCallback(() => {
    setInspectorOpen((prev) => !prev);
  }, []);

  const cancelJob = useCallback(async (jobId: string) => {
    try {
      await api.cancelJob(jobId);
    } catch (e) {
      console.error("Failed to cancel job:", e);
    }
  }, []);

  const saveSettings = useCallback(async (newSettings: Partial<AppSettings>) => {
    try {
      await api.saveSettings(newSettings);
      setSettings((prev) => (prev ? { ...prev, ...newSettings } : (newSettings as AppSettings)));
    } catch (err) {
      console.error("Failed to save settings:", err);
    }
  }, []);

  // Initial load
  useEffect(() => {
    refreshSystemInfo();
    api
      .getSettings()
      .then((s) => {
        setSettings(s);
        if (s.lastView) {
          setActiveViewInternal(s.lastView);
        }
        if (s.lastMediaId) {
          setActiveMediaId(s.lastMediaId);
        }
        if (s.lastBoardId) {
          setActiveBoardId(s.lastBoardId);
        }
        if (s.lastEditorId) {
          setActiveEditorId(s.lastEditorId);
        }
      })
      .catch(console.error);
  }, [refreshSystemInfo]);

  // Listen to Tauri job progress events
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<JobProgressEvent>("jkc://job-progress", (event) => {
      const payload = event.payload;
      setJobs((prev) => {
        const next = { ...prev, [payload.jobId]: payload };
        if (payload.status === "completed" || payload.status === "cancelled") {
          setTimeout(() => {
            setJobs((cur) => {
              const cleaned = { ...cur };
              delete cleaned[payload.jobId];
              return cleaned;
            });
          }, 4000);
        }
        return next;
      });

      if (payload.jobType === "proxy" && payload.status === "completed") {
        refreshActiveMedia();
      }
    }).then((un) => {
      unlisten = un;
    });

    return () => {
      if (unlisten) unlisten();
    };
  }, [refreshActiveMedia]);

  return (
    <AppContext.Provider
      value={{
        activeView,
        setActiveView,
        activeMediaId,
        activeMedia,
        setActiveMediaId,
        openMediaInPlayer,
        openMediaInEditor,
        activeBoardId,
        setActiveBoardId,
        activeEditorId,
        setActiveEditorId,
        libraryPaletteOpen,
        openLibraryPalette,
        closeLibraryPalette,
        toggleLibraryPalette,
        inspectorOpen,
        setInspectorOpen,
        toggleInspector,
        systemInfo,
        refreshSystemInfo,
        settings,
        saveSettings,
        jobs,
        cancelJob,
        saveStatus,
        setSaveStatus,
        saveErrorMessage,
        setSaveErrorMessage,
        refreshActiveMedia,
        registerSaveFlusher,
        flushPendingSave,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error("useApp must be used within an AppProvider");
  }
  return ctx;
}
