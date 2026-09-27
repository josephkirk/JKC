# JKC canvas-engine decision

Checked 2026-09-27. Recheck licensing before release because upstream terms can change.

## Decision

JKC uses Excalidraw as the Board workspace canvas. It is MIT-licensed, provides infinite-canvas pan/zoom, selection, serialization, and a supported React embed. JKC persists a versioned `excalidrawScene` beside the existing `BoardDocument.items` field. The adapter migrates legacy v1 items once, preserves item IDs/media IDs, rotation, z-order, and group identity, and stores Excalidraw files with the scene.

Official references:

- Excalidraw package: https://www.npmjs.com/package/@excalidraw/excalidraw
- Excalidraw repository/license: https://github.com/excalidraw/excalidraw/blob/master/LICENSE

## Rejected alternatives

### tldraw

Technically attractive: `screenToPage()`, custom shapes, `createShape()`, and external drop support fit JKC well. It is not selected for the release because the SDK is development-only by default and requires a production trial, commercial, or hobby key.

Official references:

- License: https://tldraw.dev/legal/license
- SDK licensing: https://tldraw.dev/llms.txt

Do not add tldraw without an approved production key/license.

### Affinity

Affinity is an end-user application, not an embeddable canvas SDK. It is not an implementation dependency.

### Konva + KaTeX/MathLive

This remains a valid lower-risk alternative. Konva preserves the existing custom media renderer; KaTeX or MathLive can provide mathematical notation/input. It has weaker built-in infinite-canvas, selection, and serialization behavior than Excalidraw, which is why Excalidraw is now the board foundation.

## Math plan

Use Excalidraw text elements for ordinary labels. Add a JKC math item adapter using MathLive for editing and KaTeX-rendered SVG/PNG files for stable scene display. The math item must retain a JKC item ID and source expression in `customData`; it must not depend on a third-party network service.

## Migration implications

- Legacy `BoardDocument.items` remain for backward compatibility.
- Rust includes `excalidrawScene` so save/load does not discard scene data.
- The adapter migrates every legacy item once and stores the resulting scene.
- Media placements carry stable `jkcItemId`, `jkcMediaId`, and media kind metadata.
- Excalidraw is lazy-loaded only when Boards opens; its fonts and renderer are not part of the startup path.
- Board CRUD and queued saves remain application-owned.
