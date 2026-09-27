import React, { useState } from "react";
import {
  Star,
  Film,
  Palette,
  FileQuestion,
  Plus,
  X,
  RefreshCw,
  Clock,
  Maximize2,
  HardDrive,
  Calendar,
} from "lucide-react";
import { useApp } from "../context/AppContext.tsx";
import { api, getThumbnailUrl } from "../lib/api.ts";

export const Inspector: React.FC = () => {
  const {
    inspectorOpen,
    activeMedia,
    openMediaInPlayer,
    openMediaInEditor,
    refreshActiveMedia,
  } = useApp();

  const [newTag, setNewTag] = useState("");

  if (!inspectorOpen) {
    return null;
  }

  if (!activeMedia) {
    return (
      <aside className="app-inspector" aria-label="Inspector Panel">
        <div className="inspector-header">Inspector</div>
        <div className="empty-state" style={{ height: "60%" }}>
          <FileQuestion className="empty-state-icon" />
          <div className="empty-state-title">No Item Selected</div>
          <div className="empty-state-desc">Select an image or video from the Library to view details, tags, and reviews.</div>
        </div>
      </aside>
    );
  }

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatDuration = (ms: number | null): string => {
    if (ms === null || ms <= 0) return "--:--";
    const totalSecs = Math.floor(ms / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const handleToggleFavorite = async () => {
    try {
      await api.setFavorite(activeMedia.id, !activeMedia.favorite);
      await refreshActiveMedia();
    } catch (err) {
      console.error("Failed to toggle favorite:", err);
    }
  };

  const handleAddTag = async (e: React.FormEvent) => {
    e.preventDefault();
    const tag = newTag.trim();
    if (!tag) return;

    const lowerTags = activeMedia.tags.map((t) => t.toLowerCase());
    if (lowerTags.includes(tag.toLowerCase())) {
      setNewTag("");
      return;
    }

    const updated = [...activeMedia.tags, tag];
    try {
      await api.setTags(activeMedia.id, updated);
      setNewTag("");
      await refreshActiveMedia();
    } catch (err) {
      console.error("Failed to add tag:", err);
    }
  };

  const handleRemoveTag = async (tagToRemove: string) => {
    const updated = activeMedia.tags.filter((t) => t.toLowerCase() !== tagToRemove.toLowerCase());
    try {
      await api.setTags(activeMedia.id, updated);
      await refreshActiveMedia();
    } catch (err) {
      console.error("Failed to remove tag:", err);
    }
  };

  const handleRelink = async () => {
    const isImg = activeMedia.kind === "image";
    const exts = isImg ? ["jpg", "jpeg", "png", "webp", "bmp", "gif"] : ["mp4", "mov", "mkv", "webm", "avi", "m4v"];
    const chosen = await api.pickFile([{ name: isImg ? "Images" : "Videos", extensions: exts }]);
    if (chosen) {
      try {
        await api.relinkMedia(activeMedia.id, chosen);
        await refreshActiveMedia();
      } catch (err) {
        console.error("Relink failed:", err);
        alert(typeof err === "object" && err && "message" in err ? String(err.message) : "Failed to relink media");
      }
    }
  };

  return (
    <aside className="app-inspector" aria-label="Media Inspector">
      <div className="inspector-header">
        <span>Media Details</span>
        <button
          type="button"
          className="btn btn-icon"
          onClick={handleToggleFavorite}
          title={activeMedia.favorite ? "Unfavorite" : "Favorite"}
          style={{ color: activeMedia.favorite ? "var(--warning)" : "var(--text-muted)" }}
        >
          <Star size={16} fill={activeMedia.favorite ? "var(--warning)" : "none"} />
        </button>
      </div>

      <div className="inspector-body">
        {/* Thumbnail Preview */}
        <div
          style={{
            width: "100%",
            height: 160,
            backgroundColor: "var(--bg-tertiary)",
            borderRadius: 8,
            overflow: "hidden",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid var(--border-color)",
          }}
        >
          <img
            src={getThumbnailUrl(activeMedia.id)}
            alt={activeMedia.name}
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
            onError={(e) => {
              (e.target as HTMLElement).style.display = "none";
            }}
          />
        </div>

        {/* Missing Status Alert */}
        {activeMedia.missing && (
          <div
            style={{
              padding: 10,
              borderRadius: 6,
              background: "var(--danger-subtle)",
              border: "1px solid var(--danger)",
              fontSize: 12,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <div style={{ color: "var(--danger)", fontWeight: 600 }}>File Disappeared or Moved</div>
            <div style={{ color: "var(--text-secondary)" }}>
              The original file at this path could not be found. Reviews and tags are preserved.
            </div>
            <button type="button" className="btn btn-danger" onClick={handleRelink}>
              <RefreshCw size={13} /> Relink Missing File...
            </button>
          </div>
        )}

        {/* Quick Actions */}
        <div className="inspector-section">
          <div className="inspector-label">Actions</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => openMediaInPlayer(activeMedia.id)}
            >
              <Film size={14} /> Open in Player &amp; Review
            </button>

            {activeMedia.kind === "image" && (
              <button
                type="button"
                className="btn"
                onClick={() => openMediaInEditor(activeMedia.id)}
              >
                <Palette size={14} /> Edit in Layered Editor
              </button>
            )}

            {!activeMedia.missing && (
              <button type="button" className="btn" onClick={handleRelink}>
                <RefreshCw size={14} /> Relink to Replacement File...
              </button>
            )}
          </div>
        </div>

        {/* Metadata Details */}
        <div className="inspector-section">
          <div className="inspector-label">File Info</div>
          <div className="inspector-field">
            <span className="key">Name</span>
            <span className="val" style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis" }} title={activeMedia.name}>
              {activeMedia.name}
            </span>
          </div>

          <div className="inspector-field">
            <span className="key">Type</span>
            <span className="val" style={{ textTransform: "uppercase" }}>{activeMedia.kind}</span>
          </div>

          <div className="inspector-field">
            <span className="key"><Maximize2 size={12} style={{ verticalAlign: "middle", marginRight: 4 }} /> Dimensions</span>
            <span className="val">
              {activeMedia.width && activeMedia.height ? `${activeMedia.width} × ${activeMedia.height}` : "Pending probe"}
            </span>
          </div>

          {activeMedia.kind === "video" && (
            <div className="inspector-field">
              <span className="key"><Clock size={12} style={{ verticalAlign: "middle", marginRight: 4 }} /> Duration</span>
              <span className="val">{formatDuration(activeMedia.durationMs)}</span>
            </div>
          )}

          <div className="inspector-field">
            <span className="key"><HardDrive size={12} style={{ verticalAlign: "middle", marginRight: 4 }} /> Size</span>
            <span className="val">{formatFileSize(activeMedia.sizeBytes)}</span>
          </div>

          <div className="inspector-field">
            <span className="key"><Calendar size={12} style={{ verticalAlign: "middle", marginRight: 4 }} /> Modified</span>
            <span className="val">
              {new Date(activeMedia.modifiedMs).toLocaleDateString()}
            </span>
          </div>

          <div style={{ marginTop: 4 }}>
            <span className="key" style={{ fontSize: 11, color: "var(--text-muted)", display: "block" }}>Location</span>
            <span
              style={{
                fontSize: 11,
                color: "var(--text-secondary)",
                wordBreak: "break-all",
                fontFamily: "var(--font-mono)",
              }}
            >
              {activeMedia.path}
            </span>
          </div>
        </div>

        {/* Tags Section */}
        <div className="inspector-section">
          <div className="inspector-label">Tags</div>

          <form onSubmit={handleAddTag} style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            <input
              type="text"
              className="input-text"
              placeholder="Add tag..."
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              style={{ flex: 1 }}
            />
            <button type="submit" className="btn btn-icon" title="Add Tag">
              <Plus size={14} />
            </button>
          </form>

          <div className="tag-container">
            {activeMedia.tags.length === 0 ? (
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>No tags yet</span>
            ) : (
              activeMedia.tags.map((tag) => (
                <span key={tag} className="tag-chip">
                  <span>{tag}</span>
                  <button
                    type="button"
                    className="tag-chip-remove"
                    onClick={() => handleRemoveTag(tag)}
                    title={`Remove ${tag}`}
                    aria-label={`Remove ${tag}`}
                    style={{ background: "none", border: "none", padding: 0, display: "flex", cursor: "pointer" }}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))
            )}
          </div>
        </div>
      </div>
    </aside>
  );
};
