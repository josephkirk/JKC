import React from "react";
import { Folder, AlertTriangle, CheckCircle, RefreshCw, Cpu, Database, Info } from "lucide-react";
import { useApp } from "../../context/AppContext.tsx";
import { api } from "../../lib/api.ts";

export const SettingsView: React.FC = () => {
  const { systemInfo, refreshSystemInfo, settings } = useApp();

  const handlePickToolsDir = async () => {
    const selected = await api.pickFolder();
    if (selected) {
      try {
        await api.setToolsDir(selected);
        await refreshSystemInfo();
      } catch (err) {
        console.error("Failed to set tools directory:", err);
      }
    }
  };

  const handleClearToolsDir = async () => {
    try {
      await api.setToolsDir("");
      await refreshSystemInfo();
    } catch (err) {
      console.error("Failed to clear tools directory:", err);
    }
  };

  return (
    <div style={{ flex: 1, padding: 32, overflowY: "auto", maxWidth: 800 }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Settings &amp; Media Tools</h2>
      <p style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 24 }}>
        Configure local FFmpeg / FFprobe binaries, storage directories, and system prerequisites.
      </p>

      {/* FFmpeg / FFprobe Toolchain Card */}
      <div
        style={{
          backgroundColor: "var(--bg-secondary)",
          border: "1px solid var(--border-color)",
          borderRadius: 8,
          padding: 20,
          marginBottom: 20,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Cpu size={18} color="var(--accent)" />
            <h3 style={{ fontSize: 14, fontWeight: 600 }}>FFmpeg &amp; FFprobe Engine</h3>
          </div>
          <button type="button" className="btn" onClick={() => refreshSystemInfo()}>
            <RefreshCw size={13} /> Refresh Detection
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* FFmpeg status */}
          <div
            style={{
              padding: 12,
              borderRadius: 6,
              background: systemInfo?.ffmpegAvailable ? "var(--bg-tertiary)" : "var(--danger-subtle)",
              border: `1px solid ${systemInfo?.ffmpegAvailable ? "var(--border-color)" : "var(--danger)"}`,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              {systemInfo?.ffmpegAvailable ? (
                <CheckCircle size={16} color="var(--success)" />
              ) : (
                <AlertTriangle size={16} color="var(--danger)" />
              )}
              <span style={{ fontWeight: 600, fontSize: 13 }}>FFmpeg</span>
              <span
                style={{
                  fontSize: 11,
                  padding: "2px 6px",
                  borderRadius: 4,
                  background: systemInfo?.ffmpegAvailable ? "rgba(16, 185, 129, 0.2)" : "rgba(239, 68, 68, 0.2)",
                  color: systemInfo?.ffmpegAvailable ? "var(--success)" : "var(--danger)",
                }}
              >
                {systemInfo?.ffmpegAvailable ? "Available" : "Not Found"}
              </span>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginLeft: 24 }}>
              {systemInfo?.ffmpegVersion || "FFmpeg binary is required for video proxy generation, stills, shot detection, and export."}
            </div>
            {systemInfo?.resolvedFfmpegPath && (
              <div
                style={{
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  color: "var(--text-muted)",
                  marginLeft: 24,
                  marginTop: 4,
                }}
              >
                Path: {systemInfo.resolvedFfmpegPath}
              </div>
            )}
          </div>

          {/* FFprobe status */}
          <div
            style={{
              padding: 12,
              borderRadius: 6,
              background: systemInfo?.ffprobeAvailable ? "var(--bg-tertiary)" : "var(--danger-subtle)",
              border: `1px solid ${systemInfo?.ffprobeAvailable ? "var(--border-color)" : "var(--danger)"}`,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              {systemInfo?.ffprobeAvailable ? (
                <CheckCircle size={16} color="var(--success)" />
              ) : (
                <AlertTriangle size={16} color="var(--danger)" />
              )}
              <span style={{ fontWeight: 600, fontSize: 13 }}>FFprobe</span>
              <span
                style={{
                  fontSize: 11,
                  padding: "2px 6px",
                  borderRadius: 4,
                  background: systemInfo?.ffprobeAvailable ? "rgba(16, 185, 129, 0.2)" : "rgba(239, 68, 68, 0.2)",
                  color: systemInfo?.ffprobeAvailable ? "var(--success)" : "var(--danger)",
                }}
              >
                {systemInfo?.ffprobeAvailable ? "Available" : "Not Found"}
              </span>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginLeft: 24 }}>
              {systemInfo?.ffprobeVersion || "FFprobe binary is required for media metadata probing and stream analysis."}
            </div>
            {systemInfo?.resolvedFfprobePath && (
              <div
                style={{
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  color: "var(--text-muted)",
                  marginLeft: 24,
                  marginTop: 4,
                }}
              >
                Path: {systemInfo.resolvedFfprobePath}
              </div>
            )}
          </div>

          {/* Custom Tools Directory Chooser */}
          <div style={{ marginTop: 8 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", display: "block", marginBottom: 6 }}>
              Custom Tools Directory (Optional)
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="text"
                readOnly
                value={settings?.toolsDir || ""}
                placeholder="System PATH default (or choose directory containing ffmpeg/ffprobe)"
                className="input-text"
                style={{ flex: 1, color: "var(--text-secondary)" }}
              />
              <button type="button" className="btn" onClick={handlePickToolsDir}>
                <Folder size={14} /> Browse...
              </button>
              {settings?.toolsDir && (
                <button type="button" className="btn btn-danger" onClick={handleClearToolsDir}>
                  Clear
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Local Storage Directory */}
      <div
        style={{
          backgroundColor: "var(--bg-secondary)",
          border: "1px solid var(--border-color)",
          borderRadius: 8,
          padding: 20,
          marginBottom: 20,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <Database size={18} color="var(--accent)" />
          <h3 style={{ fontSize: 14, fontWeight: 600 }}>Local Database &amp; Cache Storage</h3>
        </div>
        <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 8 }}>
          SQLite catalog metadata, video review markers, boards, image editor assets, and cached thumbnails are saved locally under this directory:
        </p>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            background: "var(--bg-tertiary)",
            padding: "8px 12px",
            borderRadius: 6,
            border: "1px solid var(--border-color)",
            color: "var(--text-primary)",
            wordBreak: "break-all",
          }}
        >
          {systemInfo?.appDataDir || "Loading..."}
        </div>
      </div>

      {/* About Section */}
      <div
        style={{
          backgroundColor: "var(--bg-secondary)",
          border: "1px solid var(--border-color)",
          borderRadius: 8,
          padding: 20,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <Info size={18} color="var(--accent)" />
          <h3 style={{ fontSize: 14, fontWeight: 600 }}>About JKC</h3>
        </div>
        <div style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 600, marginBottom: 4 }}>
          JKC — Version 0.1.0
        </div>
        <p style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.6 }}>
          A local-first desktop workspace for browsing media folders without copying, real video review with frame-accurate annotations and take exports, persistent spatial immersion boards, and layered raster editing. Zero cloud reliance, telemetry, or runtime accounts.
        </p>
      </div>
    </div>
  );
};
