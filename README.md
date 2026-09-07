# outline-editor

An interactive, direct-manipulation terminal outline editor for Markdown slides and hierarchical documents.

`outline-editor` provides a responsive, full-screen terminal user interface with single-keystroke navigation, instant tree reordering, indent/dedent restructuring, inline multi-line editing, structural undo/redo, vim-inspired modal text editing, and two-pane inspection.

Built with TypeScript using pure Node.js built-in modules—**zero runtime npm dependencies**—and packaged as a reproducible Nix flake.

---

## Table of Contents

- [Features](#features)
- [Installation & Quick Start](#installation--quick-start)
  - [Using Nix (Recommended)](#using-nix-recommended)
  - [Using Node.js & TypeScript Directly](#using-nodejs--typescript-directly)
- [Interface Overview](#interface-overview)
  - [Left Pane: Outline Tree](#left-pane-outline-tree)
  - [Right Pane: Inspector & Focus Layout](#right-pane-inspector--focus-layout)
- [Modal Editing & Keybindings](#modal-editing--keybindings)
  - [NORMAL Mode (Outline Tree Manipulation)](#normal-mode-outline-tree-manipulation)
  - [EDIT-NAV Mode (Vim Text Navigation)](#edit-nav-mode-vim-text-navigation)
  - [VISUAL Mode (Selection & Clipboard)](#visual-mode-selection--clipboard)
  - [INSERT Mode (Text Editing)](#insert-mode-text-editing)
  - [COMMAND Mode (`:`)](#command-mode-)
- [Unified Clipboard](#unified-clipboard)
- [Markdown Slides & File Format](#markdown-slides--file-format)
  - [Slide Structure](#slide-structure)
  - [Speaker Notes (Pandoc `::: notes`)](#speaker-notes-pandoc--notes)
  - [YAML Frontmatter](#yaml-frontmatter)
- [Filesystem Auto-Refresh & Conflict Guard](#filesystem-auto-refresh--conflict-guard)
- [Environment Variables](#environment-variables)
- [Running Tests](#running-tests)
- [License](#license)

---

## Features

- **Direct Tree Manipulation**: Instant reordering (`J`/`K`), promoting/demoting (`<`/`>` or `Tab`/`Shift+Tab`), branch folding/unfolding (`h`/`l`/`Space`, `zM`/`zR`), and subtree deletion with full structural undo/redo (`u`/`Ctrl+R`).
- **Vim-Inspired Modal Architecture**:
  - `NORMAL`: Single-keystroke tree navigation and hierarchy restructuring.
  - `EDIT-NAV`: Full vim normal-mode cursor motions (`h`/`j`/`k`/`l`, `w`/`b`/`e`, `0`/`$`, `d`, `c`, `r`, `s`, `yw`, `yy`, `p`, etc.) directly on title, content, and notes.
  - `VISUAL`: Characterwise (`v`) and linewise (`V`) text selection across all panes.
  - `INSERT`: Seamless typing mode with word deletion (`Ctrl+W`) and line clearing (`Ctrl+U`).
  - `COMMAND`: Ex-style command line (`:w`, `:w!`, `:q`, `:q!`, `:wq`, `:e`, `:e!`, `:m`, `:help`).
- **Two-Pane Interface with Dynamic Focus**:
  - Left pane displays the hierarchical outline tree with fold icons, connector lines, and selection cursor.
  - Right pane inspects node metadata (ID, title, path, children count, depth), slide body (content), and speaker notes.
  - Focus layout automatically collapses metadata when editing content or speaker notes, maximizing vertical space for long text and providing off-screen scroll counters (`Content: ↑3 ↓12`).
- **Cross-Pane Unified Clipboard**: A single-slot clipboard shared between outline nodes and text fields. Yank a node in the tree and paste its title into a content field; yank text from speaker notes and paste it as a new slide in the outline.
- **Markdown Slide Deck Format**:
  - Top-level items serialize as slides separated by `---` (compatible with Marp, reveal.js, Beamer, Slidev).
  - Nested nodes become markdown subheadings (`##`, `###`, etc.).
  - Content becomes slide body text.
  - Speaker notes serialize as pandoc `::: notes` fenced divs.
  - Preserves document YAML frontmatter without modification.
- **Filesystem Auto-Refresh & Conflict Guard**:
  - Watches parent directory to persist across atomic file saves.
  - Automatically pulls in external changes when the buffer is clean.
  - Defers incoming reloads while a node is open in edit mode, applying updates cleanly when returning to `NORMAL` mode so the active edit buffer is never swapped out from under the cursor.
  - Prevents accidental overwriting of external changes when local unsaved edits exist (overrideable via `:w!` or `:e!`).
  - Restores node cursor position by heading path across reloads.
- **Zero Runtime Dependencies**: Written in pure TypeScript relying solely on Node.js built-ins (`fs`, `path`, `readline`). Fast, lightweight, and completely portable.

---

## Installation & Quick Start

### Using Nix (Recommended)

With Nix installed and flakes enabled:

```sh
# Run directly from GitHub
nix run github:datakurre/outline -- presentation.md

# Or clone and run locally
git clone https://github.com/datakurre/outline.git
cd outline
nix run . -- presentation.md

# Build the binary into ./result/bin/outline-editor (also symlinked as outline)
nix build

# Install into your user profile
nix profile install .
```

### Using Node.js & TypeScript Directly

Requires **Node.js 18+** and **TypeScript**.

```sh
# Clone repository
git clone https://github.com/datakurre/outline.git
cd outline

# Compile to JavaScript
tsc outline-editor.ts --outDir compiled --target ES2022 --module commonjs --noCheck

# Run with Node.js
node compiled/outline-editor.js presentation.md
```

If no file argument is provided, `outline-editor` defaults to `outline.md`. If the target file does not exist, a starter outline template is created in memory.

---

## Interface Overview

```
 OUTLINE EDITOR  presentation.md                                       OUTLINE  
────────────────────────────────────────────────────────────────────────────────
❯ • Introduction                         │ ID: node-1                           
  ▼ Architecture                         │ Title: Introduction                  
    ├─• Left Pane: Outline Tree          │ Path: Introduction                   
    ├─• Right Pane: Node Details         │ Children: 0  Depth: 0                
  • Summary                              │ ─────────────────────────────────────
                                         │ Content:                             
                                         │ Welcome to the presentation!         
                                         │                                      
                                         │ ─────────────────────────────────────
                                         │ Notes:                               
                                         │ ::: notes                            
                                         │ Don't forget to mention agenda.      
                                         │ :::                                  
────────────────────────────────────────────────────────────────────────────────
 Ready                                                                          
 j/k:Move  h/l:Fold  o/c:New  e/E/N:Edit  v/y/p:Clip  d:Del  u:Undo  ?:Help  Tab
```

### Left Pane: Outline Tree

- `❯` marks the currently selected node.
- `•` indicates a leaf node or an unfolded branch without children.
- `▼` indicates an expanded node with children.
- `▶` indicates a collapsed (folded) branch.
- Branch connectors (`├─`, `└─`, `│`) show hierarchical depth.

### Right Pane: Inspector & Focus Layout

- Displays node metadata: unique ID, Title, Breadcrumb Path, Child Count, and Tree Depth.
- Displays Content (slide body) and Speaker Notes.
- **Focus Layout**: When you edit the Content or Notes field, the right pane automatically collapses metadata into compact single-line headers to dedicate almost the entire pane to editing. Section headers display scroll indicators such as `Content: ↑3 ↓12` to indicate rows scrolled off screen.

---

## Modal Editing & Keybindings

### NORMAL Mode (Outline Tree Manipulation)

Used for navigating the tree structure, reordering slides, and structural edits.

| Key | Action |
| --- | --- |
| `j` / `k` | Move cursor down / up |
| `Ctrl+F` / `Ctrl+B` | Page down / Page up |
| `Ctrl+D` / `Ctrl+U` | Half-page down / Half-page up |
| `gg` / `G` | Jump to first / last visible node |
| `w` / `b` | Jump to next / previous sibling |
| `h` / `l` / `Space` | Collapse branch / Expand branch / Toggle fold |
| `zM` / `zR` | Fold all branches / Unfold all branches |
| `J` / `K` | Move node down / up among siblings (reorder) |
| `Tab` or `>` | Indent node (demote to child of previous sibling) |
| `Shift+Tab` or `<` | Dedent node (promote to sibling of parent) |
| `o` / `O` | Insert new sibling below / above and enter `INSERT` mode |
| `c` | Insert new child node and enter `INSERT` mode |
| `e` / `R` / `Enter` | Edit node title (enters `EDIT-NAV` mode) |
| `i` | Edit node title directly (enters `INSERT` mode) |
| `E` | Edit content (enters `EDIT-NAV`, or `INSERT` if empty) |
| `N` | Edit speaker notes (enters `EDIT-NAV`, or `INSERT` if empty) |
| `v` / `V` | Enter `VISUAL` text selection on title |
| `yy` / `Y` | Yank node title to clipboard |
| `p` / `P` | Paste clipboard as new sibling below / above |
| `d` / `x` | Delete node and all descendants |
| `u` / `Ctrl+R` | Undo / Redo structural change |
| `:` | Enter `COMMAND` mode |
| `?` | Toggle help overlay (scrollable with `j`/`k`, exit with `?` or `Esc`) |
| `q` | Quit (warns if unsaved edits exist) |

---

### EDIT-NAV Mode (Vim Text Navigation)

Pressing `e`, `E`, or `N` from `NORMAL` mode enters `EDIT-NAV` mode on the selected field. This provides vim normal-mode navigation over the text:

| Key | Action |
| --- | --- |
| `h` / `l` | Move cursor left / right by character |
| `w` / `b` / `e` | Move forward word start / backward word start / forward word end |
| `0` / `$` | Move cursor to beginning / end of line |
| `j` / `k` | Move cursor to next / previous logical line in multiline fields |
| `i` / `a` | Enter `INSERT` mode before / after cursor |
| `I` / `A` | Enter `INSERT` mode at start / end of line |
| `o` / `O` | Open new line below / above and enter `INSERT` mode |
| `x` / `X` | Delete character under / before cursor |
| `r` | Replace single character |
| `~` | Toggle character case |
| `d{motion}` | Delete motion target (e.g. `dw`, `de`, `d$`, `d0`, `dd`) to clipboard |
| `c{motion}` | Change motion target and enter `INSERT` mode (e.g. `cw`, `ce`, `cc`, `C`, `s`, `S`) |
| `D` / `C` | Delete / Change to end of line |
| `yw` / `ye` / `yy` / `Y` | Yank word / to end of word / full line to clipboard |
| `p` / `P` | Paste clipboard content after / before cursor |
| `v` / `V` | Enter characterwise / linewise `VISUAL` mode |
| `Tab` / `Shift+Tab` | Cycle active pane: Title ↔ Content ↔ Notes |
| `Ctrl+W w` | Cycle active pane (`Ctrl+W h/j/k/l` jumps directionally) |
| `Esc` / `Enter` | Confirm edits and return to `NORMAL` mode |

---

### VISUAL Mode (Selection & Clipboard)

Activated via `v` (characterwise) or `V` (linewise) in `NORMAL` or `EDIT-NAV` mode.

| Key | Action |
| --- | --- |
| `h` / `j` / `k` / `l` | Extend selection left / down / up / right |
| `w` / `b` / `e` | Extend selection by word start / previous word / word end |
| `0` / `$` | Extend selection to line beginning / end |
| `gg` / `G` | Extend selection to field start / field end |
| `o` | Swap cursor and anchor ends of selection |
| `y` | Yank selection to clipboard and return to `EDIT-NAV` |
| `d` / `x` | Cut selection to clipboard and return to `EDIT-NAV` |
| `c` / `s` | Cut selection and enter `INSERT` mode |
| `p` / `P` | Replace selection with clipboard content |
| `Tab` / `Shift+Tab` | Switch active pane |
| `v` / `V` / `Esc` | Cancel visual selection |

---

### INSERT Mode (Text Editing)

Typing updates the active field immediately.

| Key | Action |
| --- | --- |
| `Printable chars` | Insert character at cursor |
| `Enter` | Single-line field (title): Confirm and return to `NORMAL`<br>Multiline field (content/notes): Insert newline |
| `Backspace` | Delete character before cursor |
| `Delete` | Delete character at cursor |
| `Ctrl+W` | Delete word backward |
| `Ctrl+U` | Delete to start of line |
| `Left` / `Right` | Move cursor character left / right |
| `Up` / `Down` | Move cursor row up / down in multiline fields |
| `Home` / `End` | Jump to beginning / end of line |
| `Esc` | Return to `EDIT-NAV` mode |

---

### COMMAND Mode (`:`)

Activated with `:` in `NORMAL` mode.

| Command | Action |
| --- | --- |
| `:w [file]` or `Ctrl+S` | Save outline to Markdown file (warns if file changed externally) |
| `:w! [file]` | Force save (overwrite external disk modifications) |
| `:q` | Quit editor (warns if unsaved modifications exist) |
| `:q!` | Force quit without saving |
| `:wq [file]` or `:x` | Save and quit |
| `:wq! [file]` or `:x!` | Force save and quit |
| `:e <file>` | Open another file (warns if unsaved changes exist) |
| `:e!` | Force reload from disk (discards unsaved local changes) |
| `:m [file]` | Export outline to Markdown |
| `:!<cmd>` | Run a shell command with the real terminal (vim-style); any key resumes the editor |
| `:help` | Open the interactive help overlay |
| `↑` / `↓` | Cycle through command history |
| `Esc` | Cancel command prompt |

---

## Unified Clipboard

`outline-editor` features a single-slot clipboard `{ text: string, isLinewise: boolean }` shared seamlessly across all panes:

- **From Tree to Fields**: Press `yy` on any node in `NORMAL` mode to yank its title, switch to editing a content or notes field, and press `p` to paste it.
- **From Fields to Tree**: Select text with `v` or yank a line with `yy` in a content or notes field, return to `NORMAL` mode, and press `p` to insert a brand new outline slide with that text.
- **Linewise Smart Pasting**: Linewise registers pasted into single-line fields (such as titles) automatically append cleanly to the head (`P`) or tail (`p`) without stray trailing newlines or misplaced spaces.

---

## Markdown Slides & File Format

Outlines are saved as standard Markdown slide decks compatible with presentation frameworks such as Marp, reveal.js, Pandoc, and Beamer.

### Slide Structure

- **Top-level items** (`# Heading`) are slides separated by `---`.
- **Child items** (`## Heading`, `### Heading`) become hierarchical headings within that slide.
- **Content** becomes paragraphs under each heading.
- **Speaker notes** are enclosed in pandoc `::: notes` fenced divs.

### Example Markdown File

```markdown
---
title: My Presentation
author: Jane Doe
---

# Introduction

Welcome to the presentation. Here is an overview of today's topics.

::: notes
Start with an engaging opening anecdote.
Keep this under 2 minutes.
:::

---

# Architecture
## Terminal UI

Direct-manipulation terminal UI built with Node.js built-ins.

## Data Model

In-memory hierarchical tree with bidirectional Markdown serialization.

::: notes
Highlight zero runtime npm dependencies.
:::

---

# Conclusion

Thank you for your attention! Questions?
```

### Speaker Notes (Pandoc `::: notes`)

Speaker notes round-trip cleanly as pandoc fenced divs (`::: notes` ... `:::`), understood natively by both the Pandoc `reveal.js` and `beamer` writers. Unterminated blocks at end of file are handled gracefully.

### YAML Frontmatter

`outline-editor` provides first-class support for YAML frontmatter tailored for conference slides and slide decks (compatible with Pandoc Beamer, reveal.js, Marp, Slidev, etc.):

- **Pinned Frontmatter Item**: A dedicated `◆ Frontmatter` item is pinned at the top of the outline tree (displaying the deck title once set, or `(Frontmatter)` when empty).
  - Press `k` from the top slide (or `gg` from anywhere) to navigate to the Frontmatter item.
  - Press `j` to move back down into the slide tree.
- **Conference Metadata Fields**:
  - `title`: Presentation title.
  - `subtitle`: Subtitle or talk description.
  - `author`: Presenter name(s).
  - `institute`: Author affiliation or organization (also parses aliases `organization`, `affiliation`, `org`).
  - `date`: Presentation date.
  - `conference`: Event or venue (also parses aliases `event`, `venue`).
- **Live Editing & Field Cycling**:
  - Press `e`, `i`, or `Enter` on Frontmatter to edit the presentation title.
  - Press `E` on Frontmatter to edit the subtitle.
  - While editing any frontmatter field, press `Tab` or `Shift+Tab` to cycle smoothly through all fields:
    `Title ↔ Subtitle ↔ Author ↔ Author Org ↔ Date ↔ Conference`.
  - The right pane provides a live YAML frontmatter preview showing exact serialization.
- **Data Preservation & Undo**:
  - Unknown or custom frontmatter keys (such as `theme`, `aspectratio`, or `header-includes`) are preserved verbatim without data loss.
  - Press `d` on Frontmatter to clear frontmatter fields, and `u` to restore them with structural undo (`Ctrl+R` for redo).

### Raw Markdown in Content & Notes

A slide's content and speaker notes are opaque, unparsed Markdown: images
(`![alt](url)`), tables, links, and inline formatting all round-trip
byte-for-byte, and the editor lightly syntax-highlights them (headings,
`**bold**`, `` `code` ``, links, list/blockquote markers, table pipes) without
ever rewriting the underlying text. Content inside a fenced code block
(` ``` ` or `~~~`) is treated as fully inert — a `#`-prefixed comment, a bare
`---`, or a `::: notes` line inside a fence is never mistaken for slide
structure. The one remaining caveat: a bare `---` line used as a Markdown
thematic break in body text *outside* a fence is still swallowed on
save/reload (write `***` or `___` instead if you need a rule there); the
editor flags such a line, along with any stray heading or `::: notes` marker
typed directly into content, in caution color so the risk is visible
before you save.

---

## Filesystem Auto-Refresh & Conflict Guard

`outline-editor` is designed for seamless pair editing alongside external tools (compilers, git, other editors, or AI agents):

1. **Directory-Level Watcher**: Files are watched through their parent directory, so watches survive atomic file-saving routines (write to temp file + atomic rename).
2. **Safe Auto-Reload**: When the editor buffer is clean (`!isModified()`), external file modifications on disk are automatically reloaded without interrupting your workflow.
3. **Deferred Reload During Edits**: If an external file update occurs while you have a node open in `EDIT-NAV` or `INSERT` mode, the reload is deferred until you leave edit mode and return to `NORMAL` mode. Your active typing buffer is never clobbered or swapped out under your cursor.
4. **Stable Heading-Path Anchoring**: Across file reloads, cursor position is tracked by heading breadcrumb path (`Alpha > Section 1`) rather than transient positional IDs (`node-1`), keeping your selection anchored to the same node even when new items are added above it.
5. **Conflict Protection**: If external modifications arrive while local edits are pending, the status bar alerts you (`[Disk Modified]`). Saving with `:w` is blocked to prevent accidental data loss. Use `:w!` to overwrite the disk version, or `:e!` to discard your local edits and reload from disk.
6. **Undo Stack Isolation**: Auto-reloads reset the undo stack to prevent accidental reverts across external file changes.

---

## Environment Variables

| Variable | Description | Default |
| --- | --- | --- |
| `OUTLINE_ESCAPE_TIMEOUT` | Milliseconds to wait after a lone `Esc` key before processing it (allows differentiating between a lone `Esc` and multi-byte escape sequences like arrow keys). Lower values make leaving `INSERT` mode faster; raise if running over high-latency SSH connections where escape sequences arrive in separate packets. | `25` |

---

## Running Tests

The test suite runs with Node.js and TypeScript, testing raw terminal sequences, modal states, clipboard operations, and filesystem conflict handling:

```sh
# Run tests with Nix
nix shell nixpkgs#nodejs nixpkgs#typescript --command sh -c "tsc outline-editor.test.ts --noCheck && node outline-editor.test.js && rm -f outline-editor.js outline-editor.test.js"
```

---

## License

This project is open source and available under the terms of the repository license.
