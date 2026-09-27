import React from "react";
import { Check, Loader2, AlertCircle, PanelRightClose, PanelRightOpen, RefreshCw, FolderSearch, Film } from "lucide-react";
import { useApp } from "../context/AppContext.tsx";

export const Header: React.FC = () => {
  const {
    activeView,
    activeMedia,
    inspectorOpen,
    toggleInspector,
    toggleLibraryPalette,
    togglePlayerPalette,
    playerPaletteOpen,
    saveStatus,
    saveErrorMessage,
    flushPendingSave,
  } = useApp();

  const viewTitles: Record<string, string> = {
    library: "Media Library",
    player: "Player & Review",
    boards: "Immersion Boards",
    editor: "Layered Image Editor",
    settings: "Settings & System Tools",
  };

  return (
    <header className="app-header">
      <div className="header-left">
        <h1 className="header-title">{viewTitles[activeView] || "JKC"}</h1>
        {activeMedia && (
          <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
            &bull; {activeMedia.name}
          </span>
        )}
      </div>

      <div className="header-right">
        {/* Save Status Badge */}
        {saveStatus === "saving" && (
          <div className="save-badge saving" title="Debounced save in progress...">
            <Loader2 size={13} className="spin" />
            <span>Saving...</span>
          </div>
        )}

        {saveStatus === "saved" && (
          <div className="save-badge saved" title="All changes saved to local database">
            <Check size={13} />
            <span>Saved</span>
          </div>
        )}

        {saveStatus === "error" && (
          <div className="save-badge error" title={saveErrorMessage || "Save failed"}>
            <AlertCircle size={13} />
            <span>Save Error</span>
            <button
              type="button"
              className="btn btn-icon"
              style={{ padding: "2px 4px", fontSize: 11 }}
              onClick={() => flushPendingSave()}
              title="Retry saving"
            >
              <RefreshCw size={11} /> Retry
            </button>
          </div>
        )}

        <button
          type="button"
          className="btn"
          onClick={toggleLibraryPalette}
          title="Open draggable Library palette"
        >
          <FolderSearch size={15} /> Library
        </button>

        <button
          type="button"
          className={`btn ${playerPaletteOpen ? "active" : ""}`}
          onClick={togglePlayerPalette}
          title="Open draggable Player & Review palette"
        >
          <Film size={15} /> Player
        </button>
        <button
          type="button"
          className="btn btn-icon"
          onClick={toggleInspector}
          title={inspectorOpen ? "Close Inspector" : "Open Inspector"}
          aria-label={inspectorOpen ? "Close Inspector" : "Open Inspector"}
        >
          {inspectorOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
        </button>
      </div>
    </header>
  );
};
