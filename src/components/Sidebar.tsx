import React from "react";
import { FolderSearch, Film, LayoutGrid, Palette, Settings, X, Loader2 } from "lucide-react";
import { useApp } from "../context/AppContext.tsx";

export const Sidebar: React.FC = () => {
  const { activeView, setActiveView, openLibraryPalette, libraryPaletteOpen, jobs, cancelJob, systemInfo } = useApp();

  const activeJobEntries = Object.entries(jobs);

  return (
    <aside className="app-sidebar" aria-label="Main Navigation">
      <div>
        <div className="brand-section">
          <span className="brand-badge">JKC</span>
          <div>
            <div className="brand-title">JKC</div>
            <div className="brand-subtitle">Media &amp; Canvas</div>
          </div>
        </div>

        <nav className="nav-links">
          <button
            type="button"
            className={`nav-button ${libraryPaletteOpen ? "active" : ""}`}
            onClick={openLibraryPalette}
            title="Open draggable Library palette"
          >
            <FolderSearch size={18} />
            <span>Library</span>
          </button>

          <button
            type="button"
            className={`nav-button ${activeView === "player" ? "active" : ""}`}
            onClick={() => setActiveView("player")}
          >
            <Film size={18} />
            <span>Player &amp; Review</span>
          </button>

          <button
            type="button"
            className={`nav-button ${activeView === "boards" ? "active" : ""}`}
            onClick={() => setActiveView("boards")}
          >
            <LayoutGrid size={18} />
            <span>Boards</span>
          </button>

          <button
            type="button"
            className={`nav-button ${activeView === "editor" ? "active" : ""}`}
            onClick={() => setActiveView("editor")}
          >
            <Palette size={18} />
            <span>Image Editor</span>
          </button>
        </nav>
      </div>

      <div className="sidebar-footer">
        {/* Background Job Progress Card */}
        {activeJobEntries.length > 0 && (
          <div className="job-status-card" role="status" aria-live="polite">
            {activeJobEntries.map(([jobId, job]) => (
              <div key={jobId} style={{ marginBottom: 8 }}>
                <div className="job-header">
                  <span className="job-type" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {job.status === "running" && <Loader2 size={12} className="spin" />}
                    {job.jobType.replace("_", " ")}
                  </span>
                  {job.status === "running" && (
                    <button
                      type="button"
                      className="job-cancel-btn"
                      title="Cancel job"
                      onClick={() => cancelJob(jobId)}
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
                <div className="job-progress-bar">
                  <div
                    className="job-progress-fill"
                    style={{
                      width: `${Math.round(job.progress * 100)}%`,
                      backgroundColor:
                        job.status === "failed" ? "var(--danger)" : job.status === "completed" ? "var(--success)" : "var(--accent)",
                    }}
                  />
                </div>
                {job.message && <div className="job-message">{job.message}</div>}
              </div>
            ))}
          </div>
        )}

        <button
          type="button"
          className={`nav-button ${activeView === "settings" ? "active" : ""}`}
          onClick={() => setActiveView("settings")}
        >
          <Settings size={18} />
          <span>Settings &amp; Tools</span>
          {!systemInfo?.ffmpegAvailable && (
            <span
              style={{
                marginLeft: "auto",
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "var(--warning)",
              }}
              title="FFmpeg not detected"
            />
          )}
        </button>
      </div>
    </aside>
  );
};
