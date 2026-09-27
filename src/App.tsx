import React, { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AppProvider, useApp } from "./context/AppContext.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { Header } from "./components/Header.tsx";
import { Inspector } from "./components/Inspector.tsx";
import { SettingsView } from "./features/settings/SettingsView.tsx";
import { LibraryView } from "./features/library/LibraryView.tsx";
import { PlayerView } from "./features/player/PlayerView.tsx";
import { BoardView } from "./features/boards/BoardView.tsx";
import { ImageEditorView } from "./features/editor/ImageEditorView.tsx";

const WorkspaceRenderer: React.FC = () => {
  const { activeView } = useApp();

  switch (activeView) {
    case "library":
      return <LibraryView />;
    case "player":
      return <PlayerView />;
    case "boards":
      return <BoardView />;
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
              await window.close();
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
