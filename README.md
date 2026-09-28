# JKC — Joseph Kirk's Canvas

Desktop creative workspace built with **Tauri (v2)**, **Rust**, **React**, and **TypeScript**.

JKC integrates local media asset organization, infinite canvas moodboarding, precision video inspection with frame-by-frame annotations, and multi-layer raster image editing in a single offline-first native application.

---

## Features

- **Media Library & Asset Manager**
  - Recursive folder scanning and cataloging with SQLite persistence.
  - Automatic thumbnail generation for images and videos via FFmpeg/native image pipeline.
  - Tagging, search, filtering, and metadata inspection.

- **Infinite Canvas & Moodboards**
  - Spatial moodboarding powered by Excalidraw integration and Konva canvas rendering.
  - Direct drag-and-drop of assets from the library onto the canvas.
  - Freehand sketches, sticky notes, arrows, and visual links between media items.

- **Video Review & Player**
  - Frame-accurate video playback and scrubbing.
  - Video review timeline with frame-specific annotations and markup overlays.
  - Native integration with FFmpeg for frame extraction and processing.

- **Image Editor**
  - Multi-layer raster image editing.
  - Canvas transformation, drawing tools, adjustments, and export capabilities.

- **Fast, Local, and Private**
  - Self-contained SQLite database stored in your local user data directory.
  - Zero cloud dependencies; all processing remains on your local machine.

---

## Tech Stack

- **Backend:** Rust, Tauri v2, SQLite (`rusqlite`), FFmpeg integration
- **Frontend:** React 19, TypeScript, Vite, Tailwind CSS
- **Canvas / Graphics:** Excalidraw, Konva / `react-konva`
- **Icons & UI:** Lucide React, `clsx`, `tailwind-merge`

---

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Rust toolchain](https://www.rust-lang.org/tools/install) (1.80+)
- System dependencies required by Tauri: [Tauri Prerequisites Guide](https://v2.tauri.app/start/prerequisites/)
- [FFmpeg](https://ffmpeg.org/) (recommended in system PATH for video frame processing)

---

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Run in development mode

```bash
npm run tauri dev
```

### 3. Run automated tests

```bash
# Frontend test suite
npm test

# Rust backend test suite
cd src-tauri && cargo test
```

### 4. Build standalone release binary / installer

```bash
npm run build:release
```

or via Tauri CLI directly:

```bash
npm run tauri build
```

---

## License

This project is licensed under the [MIT License](LICENSE).
