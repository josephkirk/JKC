import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  FolderPlus,
  FolderSearch,
  RefreshCw,
  Folder,
  Trash2,
  LayoutGrid,
  List,
  Search,
  Star,
  Film,
  Image as ImageIcon,
  AlertTriangle,
  Filter,
  X,
} from "lucide-react";
import { useApp } from "../../context/AppContext.tsx";
import { api, getThumbnailUrl } from "../../lib/api.ts";
import type { MediaItem, RootFolder } from "../../lib/contracts.ts";

interface LibraryViewProps {
  floating?: boolean;
}

export const LibraryView: React.FC<LibraryViewProps> = ({ floating = false }) => {
  const {
    activeMediaId,
    setActiveMediaId,
    openMediaInPlayer,
    refreshActiveMedia,
    closeLibraryPalette,
  } = useApp();


  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [dialogPos, setDialogPos] = useState({ x: 120, y: 72 });
  const dragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [selectedRootId, setSelectedRootId] = useState<string | null>(null);
  const [roots, setRoots] = useState<RootFolder[]>([]);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [page, setPage] = useState<number>(0);
  const pageSize = 100;

  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [kindFilter, setKindFilter] = useState<"all" | "image" | "video">("all");
  const [favoriteOnly, setFavoriteOnly] = useState<boolean>(false);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!dragRef.current) return;
      setDialogPos({
        x: Math.max(12, dragRef.current.left + event.clientX - dragRef.current.x),
        y: Math.max(12, dragRef.current.top + event.clientY - dragRef.current.y),
      });
    };
    const stop = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
  }, []);

  const beginDialogDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!floating || (event.target as HTMLElement).closest("button")) return;
    dragRef.current = { x: event.clientX, y: event.clientY, left: dialogPos.x, top: dialogPos.y };
  };

  const selectItem = (item: MediaItem, index: number, event: React.MouseEvent) => {
    const additive = event.ctrlKey || event.metaKey;
    if (event.shiftKey && selectedIds.length > 0) {
      const anchor = mediaItems.findIndex((entry) => entry.id === selectedIds[0]);
      const start = Math.min(anchor >= 0 ? anchor : index, index);
      const end = Math.max(anchor >= 0 ? anchor : index, index);
      setSelectedIds(mediaItems.slice(start, end + 1).map((entry) => entry.id));
    } else if (additive) {
      setSelectedIds((current) => current.includes(item.id)
        ? current.filter((id) => id !== item.id)
        : [...current, item.id]);
    } else {
      setSelectedIds([item.id]);
    }
    setActiveMediaId(item.id);
  };

  const startMediaDrag = (item: MediaItem, event: React.DragEvent<HTMLDivElement>) => {
    const ids = selectedIds.includes(item.id) ? selectedIds : [item.id];
    if (!selectedIds.includes(item.id)) setSelectedIds(ids);
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("application/jkc-media-id", item.id);
    event.dataTransfer.setData("application/jkc-media-ids", JSON.stringify(ids));
    event.dataTransfer.setData("text/plain", item.name);
  };

  // Load roots and all tags
  const loadRootsAndTags = useCallback(async () => {
    try {
      const [r, t] = await Promise.all([api.listRoots(), api.getAllTags()]);
      setRoots(r);
      setAvailableTags(t);
    } catch (err) {
      console.error("Failed to load roots/tags:", err);
    }
  }, []);

  useEffect(() => {
    loadRootsAndTags();
  }, [loadRootsAndTags]);

  // Load media items matching active filters
  const loadMedia = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await api.queryMedia({
        rootId: selectedRootId,
        search: searchQuery.trim() || undefined,
        kind: kindFilter,
        favoriteOnly: favoriteOnly || undefined,
        tag: selectedTag || undefined,
        page,
        pageSize,
      });
      setMediaItems(res.items);
      setTotalCount(res.total);
    } catch (err) {
      console.error("Failed to query media:", err);
    } finally {
      setIsLoading(false);
    }
  }, [selectedRootId, searchQuery, kindFilter, favoriteOnly, selectedTag, page]);

  useEffect(() => {
    loadMedia();
  }, [loadMedia]);

  const handleAddFolder = async () => {
    const chosen = await api.pickFolder();
    if (!chosen) return;

    setIsScanning(true);
    setScanMessage("Adding folder and indexing media...");
    try {
      await api.addRootFolder(chosen);
      await loadRootsAndTags();
      await loadMedia();
    } catch (err) {
      console.error("Failed to add folder:", err);
      alert(typeof err === "object" && err && "message" in err ? String(err.message) : "Failed to add folder");
    } finally {
      setIsScanning(false);
      setScanMessage(null);
    }
  };

  const handleRemoveFolder = async (e: React.MouseEvent, rootId: string) => {
    e.stopPropagation();
    if (!confirm("Remove this folder from your Library? Original media will stay in place on disk; any reviews or board items referencing it will be retained as missing.")) {
      return;
    }

    try {
      await api.removeRootFolder(rootId);
      if (selectedRootId === rootId) {
        setSelectedRootId(null);
      }
      await loadRootsAndTags();
      await loadMedia();
    } catch (err) {
      console.error("Failed to remove folder:", err);
    }
  };

  const handleRefresh = async () => {
    setIsScanning(true);
    setScanMessage("Refreshing library and verifying media...");
    try {
      const summary = await api.refreshLibrary();
      await loadRootsAndTags();
      await loadMedia();
      setScanMessage(`Scan finished: ${summary.added} added, ${summary.missing} missing, ${summary.updated} updated`);
      setTimeout(() => setScanMessage(null), 4000);
    } catch (err) {
      console.error("Failed to refresh library:", err);
    } finally {
      setIsScanning(false);
    }
  };

  const handleToggleFavorite = async (e: React.MouseEvent, item: MediaItem) => {
    e.stopPropagation();
    try {
      await api.setFavorite(item.id, !item.favorite);
      setMediaItems((prev) =>
        prev.map((m) => (m.id === item.id ? { ...m, favorite: !item.favorite } : m))
      );
      if (activeMediaId === item.id) {
        await refreshActiveMedia();
      }
    } catch (err) {
      console.error("Failed to toggle favorite:", err);
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatDuration = (ms: number | null): string => {
    if (ms === null || ms <= 0) return "";
    const totalSecs = Math.floor(ms / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const totalPages = Math.ceil(totalCount / pageSize);

  // Folder tree sidebar & main content layout
  return (
    <div
      className={floating ? "library-palette" : undefined}
      style={floating ? { left: dialogPos.x, top: dialogPos.y } : { display: "flex", flex: 1, height: "100%", overflow: "hidden" }}
    >
      {floating && (
        <div className="library-palette-header" onPointerDown={floating ? beginDialogDrag : undefined}>
          <strong>Library</strong>
          <span>Drag selected assets into a board, editor, or player</span>
          <button type="button" className="btn btn-icon" onClick={closeLibraryPalette} title="Close Library">
            <X size={15} />
          </button>
        </div>
      )}
      {/* Left folder sub-sidebar */}
      <div
        style={{
          width: 220,
          minWidth: 220,
          background: "var(--bg-secondary)",
          borderRight: "1px solid var(--border-color)",
          display: "flex",
          flexDirection: "column",
          padding: "12px 8px",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 8px 8px" }}>
          <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--text-muted)", letterSpacing: 0.5 }}>
            Folders
          </span>
          <div style={{ display: "flex", gap: 4 }}>
            <button
              type="button"
              className="btn btn-icon"
              onClick={handleRefresh}
              title="Refresh Library"
              disabled={isScanning}
            >
              <RefreshCw size={13} className={isScanning ? "spin" : ""} />
            </button>
            <button
              type="button"
              className="btn btn-icon btn-primary"
              onClick={handleAddFolder}
              title="Add Folder to Library"
            >
              <FolderPlus size={13} />
            </button>
          </div>
        </div>

        {/* All Folders selection */}
        <button
          type="button"
          className={`nav-button ${selectedRootId === null ? "active" : ""}`}
          style={{ width: "100%", padding: "8px 10px" }}
          onClick={() => {
            setSelectedRootId(null);
            setPage(0);
          }}
        >
          <Folder size={15} />
          <span style={{ flex: 1, textAlign: "left" }}>All Media</span>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{totalCount}</span>
        </button>

        {/* Root folders list */}
        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
          {roots.map((r) => (
            <div
              key={r.id}
              className={`nav-button ${selectedRootId === r.id ? "active" : ""}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 10px",
                cursor: "pointer",
                borderRadius: 6,
              }}
              onClick={() => {
                setSelectedRootId(r.id);
                setPage(0);
              }}
              title={r.path}
            >
              <Folder size={15} color={r.missing ? "var(--danger)" : undefined} />
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.name}
              </span>
              {r.missing ? (
                <span title="Folder missing or moved"><AlertTriangle size={13} color="var(--danger)" /></span>
              ) : (
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{r.mediaCount ?? 0}</span>
              )}
              <button
                type="button"
                className="btn-icon"
                style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 2 }}
                onClick={(e) => handleRemoveFolder(e, r.id)}
                title="Remove folder from library"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}

          {roots.length === 0 && (
            <div style={{ padding: 12, fontSize: 12, color: "var(--text-muted)", textAlign: "center" }}>
              No folders added yet. Click "+" above to browse local media.
            </div>
          )}
        </div>
      </div>

      {/* Main Library Media Area */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
        {/* Filters Toolbar */}
        <div
          style={{
            padding: "10px 16px",
            background: "var(--bg-secondary)",
            borderBottom: "1px solid var(--border-color)",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            {/* Search */}
            <div style={{ position: "relative", flex: 1, maxWidth: 360 }}>
              <Search
                size={14}
                style={{ position: "absolute", left: 10, top: 9, color: "var(--text-muted)" }}
              />
              <input
                type="text"
                placeholder="Search filename or tags..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(0);
                }}
                className="input-text"
                style={{ width: "100%", paddingLeft: 30 }}
              />
            </div>

            {/* Kind filter: All / Images / Videos */}
            <div style={{ display: "flex", background: "var(--bg-tertiary)", borderRadius: 6, padding: 2 }}>
              <button
                type="button"
                className={`btn ${kindFilter === "all" ? "btn-primary" : ""}`}
                style={{ padding: "4px 10px", border: "none", fontSize: 11 }}
                onClick={() => {
                  setKindFilter("all");
                  setPage(0);
                }}
              >
                All
              </button>
              <button
                type="button"
                className={`btn ${kindFilter === "image" ? "btn-primary" : ""}`}
                style={{ padding: "4px 10px", border: "none", fontSize: 11 }}
                onClick={() => {
                  setKindFilter("image");
                  setPage(0);
                }}
              >
                <ImageIcon size={12} /> Images
              </button>
              <button
                type="button"
                className={`btn ${kindFilter === "video" ? "btn-primary" : ""}`}
                style={{ padding: "4px 10px", border: "none", fontSize: 11 }}
                onClick={() => {
                  setKindFilter("video");
                  setPage(0);
                }}
              >
                <Film size={12} /> Videos
              </button>
            </div>

            {/* Favorites toggle */}
            <button
              type="button"
              className={`btn ${favoriteOnly ? "btn-primary" : ""}`}
              onClick={() => {
                setFavoriteOnly(!favoriteOnly);
                setPage(0);
              }}
              title="Show Favorites Only"
            >
              <Star size={13} fill={favoriteOnly ? "white" : "none"} /> Favorites
            </button>

            {/* Grid / List view toggle */}
            <div style={{ display: "flex", background: "var(--bg-tertiary)", borderRadius: 6, padding: 2, marginLeft: "auto" }}>
              <button
                type="button"
                className={`btn btn-icon ${viewMode === "grid" ? "btn-primary" : ""}`}
                style={{ border: "none" }}
                onClick={() => setViewMode("grid")}
                title="Grid View"
              >
                <LayoutGrid size={14} />
              </button>
              <button
                type="button"
                className={`btn btn-icon ${viewMode === "list" ? "btn-primary" : ""}`}
                style={{ border: "none" }}
                onClick={() => setViewMode("list")}
                title="List View"
              >
                <List size={14} />
              </button>
            </div>
          </div>

          {/* Tag filter row */}
          {availableTags.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, overflowX: "auto" }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 4 }}>
                <Filter size={11} /> Tags:
              </span>
              <button
                type="button"
                className={`tag-chip ${selectedTag === null ? "active" : ""}`}
                style={{ cursor: "pointer" }}
                onClick={() => {
                  setSelectedTag(null);
                  setPage(0);
                }}
              >
                All
              </button>
              {availableTags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className={`tag-chip ${selectedTag === tag ? "active" : ""}`}
                  style={{ cursor: "pointer" }}
                  onClick={() => {
                    setSelectedTag(selectedTag === tag ? null : tag);
                    setPage(0);
                  }}
                >
                  {tag}
                </button>
              ))}
            </div>
          )}

          {scanMessage && (
            <div style={{ fontSize: 12, color: "var(--accent)", padding: "4px 8px", background: "var(--accent-subtle)", borderRadius: 4 }}>
              {scanMessage}
            </div>
          )}
          {selectedIds.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-secondary)" }}>
              <strong>{selectedIds.length} selected</strong>
              <span>Ctrl/Cmd-click to add, Shift-click for a range, drag to another workspace.</span>
              <button type="button" className="btn" onClick={() => setSelectedIds([])} style={{ padding: "3px 8px", marginLeft: "auto" }}>
                Clear
              </button>
            </div>
          )}
        </div>

        {/* Media Items Area */}
        <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
          {mediaItems.length === 0 && !isLoading && (
            <div className="empty-state">
              <FolderSearch className="empty-state-icon" />
              <div className="empty-state-title">
                {roots.length === 0 ? "No Folders Added" : "No Media Matching Filter"}
              </div>
              <div className="empty-state-desc">
                {roots.length === 0
                  ? "Click 'Add Folder' to browse your local images and videos without copying files."
                  : "Try clearing search or filters to see more media items."}
              </div>
              {roots.length === 0 && (
                <button type="button" className="btn btn-primary" onClick={handleAddFolder} style={{ marginTop: 12 }}>
                  <FolderPlus size={14} /> Add Folder to Library
                </button>
              )}
            </div>
          )}

          {/* Grid View */}
          {viewMode === "grid" && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
                gap: 16,
              }}
            >
              {mediaItems.map((item) => (
                <div
                  key={item.id}
                  draggable
                  onDragStart={(event) => startMediaDrag(item, event)}
                  onClick={(event) => selectItem(item, mediaItems.indexOf(item), event)}
                  onDoubleClick={() => openMediaInPlayer(item.id)}
                  style={{
                    backgroundColor: "var(--bg-secondary)",
                    borderRadius: 8,
                    overflow: "hidden",
                    border: `2px solid ${selectedIds.includes(item.id) ? "var(--accent)" : "var(--border-color)"}`,
                    boxShadow: selectedIds.includes(item.id) ? "0 0 0 2px var(--accent-subtle)" : "none",
                    cursor: "grab",
                    transition: "transform 0.1s ease, border-color 0.15s ease",
                    display: "flex",
                    flexDirection: "column",
                  }}
                  title={`${item.name} (${item.kind})`}
                >
                  {/* Thumbnail / Placeholder */}
                  <div
                    style={{
                      height: 120,
                      width: "100%",
                      backgroundColor: "var(--bg-tertiary)",
                      position: "relative",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      overflow: "hidden",
                    }}
                  >
                    <ThumbnailImage item={item} />

                    {/* Media Type badge */}
                    <span
                      style={{
                        position: "absolute",
                        bottom: 6,
                        right: 6,
                        fontSize: 10,
                        fontWeight: 600,
                        padding: "2px 6px",
                        borderRadius: 4,
                        background: "rgba(0, 0, 0, 0.75)",
                        color: "white",
                        backdropFilter: "blur(4px)",
                      }}
                    >
                      {item.kind === "video" ? formatDuration(item.durationMs) || "VIDEO" : "IMG"}
                    </span>

                    {/* Favorite star */}
                    <button
                      type="button"
                      style={{
                        position: "absolute",
                        top: 6,
                        right: 6,
                        background: "rgba(0,0,0,0.5)",
                        border: "none",
                        borderRadius: 4,
                        padding: 4,
                        cursor: "pointer",
                        color: item.favorite ? "var(--warning)" : "#9ca3af",
                      }}
                      onClick={(e) => handleToggleFavorite(e, item)}
                    >
                      <Star size={12} fill={item.favorite ? "var(--warning)" : "none"} />
                    </button>

                    {item.missing && (
                      <span
                        style={{
                          position: "absolute",
                          top: 6,
                          left: 6,
                          background: "var(--danger)",
                          color: "white",
                          fontSize: 10,
                          padding: "2px 6px",
                          borderRadius: 4,
                          fontWeight: 600,
                        }}
                      >
                        MISSING
                      </span>
                    )}
                  </div>

                  {/* Card info */}
                  <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 2 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 500,
                        color: "var(--text-primary)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {item.name}
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-muted)" }}>
                      <span>{formatFileSize(item.sizeBytes)}</span>
                      {item.width && item.height && <span>{item.width}×{item.height}</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* List View */}
          {viewMode === "list" && (
            <div style={{ width: "100%", overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border-color)", color: "var(--text-muted)", textAlign: "left" }}>
                    <th style={{ padding: "8px 12px", width: 40 }} />
                    <th style={{ padding: "8px 12px" }}>Name</th>
                    <th style={{ padding: "8px 12px" }}>Type</th>
                    <th style={{ padding: "8px 12px" }}>Dimensions</th>
                    <th style={{ padding: "8px 12px" }}>Duration</th>
                    <th style={{ padding: "8px 12px" }}>Size</th>
                    <th style={{ padding: "8px 12px" }}>Tags</th>
                    <th style={{ padding: "8px 12px" }}>Modified</th>
                    <th style={{ padding: "8px 12px", width: 40 }} />
                  </tr>
                </thead>
                <tbody>
                  {mediaItems.map((item) => (
                    <tr
                      key={item.id}
                      draggable
                      onDragStart={(event) => startMediaDrag(item, event)}
                      onClick={(event) => selectItem(item, mediaItems.indexOf(item), event)}
                      onDoubleClick={() => openMediaInPlayer(item.id)}
                      style={{
                        borderBottom: "1px solid var(--border-subtle)",
                        backgroundColor: selectedIds.includes(item.id) ? "var(--bg-hover)" : "transparent",
                        outline: selectedIds.includes(item.id) ? "1px solid var(--accent)" : "none",
                        cursor: "grab",
                      }}
                    >
                      <td style={{ padding: "6px 12px" }}>
                        <div
                          style={{
                            width: 32,
                            height: 32,
                            backgroundColor: "var(--bg-tertiary)",
                            borderRadius: 4,
                            overflow: "hidden",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <ThumbnailImage item={item} />
                        </div>
                      </td>
                      <td style={{ padding: "8px 12px", fontWeight: 500, color: "var(--text-primary)" }}>
                        {item.name}
                        {item.missing && (
                          <span style={{ marginLeft: 6, fontSize: 10, color: "var(--danger)", fontWeight: 600 }}>[MISSING]</span>
                        )}
                      </td>
                      <td style={{ padding: "8px 12px", textTransform: "uppercase", color: "var(--text-secondary)" }}>
                        {item.kind}
                      </td>
                      <td style={{ padding: "8px 12px", color: "var(--text-secondary)" }}>
                        {item.width && item.height ? `${item.width}×${item.height}` : "-"}
                      </td>
                      <td style={{ padding: "8px 12px", color: "var(--text-secondary)" }}>
                        {formatDuration(item.durationMs) || "-"}
                      </td>
                      <td style={{ padding: "8px 12px", color: "var(--text-secondary)" }}>
                        {formatFileSize(item.sizeBytes)}
                      </td>
                      <td style={{ padding: "8px 12px" }}>
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {item.tags.map((t) => (
                            <span key={t} className="tag-chip" style={{ fontSize: 10, padding: "1px 6px" }}>
                              {t}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td style={{ padding: "8px 12px", color: "var(--text-muted)" }}>
                        {new Date(item.modifiedMs).toLocaleDateString()}
                      </td>
                      <td style={{ padding: "8px 12px" }}>
                        <button
                          type="button"
                          style={{ background: "none", border: "none", cursor: "pointer", color: item.favorite ? "var(--warning)" : "var(--text-muted)" }}
                          onClick={(e) => handleToggleFavorite(e, item)}
                        >
                          <Star size={14} fill={item.favorite ? "var(--warning)" : "none"} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Pagination Bar */}
        {totalCount > pageSize && (
          <div
            style={{
              padding: "8px 16px",
              background: "var(--bg-secondary)",
              borderTop: "1px solid var(--border-color)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              fontSize: 12,
            }}
          >
            <span style={{ color: "var(--text-secondary)" }}>
              Showing {page * pageSize + 1}–{Math.min((page + 1) * pageSize, totalCount)} of {totalCount} items
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="btn"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                Previous
              </button>
              <span style={{ padding: "4px 8px", color: "var(--text-primary)" }}>
                Page {page + 1} of {totalPages}
              </span>
              <button
                type="button"
                className="btn"
                disabled={page >= totalPages - 1}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// Thumbnail with fallback to neutral media-type placeholder
const ThumbnailImage: React.FC<{ item: MediaItem }> = ({ item }) => {
  const [hasError, setHasError] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);

  return (
    <>
      {!isLoaded && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-muted)",
          }}
        >
          {item.kind === "video" ? <Film size={28} /> : <ImageIcon size={28} />}
        </div>
      )}
      {!hasError && (
        <img
          src={getThumbnailUrl(item.id)}
          alt={item.name}
          onLoad={() => setIsLoaded(true)}
          onError={() => setHasError(true)}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            opacity: isLoaded ? 1 : 0,
            transition: "opacity 0.2s ease",
          }}
        />
      )}
    </>
  );
};
