import React, { lazy, Suspense, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AppProvider, useApp } from "./context/AppContext.tsx";
import { api } from "./lib/api.ts";
import { Sidebar } from "./components/Sidebar.tsx";
import { Header } from "./components/Header.tsx";
import { Inspector } from "./components/Inspector.tsx";
import { SettingsView } from "./features/settings/SettingsView.tsx";
import { LibraryView } from "./features/library/LibraryView.tsx";
import { PlayerView } from "./features/player/PlayerView.tsx";
import { ImageEditorView } from "./features/editor/ImageEditorView.tsx";

const ExcalidrawBoardView = lazy(() => import("./features/boards/ExcalidrawBoardView.tsx").then((module) => ({ default: module.ExcalidrawBoardView })));

const WorkspaceRenderer: React.FC = () => {
  const { activeView, settingsReady } = useApp();
  if (!settingsReady) {
    return <div className="empty-state"><div className="empty-state-title">Starting JKC…</div></div>;
  }

  switch (activeView) {
    case "library":
      return <LibraryView />;
    case "player":
      return <PlayerView />;
    case "boards":
      return (
        <Suspense fallback={<div className="empty-state"><div className="empty-state-title">Loading canvas…</div></div>}>
          <ExcalidrawBoardView />
        </Suspense>
      );
    case "editor":
      return <ImageEditorView />;
    case "settings":
      return <SettingsView />;
    default:
      return <LibraryView />;
  }
};

const MainLayout: React.FC = () => {
  const { flushPendingSave, libraryPaletteOpen } = useApp();
  const closeAttemptRef = React.useRef<Promise<void> | null>(null);
  const allowCloseRef = React.useRef(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const window = getCurrentWindow();
    window
      .onCloseRequested((event) => {
        if (allowCloseRef.current) {
          return;
        }

        event.preventDefault();
        if (!closeAttemptRef.current) {
          closeAttemptRef.current = (async () => {
            try {
              await flushPendingSave();
              allowCloseRef.current = true;
              await api.exitApp();
            } catch (e) {
              console.error("Window close prevented due to save error:", e);
              closeAttemptRef.current = null;
            }
          })();
        }
      })
      .then((un) => {
        unlisten = un;
      })
      .catch(console.error);

    return () => {
      if (unlisten) unlisten();
    };
  }, [flushPendingSave]);

  return (
    <div className="app-container">
      <Sidebar />
      <div className="app-main">
        <Header />
        <div className="workspace-content">
          <WorkspaceRenderer />
          <Inspector />
        </div>
        {libraryPaletteOpen && <LibraryView floating />}
      </div>
    </div>
  );
};

export const App: React.FC = () => {
  return (
    <AppProvider>
      <MainLayout />
    </AppProvider>
  );
};

export default App;
