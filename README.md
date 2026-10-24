<div align="center">

# MarkFrame

**A Markdown editor for macOS built the way Typora is built — native Cocoa shell + WKWebView, no Electron.**

[![Platform](https://img.shields.io/badge/platform-macOS%2013%2B-black?logo=apple)](#build)
[![Swift](https://img.shields.io/badge/Swift-6.0%2B-orange?logo=swift)](Sources/)
[![Tests](https://img.shields.io/badge/tests-239%20passing-brightgreen)](test/)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

English · [简体中文](README.zh-CN.md)

</div>

---

### What is this

MarkFrame is a WYSIWYG Markdown editor for macOS. You type Markdown in a live-preview surface, and export to a print-quality A4 PDF.

It started as an experiment: I reverse-engineered Typora's architecture with REA (Reverse Engineer Anything), then rebuilt the same design from scratch to see whether the ideas actually hold up. They do — and the interesting parts are documented in the code.

It is **not** a Typora replacement and does not aim to be. It is a working, readable implementation of the same core ideas, with zero third-party runtime dependencies.

### Why it is not Electron

Typora on macOS is a native Cocoa shell that hosts a WKWebView. MarkFrame does the same:

| | Electron apps | MarkFrame |
|---|---|---|
| Binary size | ~150 MB | **~3.7 MB** (about 2.5 MB of it is Mermaid); DMG is ~1.7 MB |
| Runtime | Chromium + Node | System WebKit |
| Native bridge | IPC / preload | `WKScriptMessageHandler` + `prompt()` sync channel |

The project is currently about 12,222 lines: 2,382 Swift, 5,295 web core, 2,123 features, and 2,422 tests.

### Features

| Area | What works |
|---|---|
| **Editing** | Paragraphs, H1–H6, quotes, ordered/unordered lists, fenced code, tables, horizontal rules, YAML front matter, GFM soft/hard line breaks |
| **Inline** | Bold, italic, inline code, strikethrough, inline and reference links, images, bracket/quote auto-pairing |
| **Live preview** | Lossless DOM: inline elements hold their source markers as real, hidden text nodes — Markdown is reconstructed from the DOM, not a shadow buffer |
| **200 ms brush** | Only dirty blocks get re-rendered; identical HTML means zero DOM writes |
| **`expand`** | Move the caret into `**bold**`, the markers float back into view — and they are editable: delete one `*`, arrow through them, type between them |
| **Source mode** | `Cmd+/` round-trips between rendered and raw text |
| **Multi-document** | One document per window, native macOS tab groups (`Cmd+T`), session restoration, and focusing an existing window instead of reopening the same file |
| **Tables** | Tab / Shift-Tab cell navigation, auto row on last cell, CJK-friendly column widths |
| **Find & replace** | `Cmd+F`, uses the CSS Custom Highlight API — it never mutates the document |
| **Outline / file sidebar** | `Cmd+Shift+O` toggles the unified left sidebar; `Cmd+Shift+E` opens its Files tab; width is remembered |
| **File tree** | Lazy loading, current-file highlighting, automatic external-change refresh, create/rename/duplicate/delete, sorting, in-tree drag, recent folders, and parent-directory navigation |
| **Quick Open** | `Cmd+Shift+P` fuzzy-searches documents under the current folder and opens the keyboard-selected result |
| **Focus / typewriter** | `Cmd+Shift+F` / `Cmd+Shift+T` |
| **Themes** | System / light / dark / sepia / Nord plus your own CSS files, switched from the status-bar theme menu (`Cmd+Shift+L` cycles) |
| **Math / diagrams** | `$x$` and `$$…$$` via KaTeX, ```` ```mermaid ```` rendered to SVG — both lazy-loaded, and a click opens the source in a floating editor |
| **Footnotes / TOC** | `[^id]` references with click-through to `[^id]: ...` definitions, `[TOC]` rebuilt from the current headings |
| **Spelling** | System spellcheck while typing (`Cmd+;` to toggle) |
| **Files** | Double-click `.md`, drag to window, Open Recent, CLI argument, autosave, close confirmation, crash recovery for untitled documents |
| **Export** | Paginated A4 PDF, self-contained HTML (images and KaTeX fonts inlined as data URLs), code highlighting, pasted images saved to `assets/` |

### Architecture

```mermaid
flowchart LR
    A["Native shell<br/>Swift + Cocoa"] -->|WKWebView| B["web/engine.js"]
    B --> C["parseBlocks"]
    C --> D["block model<br/>+ cid ↔ DOM"]
    D --> E["renderBlock → DOM"]
    E --> F["Brush<br/>200ms dirty queue"]
    F --> C
    E --> G["blockRaw → Markdown"]
    G --> A
    A --> H["save / PDF export"]
```

The document model is the source of truth, but the DOM is the lossless copy:

```
parseBlocks ──► block tree ──► renderBlock
     ▲                │
     └── blockRaw ◄────┘        getMarkdown() = sourceMode ? textarea : blocks.map(blockRaw)
```

Each inline element carries `data-open` / `data-close` with its Markdown markers, so `blockRaw()` can turn `<strong>bold</strong>` back into `**bold**` without a second buffer.

### How the PDF export works

This is the part worth reading (`web/engine.js` §13.5 and `Sources/EditorWindow.swift`).

WebKit's own printing is unusable here — measured, not assumed:

| Approach | Result |
|---|---|
| `WKWebView.printOperation(with:)` | ~100,000 blank pages, 150 MB+ |
| `NSPrintOperation(view:)` | Correct page count, but every page is blank (WebKit renders out of process) |

So MarkFrame paginates by itself:

1. **Layout in JS.** Blocks are poured into A4 page boxes (794 × 1123 px → 595 × 842 pt). Blocks taller than a page (tables, code, lists, quotes) are split at row / line / item boundaries; a continuation chunk is never placed on the same page as its predecessor.
2. **Capture per page.** Native renders one page at a time in a dedicated off-screen `WKWebView` and calls `createPDF` with an exact page rect.
3. **Merge.** PDFKit scales each captured page into A4 and writes the final file.

Typography is matched to Typora's own output: body 9.1 pt, 13 mm side margins, no heading underlines, no repeated table headers on continuation pages, front matter hidden.

Four things that silently broke and are now pinned by tests:

- `document.styleSheets[].cssRules` throws `SecurityError` for `file://` in WKWebView → export HTML had almost no CSS. Fixed by injecting `style.css` from the app bundle.
- Code blocks wrapped in the export page but were measured unwrapped → the last two lines got clipped.
- `PDFPage` holds its `PDFDocument` weakly → merged pages occasionally came out blank. Captured pages are now stored as their `PDFDocument` so the page never outlives its owner.
- A snapshot-and-slice approach (the first implementation) cannot avoid overlap at page boundaries. It was removed entirely.

### Custom themes

Themes are plain CSS. Drop a file into `~/Library/Application Support/MarkFrame/themes/` and it appears in the theme menu at the bottom-right (the folder is created on first launch with a commented `example.css`; View → Open Theme Folder… jumps there).

```css
/* @name: Paper */
/* @base: light */

:root {
  --bg: #fbf8f3;
  --fg: #2f2a23;
  --accent: #8a5a2b;
  --mf-editor-width: 900px;
}
```

- `@name` is the label in the menu; without it the file name is used
- `@base` picks the palette to start from — `auto`, `light`, `dark`, `sepia` or `nord`. A dark theme should say `dark`, otherwise the parts it does not override stay light
- Everything is a CSS variable: `--bg`, `--fg`, `--muted`, `--accent`, `--mark`, `--code-bg`, `--border`, `--quote`, the `--hl-*` syntax colours, and `--mf-editor-width` for the reading column
- Only single-line directives count (`/* @name: x */` or a bare `@name: x` line), so prose inside a longer comment block is not misread as metadata
- The last CSS that was loaded is cached in `localStorage`, so the theme paints before the file is read; **Reload Custom Themes** re-reads it after an edit

> The theme menu itself is labelled in Chinese (主题 / 自定义 / 打开主题文件夹…), like the rest of the editor chrome.

### Build

Requirements: macOS 13+, Swift 6 toolchain (`xcode-select --install`). The build itself needs no npm, no Xcode project, and no runtime dependencies; `playwright-core` is only used by the JS tests.

```bash
git clone https://github.com/Linley116/markframe.git
cd markframe
./build.sh          # compile + install to ~/Applications
```

`build.sh` compiles three Swift files with `swiftc`, assembles the `.app` bundle, ad-hoc signs it, and installs a single visible copy to `~/Applications` (so Launchpad does not show duplicates).

To keep the build artifact for distribution:

```bash
./build.sh --keep   # leaves build/MarkFrame.app in place
```

To produce a distributable DMG:

```bash
./release.sh        # dist/MarkFrame-<version>.dmg (ad-hoc signed, not notarized)
```

With a Developer ID certificate, sign and notarize it so other Macs open it without a Gatekeeper warning:

```bash
MARKFRAME_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
APPLE_ID="you@example.com" APPLE_TEAM_ID="TEAMID" APPLE_APP_PASSWORD="app-specific-password" \
./release.sh
```

Alternatively store a `notarytool` keychain profile and set `MARKFRAME_NOTARY_PROFILE`. Without credentials the script says plainly that the product is packaged but not notarized.

> The bundled `web/vendor/highlight.min.js` (highlight.js 11.9.0, BSD-3-Clause) is vendored on purpose so the build works offline.

### Keyboard shortcuts

| Action | Shortcut |
|---|---|
| New / New tab / Open / Save | `Cmd+N` / `Cmd+T` / `Cmd+O` / `Cmd+S` |
| Toggle spellcheck | `Cmd+;` |
| Hard line break | `Shift+Enter` (or two trailing spaces / `\`, per GFM) |
| Export PDF / HTML | File → Export |
| Bold / Italic / Inline code | `Cmd+B` / `Cmd+I` / `Cmd+K` |
| Toggle source mode | `Cmd+/` |
| Find and replace | `Cmd+F` |
| Toggle sidebar | `Shift+Cmd+O` |
| Show file tree | `Shift+Cmd+E` |
| Quick Open | `Shift+Cmd+P` |
| Focus mode / Typewriter | `Shift+Cmd+F` / `Shift+Cmd+T` |
| Next theme | `Shift+Cmd+L` |
| Zoom in / out / reset | `Cmd++` / `Cmd+-` / `Cmd+0` |

### Tests

```bash
node test/engine.test.js      # 121 assertions — core loop
node test/features.test.js    # 118 assertions — features
./test/native.sh                                       # native Swift tests
node test/bench.js                                     # performance baseline
./test/pdf-regression.sh                               # PDF structure + content
```

The JS suites drive real DOM in headless Chrome (`playwright-core` is the only dev dependency; run `npm ci` then `playwright-core install chromium`, or point `MARKFRAME_TEST_CHROME` at a browser). The native suite covers path safety, session restore, file operations and undo, tree sorting, and the Quick Open index; it runs under XCTest when Xcode is available and falls back to a lightweight runner using the same scenarios with Command Line Tools only. The PDF regression exports a document containing a 60-row table, an 80-line code block and an end marker, then checks: multiple pages, no blank page, uniform A4 size, fill ratio, and that the marker survived.

### Known limitations

- Nested blocks work now (lists in lists, code blocks and quotes inside items, multi-paragraph quotes). Still flat: tables cannot be nested, and there is no block-level HTML support.
- Table cells cannot contain a real line break.
- Undo is snapshot-based (whole document + caret per step), which is why it survives mode switches and block re-parsing. The trade-off: a step restores the entire document rather than one node, so it is not cheap on very large files.
- Images work only for pasted content in a saved document (they go to `assets/` next to it). Relative paths resolve in the editor and are inlined as data URLs on export.
- Super-tall paragraphs are split by character; inline formatting is lost for that paragraph only.
- Custom themes are CSS only (no scripts), and PDF export always uses the light print palette — a dark theme does not turn the PDF black.
- The default build is ad-hoc signed. Do not distribute it without notarizing; `release.sh` supports Developer ID signing and notarization, but needs a developer account.
- The DMG contains only the build machine’s architecture (arm64 on Apple Silicon); Intel Macs need a separate build.

### Roadmap

See [ROADMAP.md](ROADMAP.md) — iterations are listed as a table with a check column, followed by the open bug list, the pending feature list, and the engineering notes behind the tricky parts. The current focus is CI, native XCTest, DMG packaging, and notarization; incremental save is deferred after evaluation.

### License

MIT — see [LICENSE](LICENSE) (third-party notices included).
