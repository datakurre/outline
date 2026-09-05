# AGENTS.md — Developer and Agent Guide

This document provides architectural guidance, coding conventions, testing workflows, and environment boundaries for autonomous coding agents and human contributors working on `outline-editor`.

```toml agent-sandbox
[network]
allowed_hosts = [
  "github.com:22",
  "github.com:443",
  "*.githubusercontent.com:443",
  "cache.nixos.org:443",
]
```

---

## 1. Project Overview & Philosophy

`outline-editor` is an interactive, direct-manipulation terminal outline editor for Markdown slides and hierarchical documents.

Key design principles:
- **Zero Runtime Dependencies**: The codebase relies strictly on Node.js built-ins (`fs`, `path`, `readline`, `assert`). Do **not** add `package.json`, `npm`, `yarn`, `pnpm`, or third-party dependencies.
- **Single-File Implementation**: All application logic lives in `outline-editor.ts`. All test cases live in `outline-editor.test.ts`. Packaging is handled by `flake.nix`.
- **Reproducible Nix Environment**: Packaged with Nix Flakes targeting `x86_64-linux`, `aarch64-linux`, `x86_64-darwin`, and `aarch64-darwin`.
- **Vim-Style Modal Editing**: Seamless state transitions between `NORMAL` (tree navigation), `EDIT_NORMAL` (vim text motions), `VISUAL` (text selection), `INSERT` (text entry), and `COMMAND` (ex commands).

---

## 2. File Map

- [`outline-editor.ts`](file:///workspace/outline/outline-editor.ts):
  - `OutlineNode`, `Outline`: Core hierarchical data structures, parent-child operations, tree walking, and bidirectional Markdown slide parsing/serialization (`toMarkdown`, `fromMarkdown`, frontmatter preservation, Pandoc `::: notes` div parsing).
  - Terminal helpers: ANSI string stripping, visual width calculation (`stringWidth`), line truncation (`truncateToWidth`), word wrapping (`wordWrap`), and key token normalizers (`normalKeyToken`, `editKeyToken`).
  - `OutlineEditorTUI`: Terminal UI engine handling raw-mode keypresses, ANSI terminal rendering, scrolling, modal dispatch, two-pane layout with dynamic focus mode, unified clipboard, directory-based file watching (`fs.watch`), auto-reload, and conflict resolution.
- [`outline-editor.test.ts`](file:///workspace/outline/outline-editor.test.ts):
  - Comprehensive test suite covering modal transitions, visual selections, yank/paste across panes, linewise register formatting, file watching, reload deferral, and external conflict detection.
- [`flake.nix`](file:///workspace/outline/flake.nix) & [`flake.lock`](file:///workspace/outline/flake.lock):
  - Nix flake definition exporting `packages.default` (`outline-editor`), symlink `outline`, and `apps.default`.

---

## 3. Development & Verification Workflows

### Building with Nix
```sh
# Build package (outputs to ./result)
nix build

# Run directly
nix run . -- [file.md]

# Check flake
nix flake check
```

### Compiling with TypeScript
```sh
# Compile outline-editor.ts into compiled/
tsc outline-editor.ts --outDir compiled --target ES2022 --module commonjs --noCheck
```

### Running the Test Suite
The tests instantiate `OutlineEditorTUI` in memory, dispatch realistic terminal key byte sequences, and verify state and file assertions:

```sh
# Run tests with Nix shell
nix shell nixpkgs#nodejs nixpkgs#typescript --command sh -c "tsc outline-editor.test.ts --noCheck && node outline-editor.test.js"
```

> [!IMPORTANT]
> **Workspace Hygiene**: Compiling `outline-editor.test.ts` generates `outline-editor.js` and `outline-editor.test.js` in the workspace root. Always remove these artifacts after running tests so `git status` remains clean:
> ```sh
> rm -f outline-editor.js outline-editor.test.js ./result
> ```

---

## 4. Critical Invariants & Implementation Details

When modifying or refactoring `outline-editor.ts`, adhere to these established invariants:

### A. Key Event Dispatching
- Node's `readline` library emits both `key.name` and `key.sequence`.
- In terminal raw mode:
  - Printable characters have a single-byte `sequence` (e.g. `"$"` has name `undefined` or `""`).
  - Named control keys arrive with specific escape sequences (e.g. `Tab` arrives as `"\t"`, `Shift+Tab` as `"\x1b[Z"`, `Right` as `"\x1b[C"`).
- `normalKeyToken` and `editKeyToken` distinguish printables from control escape sequences: **printables match by `sequence`, control keys match by `name`**.
- Never dispatch using naive `key.sequence || key.name` or `key.name || key.sequence`, as that breaks either punctuation or control keys.
- Always verify test key events send the byte sequences that terminals genuinely produce.

### B. Dirtiness Derivation
- Dirtiness is **derived by content comparison**, not by a boolean toggle.
- `isModified()` compares `this.outline.toMarkdown()` against `this.savedMarkdown`.
- **Rationale**: Merely navigating nodes, folding branches, or opening an edit field snapshots the tree for undo/edit buffers. A naive boolean dirty flag would report local modifications, permanently disabling filesystem auto-reload and producing false conflict warnings on `:w`.

### C. External File Reloading & Conflict Guard
- **Directory Watching**: `fs.watch` watches `path.dirname(fullPath)` instead of the file directly. This ensures watching persists through atomic saves (`fs.writeFileSync` to `.tmp-${pid}` followed by `fs.renameSync`).
- **Clean Reload**: When `!isModified()`, external changes reload immediately.
- **Edit-Mode Deferral**: If an external change arrives while the user is actively editing in `EDIT_NORMAL`, `INSERT`, or `VISUAL` mode, the reload is deferred (`pendingReload = true`). The reload is only applied upon returning to `NORMAL` mode. Never swap out the active edit buffer under the user's cursor.
- **Conflict Handling**: If local changes exist when an external change arrives, the editor warns and marks disk conflict. Regular `:w` is blocked; `:w!` forces overwrite, and `:e!` discards local edits.
- **Undo Stack Boundary**: External reloads must clear `undoStack` and `redoStack`. Pre-reload snapshots must not be restored over external modifications.
- **Cursor Stability via Heading Path**: `Outline.fromMarkdown` assigns IDs positionally (`node-1`, `node-2`, ...). An external insertion above the cursor alters all subsequent IDs. Cursor position across reloads must be restored using breadcrumb heading paths (`titlePath`) via `selectionAnchor()`.

### D. Unified Clipboard & Register Rules
- Single-slot clipboard: `{ text: string, isLinewise: boolean }`.
- Linewise registers (`yy`, `V` + `y`, `Y`):
  - When pasted into a single-line field (such as a node title), the trailing newline is stripped and the text is appended to the head (`P`) or tail (`p`) of the line without leaving stray whitespace or inserting line breaks.
  - When pasted into multi-line fields (description or notes), linewise text is inserted as separate lines.
  - When pasted in `NORMAL` mode, the text creates a new outline node.

### E. ANSI Width & Layout Overflow Protection
- All terminal column widths must be measured using `stringWidth()` (which strips ANSI escape sequences).
- Visual wrapping uses `wordWrap()` to prevent horizontal line overflow in both tree and inspector panes.
- Focus layout dynamically expands multiline text fields during editing while collapsing metadata headers to single lines.

---

## 5. Agent Sandbox & Environment Considerations

If executing inside an `agent-sandbox` container:
- `/workspace` is the bind-mounted persistent workspace directory. Work outside `/workspace` (such as `~/.config`, `~/.cache`, or `/tmp`) does not persist across container sessions.
- Network egress is deny-by-default when `$HTTP_PROXY` is set. The permitted hosts are declared in the `agent-sandbox` block at the top of this file.
- External tools required for builds or tests (e.g. `nodejs`, `typescript`, `git`) should be invoked via Nix (`nix shell nixpkgs#...`).
