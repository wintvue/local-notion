# Local Notion

A local-first, Notion-style desktop app. The app icon is taken from the locally installed Notion.app (`build/icon.icns`); it is Notion Labs' trademark, so keep builds for personal use and don't distribute them. Everything lives in a SQLite file on your machine. There are no accounts, no network, and no native modules (it uses the `node:sqlite` built into Electron).

This is a clean-room implementation. The Notion 7.37.1 desktop bundle in `../reverse` is only an Electron shell that loads the editor from app.notion.com, so none of its code is used here. Only the overall shape (Electron shell + local SQLite block store) is the same.

## Run

```bash
npm install
npm start
```

## Build a standalone app

```bash
npm run dist        # dist/mac-arm64/Local Notion.app
npm run dist:dmg    # .dmg installer
```

## Test

```bash
npm test            # storage layer (node:test)
npm run e2e         # drives the real app with keystrokes, saves screenshots
```

## Features

- **Pages**: nested pages, icons, covers, sidebar tree with drag-to-reorder and nesting, favorites, trash with restore and permanent delete, duplicate, open in a new window, back and forward history.
- **Block editor**: text, H1–H3, bulleted, numbered, to-do, toggle, quote, callout, code, divider, image (pick, paste or drop, resizable), sub-page, inline database, and table of contents.
  - `/` slash menu.
  - Markdown shortcuts (`#`, `-`, `1.`, `[]`, `>`, `"`, ```` ``` ````, `---`).
  - Enter splits a block, Backspace merges, Tab and Shift-Tab indent and outdent, ⌘⇧↑/↓ move blocks, ⌘D duplicates.
  - Drag handle to reorder or nest blocks.
  - Block colors.
  - Undo and redo across structural edits.
- **Inline formatting**: bold, italic, underline, strike, code, links (to URLs or other pages), text and background colors, and a floating toolbar.
- **Databases**: table and board views.
  - Property types: text, number, select, multi-select, checkbox, date and URL.
  - Rename, retype (values are converted) and delete properties. Resize columns, sort, search and hide properties.
  - Drag cards between board columns. Rows open as full pages with their properties.
- **Search** (⌘P) over titles and content.
- **Find and replace in the current page**: ⌘F to find, ⌘⌥F to replace (Ctrl+F / Ctrl+H on Windows/Linux). Enter / Shift+Enter navigate matches; Escape closes. Match case, Replace and Replace All are supported, with undo. Searches the title and visible text blocks; expand toggles to include their contents.
- **Import and export**: Markdown import (multiple files), Markdown and PDF export, full JSON backup.
- **Appearance**: light, dark or system theme, plus per-page font, small text and full width.

## Layout

| Path | Role |
|---|---|
| `src/main/main.js` | Electron main: window, `app://` protocol, menus, IPC, file dialogs |
| `src/main/db.js` | SQLite block store (`blocks` table, soft delete, search, duplicate) |
| `src/main/preload.js` | `window.api` bridge (context-isolated, sandboxed) |
| `src/renderer/js/editor.js` | Block editor |
| `src/renderer/js/database.js` | Table and board views, property editors |
| `src/renderer/js/app.js` | Sidebar, navigation, search, trash, settings |
| `src/renderer/js/markdown.js` | Markdown import and export |

Data is stored in `~/Library/Application Support/Local Notion/localnotes.db`. File ▸ Show Data Folder opens it, and `LOCALNOTES_DATA_DIR` overrides the location.

## Continuous integration and releases

GitHub Actions runs syntax checks, unit tests on Node 24/26, and Electron UI tests plus macOS packaging on Apple Silicon and Intel. Logs, screenshots, test results and unsigned app archives are saved as workflow artifacts. Run `npm run verify` locally for syntax and unit coverage.

Version tags trigger the full checks and a signed/notarized build, followed by a draft release with installers and SHA-256 checksums. Apple signing secrets are required; unsigned releases are rejected. See [.github/RELEASING.md](.github/RELEASING.md) for setup, release commands, and the current personal-use branding limitation.
