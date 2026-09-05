import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { spawnSync } from "child_process";

// Core data model
export interface OutlineNode {
  id: string;
  title: string;
  description: string;
  /** Speaker notes; serialised as a pandoc `::: notes` fenced div. */
  notes: string;
  children: OutlineNode[];
  collapsed: boolean;
}

// Speaker notes are written as a pandoc fenced div, understood by both the
// reveal.js and the Beamer writers.
const NOTES_OPEN = "::: notes";
const NOTES_CLOSE = ":::";
const NOTES_OPEN_RE = /^\s*:{3,}\s*(?:notes|\{\s*\.notes\s*\})\s*$/i;
const NOTES_CLOSE_RE = /^\s*:{3,}\s*$/;

// A fenced code block's contents are opaque: a `#`-comment, a bare `---`, or
// a `::: notes` line inside one must never be mistaken for slide structure.
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

// ATX heading; shared with the live-highlighting in computeMarkdownStyles so
// the editor flags exactly what fromMarkdown will actually split on.
const HEADING_RE = /^(#{1,6})[ \t]+(.+?)\s*#*\s*$/;

export class Outline {
  root: OutlineNode;
  frontmatter: string = "";
  private nextId: number = 1;

  constructor() {
    this.root = {
      id: "root",
      title: "Article Outline",
      description: "",
      notes: "",
      children: [],
      collapsed: false,
    };
  }

  addChild(parentId: string, title: string): OutlineNode {
    const parent = this.findNode(parentId);
    if (!parent) return null!;

    const newNode: OutlineNode = {
      id: this.allocateId(),
      title,
      description: "",
      notes: "",
      children: [],
      collapsed: false,
    };
    parent.children.push(newNode);
    return newNode;
  }

  addSibling(nodeId: string, title: string): OutlineNode {
    return this.insertSibling(nodeId, title, 1);
  }

  addSiblingBefore(nodeId: string, title: string): OutlineNode {
    return this.insertSibling(nodeId, title, 0);
  }

  private insertSibling(nodeId: string, title: string, offset: number): OutlineNode {
    const node = this.findNode(nodeId);
    if (!node || nodeId === "root") return null!;

    const parent = this.findParent(this.root, nodeId);
    if (!parent) return null!;
    const newNode: OutlineNode = {
      id: this.allocateId(),
      title,
      description: "",
      notes: "",
      children: [],
      collapsed: false,
    };
    const index = parent.children.indexOf(node);
    if (index < 0) return null!;
    parent.children.splice(index + offset, 0, newNode);
    return newNode;
  }

  deleteNode(nodeId: string): boolean {
    if (nodeId === "root") return false;

    const parent = this.findParent(this.root, nodeId);
    if (!parent) return false;

    const index = parent.children.findIndex((n) => n.id === nodeId);
    if (index >= 0) {
      parent.children.splice(index, 1);
      return true;
    }
    return false;
  }

  updateNode(nodeId: string, title: string, description: string, notes?: string): boolean {
    const node = this.findNode(nodeId);
    if (!node) return false;
    node.title = title;
    node.description = description;
    if (notes !== undefined) node.notes = notes;
    return true;
  }

  toggleCollapse(nodeId: string): boolean {
    const node = this.findNode(nodeId);
    if (!node || nodeId === "root") return false;
    node.collapsed = !node.collapsed;
    return true;
  }

  findNode(id: string): OutlineNode | null {
    if (this.root.id === id) return this.root;
    return this.findNodeRecursive(this.root, id);
  }

  private findNodeRecursive(node: OutlineNode, id: string): OutlineNode | null {
    for (const child of node.children) {
      if (child.id === id) return child;
      const found = this.findNodeRecursive(child, id);
      if (found) return found;
    }
    return null;
  }

  findParent(node: OutlineNode, targetId: string): OutlineNode | null {
    for (const child of node.children) {
      if (child.id === targetId) return node;
      const found = this.findParent(child, targetId);
      if (found) return found;
    }
    return null;
  }

  cloneTree(): OutlineNode {
    return this.cloneNode(this.root);
  }

  restoreTree(root: OutlineNode): void {
    this.root = this.cloneNode(root);
    this.updateNextId();
  }

  private cloneNode(node: OutlineNode): OutlineNode {
    return {
      id: node.id,
      title: node.title,
      description: node.description,
      notes: node.notes ?? "",
      children: node.children.map((child) => this.cloneNode(child)),
      collapsed: Boolean(node.collapsed),
    };
  }

  private updateNextId(): void {
    this.nextId = 1;
    this.walkNodes(this.root, (node) => {
      const match = node.id.match(/^node-(\d+)$/);
      if (!match) return;
      const numericId = Number(match[1]);
      if (Number.isSafeInteger(numericId)) {
        this.nextId = Math.max(this.nextId, numericId + 1);
      }
    });
  }

  private allocateId(): string {
    if (!Number.isSafeInteger(this.nextId) || this.nextId < 1) {
      this.nextId = 1;
    }
    let id: string;
    do {
      id = `node-${this.nextId++}`;
    } while (this.findNode(id));
    return id;
  }

  private walkNodes(
    node: OutlineNode,
    callback: (node: OutlineNode) => void
  ): void {
    callback(node);
    for (const child of node.children) {
      this.walkNodes(child, callback);
    }
  }

  /**
   * Render the outline as a slide deck.  Top-level outline items are slides;
   * their descendants are headings/content on that slide.  `---` is the
   * separator understood by Marp, reveal.js and most Markdown slide tools.
   */
  toMarkdown(_indentLevel: number = 0): string {
    const slides: string[] = [];

    for (const slide of this.root.children) {
      const lines: string[] = [];
      const walkNode = (node: OutlineNode, level: number) => {
        const headingLevel = Math.min(6, Math.max(1, level));
        lines.push(`${"#".repeat(headingLevel)} ${node.title}`);
        if (node.description) lines.push("", node.description);
        if (node.notes.trim()) {
          lines.push("", NOTES_OPEN, node.notes.replace(/\s+$/, ""), NOTES_CLOSE);
        }
        for (const child of node.children) {
          lines.push("");
          walkNode(child, level + 1);
        }
      };
      walkNode(slide, 1);
      slides.push(lines.join("\n"));
    }

    const body = slides.length > 0 ? `${slides.join("\n\n---\n\n")}\n` : "";
    if (this.frontmatter) {
      return `${this.frontmatter}\n\n${body}`;
    }
    return body;
  }

  /** Load a Markdown slide deck written by toMarkdown. */
  fromMarkdown(markdown: string): void {
    const root: OutlineNode = {
      id: "root",
      title: "Article Outline",
      description: "",
      notes: "",
      children: [],
      collapsed: false,
    };
    const stack: Array<{ node: OutlineNode; level: number }> = [];
    let nextId = 1;
    let lastNode: OutlineNode | null = null;

    const allLines = markdown.replace(/\r\n?/g, "\n").split("\n");
    let lineIdx = 0;

    // Detect and preserve YAML frontmatter
    if (allLines.length > 0 && allLines[0].trim() === "---") {
      const frontmatterLines: string[] = [allLines[0]];
      lineIdx = 1;
      while (lineIdx < allLines.length) {
        frontmatterLines.push(allLines[lineIdx]);
        if (allLines[lineIdx].trim() === "---") {
          lineIdx++;
          break;
        }
        lineIdx++;
      }
      this.frontmatter = frontmatterLines.join("\n");
    } else {
      this.frontmatter = "";
    }

    // Blank lines are only meaningful once more description text follows them,
    // so hold them back rather than writing trailing whitespace into a node.
    let pendingBlanks = 0;
    let notesLines: string[] | null = null;
    let inFence = false;

    const appendToDescription = (raw: string) => {
      if (!lastNode) return;
      lastNode.description +=
        (lastNode.description ? "\n".repeat(pendingBlanks + 1) : "") + raw;
      pendingBlanks = 0;
    };

    for (let i = lineIdx; i < allLines.length; i++) {
      const rawLine = allLines[i];

      if (notesLines) {
        if (NOTES_CLOSE_RE.test(rawLine)) {
          if (lastNode) lastNode.notes = notesLines.join("\n").replace(/\s+$/, "");
          notesLines = null;
        } else {
          notesLines.push(rawLine);
        }
        continue;
      }

      if (FENCE_RE.test(rawLine)) {
        inFence = !inFence;
        appendToDescription(rawLine);
        continue;
      }

      if (inFence) {
        if (lastNode && !rawLine.trim()) {
          if (lastNode.description) pendingBlanks++;
        } else {
          appendToDescription(rawLine);
        }
        continue;
      }

      const heading = rawLine.match(HEADING_RE);
      if (heading) {
        const level = heading[1].length;
        const node: OutlineNode = {
          id: `node-${nextId++}`,
          title: heading[2].trim(),
          description: "",
          notes: "",
          children: [],
          collapsed: false,
        };
        while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
        const parent = stack.length ? stack[stack.length - 1].node : root;
        parent.children.push(node);
        stack.push({ node, level });
        lastNode = node;
        pendingBlanks = 0;
      } else if (lastNode && NOTES_OPEN_RE.test(rawLine)) {
        notesLines = [];
        pendingBlanks = 0;
      } else if (rawLine.trim() === "---") {
        pendingBlanks = 0;
      } else if (lastNode && !rawLine.trim()) {
        if (lastNode.description) pendingBlanks++;
      } else if (lastNode) {
        appendToDescription(rawLine);
      }
    }

    // An unterminated `::: notes` block still belongs to its node.
    if (notesLines && lastNode) {
      lastNode.notes = notesLines.join("\n").replace(/\s+$/, "");
    }

    this.root = root;
    this.nextId = nextId;
  }

  getVisibleNodes(): OutlineNode[] {
    const visible: OutlineNode[] = [];
    const walk = (node: OutlineNode, depth: number) => {
      if (node.id !== "root") {
        visible.push(node);
      }
      if (!node.collapsed && node.children.length > 0) {
        for (const child of node.children) {
          walk(child, depth + 1);
        }
      }
    };
    walk(this.root, 0);
    return visible;
  }

  setAllCollapsed(collapsed: boolean): void {
    this.walkNodes(this.root, (node) => {
      if (node.id !== "root") node.collapsed = collapsed;
    });
  }

  getNodeDepth(nodeId: string): number {
    let depth = 0;
    let current = this.findNode(nodeId);
    while (current && current.id !== "root") {
      depth++;
      current = this.findParent(this.root, current.id);
    }
    return depth;
  }
}

// ANSI and visual width terminal helpers to prevent any layout overflow
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function stringWidth(str: string): number {
  return stripAnsi(str).length;
}

function truncateToWidth(str: string, maxWidth: number, ellipsis: boolean = true): string {
  if (maxWidth <= 0) return "";
  const sw = stringWidth(str);
  if (sw <= maxWidth) return str;

  if (!str.includes("\x1b")) {
    if (ellipsis && maxWidth > 3) {
      return str.slice(0, maxWidth - 3) + "...";
    }
    return str.slice(0, maxWidth);
  }

  const targetLen = ellipsis && maxWidth > 3 ? maxWidth - 3 : maxWidth;
  let result = "";
  let visibleLen = 0;
  const regex = /(\x1b\[[0-9;]*[a-zA-Z])|([^\x1b])/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(str)) !== null) {
    if (match[1]) {
      result += match[1];
    } else if (match[2]) {
      if (visibleLen < targetLen) {
        result += match[2];
        visibleLen++;
      } else {
        break;
      }
    }
  }
  result += "\x1b[0m";
  if (ellipsis && maxWidth > 3) {
    result += "...";
  }
  return result;
}

function padRight(str: string, targetWidth: number): string {
  const sw = stringWidth(str);
  if (sw >= targetWidth) return str;
  return str + " ".repeat(targetWidth - sw);
}

/** True only for keys that carry literal text, never for escape sequences. */
function isPrintable(key: readline.Key): boolean {
  const seq = key.sequence;
  return !!seq && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(seq);
}

/**
 * Terminal keypress events report Shift+<letter> as the *lowercase* name with
 * `shift: true`, so dispatching on `key.name` alone silently folds E/G/H/J/K/
 * L/O/R onto their lowercase commands. Fold the shift back in, and fall back
 * to the raw sequence for punctuation, which carries no name.
 */
function normalKeyToken(key: readline.Key): string {
  const name = key.name || "";
  if (key.shift && /^[a-z]$/.test(name)) return name.toUpperCase();
  return name || key.sequence || "";
}

/**
 * Collapse a keypress to the token the EDIT-NAV and VISUAL dispatchers match on.
 *
 * Matching on `sequence || name` cannot work for both halves of a vim keymap:
 * a printable key has to match its literal (`$`, `^`, `V` differ from their
 * names), but every other key arrives with a non-empty `sequence` too — Tab is
 * `"\t"`, Right is `"\x1b[C"` — which shadows the name and makes those cases
 * unreachable. So: printables by sequence, everything else by name.
 */
function editKeyToken(key: readline.Key): string {
  const seq = key.sequence || "";
  if (seq.length === 1 && seq >= " " && seq !== "\x7f") return seq;
  return key.name || seq;
}

/**
 * Word-wrap one logical line into visual rows, preserving the original
 * characters exactly and recording where each row starts within the line.
 * Those offsets are what let a cursor position be mapped onto the wrapped
 * layout, so an edited line can be soft-wrapped instead of scrolled sideways.
 */
function wrapLineSegments(
  line: string,
  firstWidth: number,
  contWidth: number
): Array<{ text: string; start: number }> {
  const segments: Array<{ text: string; start: number }> = [];
  let start = 0;
  let width = Math.max(1, firstWidth);

  for (;;) {
    if (line.length - start <= width) {
      segments.push({ text: line.slice(start), start });
      return segments;
    }
    // Break at the last space inside the window; words longer than the pane
    // fall back to a hard break.
    let breakAt = -1;
    for (let i = start + width; i > start; i--) {
      if (line[i] === " " || line[i] === "\t") {
        breakAt = i;
        break;
      }
    }
    const end = breakAt > start ? breakAt : start + width;
    segments.push({ text: line.slice(start, end), start });
    start = breakAt > start ? breakAt + 1 : end;
    width = Math.max(1, contWidth);
  }
}

// ANSI styles used by the lightweight markdown highlighter below. Reused
// as-is (no blending) — each character gets at most one style.
export const MD_CAUTION = "\x1b[33m";
export const MD_STRUCTURE = "\x1b[1m";
export const MD_DIM = "\x1b[2m";
export const MD_CODE = "\x1b[36m";
export const MD_BOLD = "\x1b[1m";
export const MD_ITALIC = "\x1b[3m";

/**
 * Per-character ANSI style codes for one field's lines, used by
 * `renderTextBlock` to lightly highlight markdown syntax without touching
 * the underlying text (styling is purely an output-composition step).
 *
 * `trackStructure` is true for the description field, where `fromMarkdown`
 * treats a heading line, a bare `---`, or a `::: notes` line as document
 * structure — but only *outside* a fenced code block, which it now (see
 * `FENCE_RE`) treats as inert. Those still-live ambiguities are flagged in
 * caution color so the risk is visible while typing, not just on reload.
 * Notes content never splits on any of that — only a bare `:::` line closes
 * the div early — so `trackStructure` is false there and fence markers are
 * rendered as ordinary text.
 */
export function computeMarkdownStyles(lines: string[], trackStructure: boolean): string[][] {
  const kind: Array<"fence-delim" | "fence-content" | "normal"> = [];
  if (trackStructure) {
    let inFence = false;
    for (const line of lines) {
      if (FENCE_RE.test(line)) {
        kind.push("fence-delim");
        inFence = !inFence;
      } else {
        kind.push(inFence ? "fence-content" : "normal");
      }
    }
  } else {
    for (const _line of lines) kind.push("normal");
  }

  return lines.map((line, i) => {
    const styles = new Array<string>(line.length).fill("");
    const mark = (start: number, end: number, style: string) => {
      for (let c = Math.max(0, start); c < end && c < styles.length; c++) styles[c] = style;
    };

    if (kind[i] === "fence-delim") {
      mark(0, line.length, MD_STRUCTURE);
      return styles;
    }
    if (kind[i] === "fence-content") {
      return styles;
    }

    if (NOTES_CLOSE_RE.test(line)) {
      mark(0, line.length, trackStructure ? MD_CAUTION : MD_STRUCTURE);
      return styles;
    }
    if (trackStructure && (HEADING_RE.test(line) || line.trim() === "---" || NOTES_OPEN_RE.test(line))) {
      mark(0, line.length, MD_CAUTION);
      return styles;
    }

    // Manual regex.exec loops, not matchAll()/for-of: this project's
    // documented test-build command compiles without an explicit --target,
    // so tsc downlevels for-of to array-style indexing that silently never
    // runs over a bare iterator (no .length). exec-loops compile safely at
    // any target, matching the pattern truncateToWidth already uses above.
    let m: RegExpExecArray | null;

    const codeRe = /`([^`]+)`/g;
    while ((m = codeRe.exec(line)) !== null) {
      const s = m.index;
      mark(s, s + 1, MD_DIM);
      mark(s + 1, s + 1 + m[1].length, MD_CODE);
      mark(s + 1 + m[1].length, s + m[0].length, MD_DIM);
    }
    const boldRe = /(\*\*|__)(.+?)\1/g;
    while ((m = boldRe.exec(line)) !== null) {
      const s = m.index;
      mark(s, s + 2, MD_DIM);
      mark(s + 2, s + 2 + m[2].length, MD_BOLD);
      mark(s + 2 + m[2].length, s + m[0].length, MD_DIM);
    }
    const italicRe = /(?<!\*)\*([^*\n]+)\*(?!\*)|(?<!_)_([^_\n]+)_(?!_)/g;
    while ((m = italicRe.exec(line)) !== null) {
      const s = m.index;
      const inner = (m[1] ?? m[2] ?? "").length;
      mark(s, s + 1, MD_DIM);
      mark(s + 1, s + 1 + inner, MD_ITALIC);
      mark(s + 1 + inner, s + m[0].length, MD_DIM);
    }
    const linkRe = /(!?\[)([^\]]*)(\]\()([^)]*)(\))/g;
    while ((m = linkRe.exec(line)) !== null) {
      let pos = m.index;
      mark(pos, pos + m[1].length, MD_DIM);
      pos += m[1].length + m[2].length;
      mark(pos, pos + m[3].length, MD_DIM);
      pos += m[3].length + m[4].length;
      mark(pos, pos + m[5].length, MD_DIM);
    }
    const blockquote = line.match(/^(\s*>+\s?)/);
    if (blockquote) mark(0, blockquote[1].length, MD_DIM);
    const listMarker = line.match(/^(\s*)([-*+]|\d+\.)(\s+)/);
    if (listMarker) mark(listMarker[1].length, listMarker[1].length + listMarker[2].length, MD_DIM);
    if (line.includes("|")) {
      for (let c = 0; c < line.length; c++) {
        if (line[c] === "|") styles[c] = MD_DIM;
      }
    }

    return styles;
  });
}

/**
 * Apply per-character style codes to plain text, coalescing consecutive
 * identical styles into a single escape/reset pair rather than wrapping
 * every character individually.
 */
function applyLineStyles(text: string, styles: string[]): string {
  let out = "";
  let openStyle: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const style = styles[i] || null;
    if (style !== openStyle) {
      if (openStyle !== null) out += "\x1b[0m";
      if (style !== null) out += style;
      openStyle = style;
    }
    out += text[i];
  }
  if (openStyle !== null) out += "\x1b[0m";
  return out;
}

function getCursorLineInfo(text: string, index: number) {
  const clamped = Math.max(0, Math.min(index, text.length));
  const before = text.slice(0, clamped);
  const lineStart = before.lastIndexOf("\n") + 1;
  const nextNewline = text.indexOf("\n", clamped);
  const lineEnd = nextNewline === -1 ? text.length : nextNewline;
  const lineText = text.slice(lineStart, lineEnd);
  const col = clamped - lineStart;
  const lines = text.split("\n");
  const line = before.split("\n").length - 1;
  return { line, col, lineStart, lineEnd, lineText, lines };
}

type EditField = "title" | "description" | "notes";

// After a lone ESC, Node's readline waits `escapeCodeTimeout` ms (500 by
// default) for the rest of a possible escape sequence before emitting the key.
// That wait is exactly what makes leaving INSERT/EDIT-NAV feel sluggish. Drop
// it to something imperceptible; raise OUTLINE_ESCAPE_TIMEOUT if a slow link
// splits genuine escape sequences across reads.
// Continuation rows of a wrapped line are indented so a wrap reads differently
// from a genuine line break in a bullet list.
const WRAP_CONTINUATION_INDENT = 2;

const ESCAPE_CODE_TIMEOUT = (() => {
  const configured = Number(process.env.OUTLINE_ESCAPE_TIMEOUT);
  return Number.isFinite(configured) && configured >= 0 ? configured : 25;
})();

// Direct-manipulation terminal UI using Node.js built-ins.
export class OutlineEditorTUI {
  private outline: Outline = new Outline();
  private filename: string;
  private currentIndex: number = 0;
  private scrollOffset: number = 0;
  // Navigation levels and modes:
  // "NORMAL" (outline tree navigation)
  // "EDIT_NORMAL" (node text navigation before typing changes)
  // "VISUAL" (characterwise or linewise visual selection)
  // "INSERT" (typing changes)
  // "COMMAND" (ex commands :w, :q, etc.)
  private mode: "NORMAL" | "EDIT_NORMAL" | "VISUAL" | "INSERT" | "COMMAND" | "SHELL" = "NORMAL";
  private shellResumeIsTTY: boolean = false;
  private visualType: "char" | "line" = "char";
  private visualAnchor: number = 0;
  private clipboard: { text: string; isLinewise: boolean } | null = null;
  private input: string = "";
  private inputCursor: number = 0;
  private editField: EditField = "title";
  private pendingEditOp: string = "";
  private pendingCtrlW: boolean = false;
  private pendingVisualG: boolean = false;
  private textUndoStack: { input: string; cursor: number }[] = [];
  private textRedoStack: { input: string; cursor: number }[] = [];
  private command: string = "";
  private commandCursor: number = 0;
  private statusMessage: string = "Ready";
  private statusIsError: boolean = false;
  // The markdown that was last written to (or read from) disk. Dirtiness is
  // derived from it rather than tracked with a flag, because a flag set by
  // `snapshot()` also fires when a node is merely opened for editing — and
  // auto-reload keys off dirtiness, so a false positive there silently
  // disables the refresh for the rest of the session.
  private savedMarkdown: string = "";
  private fileWatcher: fs.FSWatcher | null = null;
  private fileMtimeMs: number = 0;
  private diskFileModified: boolean = false;
  private pendingReload: boolean = false;
  private reloadDebounceTimer: NodeJS.Timeout | null = null;
  private closed: boolean = false;
  private onClosed: (() => void) | null = null;
  private showHelpOverlay: boolean = false;
  private helpScroll: number = 0;
  private pendingSequence: string = "";
  private undoStack: OutlineNode[] = [];
  private redoStack: OutlineNode[] = [];
  private commandHistory: string[] = [];
  private commandHistoryIdx: number = -1;

  private readonly onKey = (_: string, key: readline.Key) => this.handleKeypress(key);
  private readonly onResize = () => this.render();
  private readonly onSignal = () => this.quit(true);

  constructor(filename: string = "outline.md") {
    this.filename = filename;
    if (fs.existsSync(filename)) {
      try {
        const data = fs.readFileSync(filename, "utf8");
        this.outline.fromMarkdown(data);
        this.statusMessage = `Loaded ${filename}`;
        this.statusIsError = false;
      } catch (err) {
        this.statusMessage = `Error loading ${filename}: ${err instanceof Error ? err.message : String(err)}`;
        this.statusIsError = true;
      }
    } else {
      this.outline.addChild("root", "Introduction");
      this.outline.addChild("root", "Main Content");
      this.outline.addChild("root", "Conclusion");
      const mainContent = this.outline.root.children[1];
      this.outline.addChild(mainContent.id, "Section 1");
      this.outline.addChild(mainContent.id, "Section 2");
    }
    this.markSaved();
    this.initFileWatcher();
  }

  async run(): Promise<void> {
    readline.emitKeypressEvents(
      process.stdin,
      { escapeCodeTimeout: ESCAPE_CODE_TIMEOUT } as unknown as readline.Interface
    );
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.on("keypress", this.onKey);
    process.stdout.on("resize", this.onResize);

    process.on("SIGINT", this.onSignal);
    process.on("SIGTERM", this.onSignal);

    process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J");
    this.render();

    // quit() resolves this directly; polling only added shutdown latency.
    await new Promise<void>((resolve) => {
      if (this.closed) resolve();
      else this.onClosed = resolve;
    });
  }

  private get visibleNodes(): OutlineNode[] {
    return this.outline.getVisibleNodes();
  }

  /** Description and notes are multi-line; titles are a single line. */
  private get editingMultiline(): boolean {
    return this.editField !== "title";
  }

  private get editFieldLabel(): string {
    return this.editField === "notes" ? "notes" : this.editField === "description" ? "description" : "title";
  }

  private get selectedNode(): OutlineNode | null {
    const nodes = this.visibleNodes;
    return nodes[this.currentIndex] || null;
  }

  private clampSelection(): void {
    const total = this.visibleNodes.length;
    if (total === 0) {
      this.currentIndex = 0;
      this.scrollOffset = 0;
    } else {
      this.currentIndex = Math.max(0, Math.min(this.currentIndex, total - 1));
    }
  }

  /**
   * True when what would be written to disk differs from what is on it.
   *
   * Two independent sources of dirt: the tree itself, compared through
   * `toMarkdown()` because that is exactly what gets persisted (so folding a
   * node, which only touches `collapsed`, never counts), and the edit buffer,
   * whose text is not committed back into the node until the edit finishes.
   *
   * Derived rather than tracked with a flag: `snapshot()` runs when a node is
   * merely opened for editing, so a flag it set would report dirt after an
   * `e` `Esc` that changed nothing — and auto-reload keys off dirtiness, so
   * that false positive would disable the refresh for the rest of the session.
   */
  private get modified(): boolean {
    return this.outline.toMarkdown() !== this.savedMarkdown || this.bufferDirty;
  }

  /** Uncommitted text in the edit buffer, which lives outside the tree. */
  private get bufferDirty(): boolean {
    if (this.mode !== "EDIT_NORMAL" && this.mode !== "INSERT" && this.mode !== "VISUAL") {
      return false;
    }
    const node = this.selectedNode;
    return node ? this.input !== this.readField(node) : false;
  }

  /** Re-baseline dirtiness against the tree as it now stands on disk. */
  private markSaved(): void {
    this.savedMarkdown = this.outline.toMarkdown();
  }

  private snapshot(): void {
    this.undoStack.push(this.outline.cloneTree());
    if (this.undoStack.length > 100) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  private moveSelection(delta: number): void {
    this.currentIndex += delta;
    this.clampSelection();
  }

  private jumpTop(): void {
    this.currentIndex = 0;
  }

  private jumpBottom(): void {
    this.currentIndex = Math.max(0, this.visibleNodes.length - 1);
  }

  private nextSibling(): void {
    const node = this.selectedNode;
    if (!node) return;
    const parent = this.outline.findParent(this.outline.root, node.id);
    if (!parent) return;
    const idx = parent.children.indexOf(node);
    if (idx >= 0 && idx < parent.children.length - 1) {
      const next = parent.children[idx + 1];
      const visible = this.visibleNodes;
      const targetIdx = visible.findIndex((item) => item.id === next.id);
      if (targetIdx >= 0) this.currentIndex = targetIdx;
    }
  }

  private previousSibling(): void {
    const node = this.selectedNode;
    if (!node) return;
    const parent = this.outline.findParent(this.outline.root, node.id);
    if (!parent) return;
    const idx = parent.children.indexOf(node);
    if (idx > 0) {
      const prev = parent.children[idx - 1];
      const visible = this.visibleNodes;
      const targetIdx = visible.findIndex((item) => item.id === prev.id);
      if (targetIdx >= 0) this.currentIndex = targetIdx;
    }
  }

  private moveSibling(delta: number): void {
    const node = this.selectedNode;
    if (!node) return;
    const parent = this.outline.findParent(this.outline.root, node.id);
    if (!parent) return;
    const idx = parent.children.indexOf(node);
    const targetIdx = idx + delta;
    if (targetIdx >= 0 && targetIdx < parent.children.length) {
      this.snapshot();
      parent.children[idx] = parent.children[targetIdx];
      parent.children[targetIdx] = node;
      const visible = this.visibleNodes;
      this.currentIndex = visible.findIndex((item) => item.id === node.id);
      this.statusMessage = delta > 0 ? "Moved item down" : "Moved item up";
      this.statusIsError = false;
    }
  }

  private indentNode(): void {
    const node = this.selectedNode;
    if (!node) return;
    const parent = this.outline.findParent(this.outline.root, node.id);
    if (!parent) return;
    const idx = parent.children.indexOf(node);
    if (idx > 0) {
      this.snapshot();
      const prevSibling = parent.children[idx - 1];
      parent.children.splice(idx, 1);
      prevSibling.children.push(node);
      prevSibling.collapsed = false;
      const visible = this.visibleNodes;
      this.currentIndex = visible.findIndex((item) => item.id === node.id);
      this.statusMessage = `Demoted under "${prevSibling.title || 'Untitled'}"`;
      this.statusIsError = false;
    }
  }

  private dedentNode(): void {
    const node = this.selectedNode;
    if (!node) return;
    const parent = this.outline.findParent(this.outline.root, node.id);
    if (!parent || parent.id === "root") return;
    const grandparent = this.outline.findParent(this.outline.root, parent.id);
    if (!grandparent) return;

    this.snapshot();
    parent.children.splice(parent.children.indexOf(node), 1);
    const parentIdx = grandparent.children.indexOf(parent);
    grandparent.children.splice(parentIdx + 1, 0, node);
    const visible = this.visibleNodes;
    this.currentIndex = visible.findIndex((item) => item.id === node.id);
    this.statusMessage = `Promoted to sibling of "${parent.title || 'Untitled'}"`;
    this.statusIsError = false;
  }

  private toggleFold(forceExpand?: boolean): void {
    const node = this.selectedNode;
    if (!node || node.children.length === 0) return;
    if (forceExpand === undefined) {
      this.outline.toggleCollapse(node.id);
    } else {
      node.collapsed = !forceExpand;
    }
    this.clampSelection();
  }

  private pushTextUndo(): void {
    this.textUndoStack.push({ input: this.input, cursor: this.inputCursor });
    if (this.textUndoStack.length > 50) this.textUndoStack.shift();
    this.textRedoStack = [];
  }

  private popTextUndo(): void {
    if (this.textUndoStack.length > 0) {
      const state = this.textUndoStack.pop()!;
      this.textRedoStack.push({ input: this.input, cursor: this.inputCursor });
      this.input = state.input;
      this.inputCursor = Math.min(this.input.length, state.cursor);
    }
  }

  private popTextRedo(): void {
    if (this.textRedoStack.length > 0) {
      const state = this.textRedoStack.pop()!;
      this.textUndoStack.push({ input: this.input, cursor: this.inputCursor });
      this.input = state.input;
      this.inputCursor = Math.min(this.input.length, state.cursor);
    }
  }

  private findNextWordStart(text: string, index: number): number {
    if (index >= text.length) return index;
    let i = index;
    const isWordChar = (c: string) => /[a-zA-Z0-9_]/.test(c);
    const startType = isWordChar(text[i]);
    if (text[i] !== " " && text[i] !== "\n") {
      while (i < text.length && text[i] !== " " && text[i] !== "\n" && isWordChar(text[i]) === startType) {
        i++;
      }
    }
    while (i < text.length && (text[i] === " " || text[i] === "\t")) {
      i++;
    }
    return Math.min(text.length, i);
  }

  private findPrevWordStart(text: string, index: number): number {
    if (index <= 0) return 0;
    let i = index - 1;
    while (i > 0 && (text[i] === " " || text[i] === "\t")) {
      i--;
    }
    const isWordChar = (c: string) => /[a-zA-Z0-9_]/.test(c);
    const targetType = isWordChar(text[i]);
    while (i > 0 && text[i - 1] !== " " && text[i - 1] !== "\n" && isWordChar(text[i - 1]) === targetType) {
      i--;
    }
    return Math.max(0, i);
  }

  private findCurrentWordEnd(text: string, index: number): number {
    if (index >= text.length) return text.length;
    const isWordChar = (c: string) => /[a-zA-Z0-9_]/.test(c);
    let i = index;
    // If we are not at the end of the current token, advance within it first.
    if (text[i] !== " " && text[i] !== "\t" && text[i] !== "\n") {
      const startType = isWordChar(text[i]);
      while (i + 1 < text.length && text[i + 1] !== " " && text[i + 1] !== "\t" && text[i + 1] !== "\n" && isWordChar(text[i + 1]) === startType) {
        i++;
      }
      // If we actually moved, we found the end of the current word.
      if (i > index) return i;
    }
    // We were already at a word boundary (or at whitespace). Skip whitespace then find end of next token.
    i++;
    while (i < text.length && (text[i] === " " || text[i] === "\t")) {
      i++;
    }
    if (i < text.length) {
      const targetType = isWordChar(text[i]);
      while (i + 1 < text.length && text[i + 1] !== " " && text[i + 1] !== "\t" && text[i + 1] !== "\n" && isWordChar(text[i + 1]) === targetType) {
        i++;
      }
    }
    return Math.min(text.length - 1, i);
  }

  private beginEdit(
    kind: "siblingBelow" | "siblingAbove" | "child" | "title" | "description" | "notes"
  ): void {
    const current = this.selectedNode;
    this.snapshot();
    this.editField = kind === "description" || kind === "notes" ? kind : "title";
    this.textUndoStack = [];
    this.textRedoStack = [];
    this.pendingEditOp = "";

    if (kind === "child") {
      const targetId = current ? current.id : "root";
      const newNode = this.outline.addChild(targetId, "");
      if (current) current.collapsed = false;
      const visible = this.visibleNodes;
      this.currentIndex = visible.findIndex((item) => item.id === newNode.id);
      this.input = "";
      this.inputCursor = 0;
      this.mode = "INSERT";
    } else if (kind === "siblingBelow") {
      if (!current) {
        const newNode = this.outline.addChild("root", "");
        this.currentIndex = 0;
        this.input = "";
        this.inputCursor = 0;
      } else {
        const newNode = this.outline.addSibling(current.id, "");
        const visible = this.visibleNodes;
        this.currentIndex = visible.findIndex((item) => item.id === newNode.id);
        this.input = "";
        this.inputCursor = 0;
      }
      this.mode = "INSERT";
    } else if (kind === "siblingAbove") {
      if (!current) {
        const newNode = this.outline.addChild("root", "");
        this.currentIndex = 0;
        this.input = "";
        this.inputCursor = 0;
      } else {
        const newNode = this.outline.addSiblingBefore(current.id, "");
        const visible = this.visibleNodes;
        this.currentIndex = visible.findIndex((item) => item.id === newNode.id);
        this.input = "";
        this.inputCursor = 0;
      }
      this.mode = "INSERT";
    } else {
      if (!current) {
        this.mode = "NORMAL";
        return;
      }
      this.input = this.readField(current);
      if (this.editingMultiline && !this.input) {
        // Empty field: go straight to INSERT so the user can type immediately
        this.inputCursor = 0;
        this.mode = "INSERT";
      } else {
        // Multi-line fields open at the start, like a freshly opened buffer, so
        // the pane shows the text from the top. Titles open at the last
        // character, ready for appending.
        this.inputCursor = this.editingMultiline ? 0 : Math.max(0, this.input.length - 1);
        // Level 2: Enter node text navigation before typing changes
        this.mode = "EDIT_NORMAL";
        this.statusMessage = `Navigating ${this.editFieldLabel} — h/l/w/b:Move  i/a:Insert  Esc/Enter:Done`;
        this.statusIsError = false;
      }
    }
  }

  private readField(node: OutlineNode): string {
    if (this.editField === "description") return node.description;
    if (this.editField === "notes") return node.notes;
    return node.title;
  }

  private commitField(): void {
    const node = this.selectedNode;
    if (node) {
      if (this.editField === "description") {
        node.description = this.input;
      } else if (this.editField === "notes") {
        node.notes = this.input;
      } else {
        node.title = this.input.trim() || "Untitled";
      }
    }
  }

  private finishEdit(): void {
    this.commitField();
    this.mode = "NORMAL";
    this.input = "";
    this.inputCursor = 0;
    this.editField = "title";
    this.pendingEditOp = "";
    this.pendingCtrlW = false;
    this.pendingVisualG = false;
    this.textUndoStack = [];
    this.textRedoStack = [];
    this.statusMessage = "Ready";
    this.statusIsError = false;
    this.applyPendingReload();
  }

  private cancelEdit(): void {
    const node = this.selectedNode;
    if (node && !node.title && this.editField === "title") {
      // A new node was created but the user cancelled without entering a title.
      // Pop the snapshot that beginEdit pushed so undo history stays clean.
      const prev = this.undoStack.pop();
      if (prev) {
        try {
          this.outline.restoreTree(prev);
          this.redoStack = [];
        } catch {
          // If restore fails, fall back to plain delete.
          this.outline.deleteNode(node.id);
        }
      } else {
        this.outline.deleteNode(node.id);
      }
      this.clampSelection();
    }
    this.mode = "NORMAL";
    this.input = "";
    this.inputCursor = 0;
    this.editField = "title";
    this.pendingEditOp = "";
    this.pendingCtrlW = false;
    this.pendingVisualG = false;
    this.textUndoStack = [];
    this.textRedoStack = [];
    this.applyPendingReload();
  }

  private switchPane(targetField?: EditField): void {
    const current = this.selectedNode;
    if (!current) return;
    this.commitField();
    const order: EditField[] = ["title", "description", "notes"];
    const currentIdx = order.indexOf(this.editField);
    const nextField = targetField || order[(currentIdx + 1) % order.length];
    this.editField = nextField;
    this.input = this.readField(current);
    this.inputCursor = this.editingMultiline ? 0 : Math.max(0, this.input.length - 1);
    this.mode = "EDIT_NORMAL";
    this.pendingEditOp = "";
    this.pendingCtrlW = false;
    this.textUndoStack = [];
    this.textRedoStack = [];
    this.statusMessage = `Navigating ${this.editFieldLabel} — h/l/w/b:Move  i/a:Insert  v:Visual  Tab:Pane  Esc/Enter:Done`;
    this.statusIsError = false;
  }

  private switchPanePrev(): void {
    // No commitField here: switchPane does it, and doing it twice wrote the
    // same buffer back into the node on every Shift+Tab.
    const order: EditField[] = ["title", "description", "notes"];
    const currentIdx = order.indexOf(this.editField);
    this.switchPane(order[(currentIdx + order.length - 1) % order.length]);
  }

  private getSelectionRange(): { start: number; end: number; text: string; isLinewise: boolean } {
    if (this.visualType === "line") {
      const aInfo = getCursorLineInfo(this.input, this.visualAnchor);
      const cInfo = getCursorLineInfo(this.input, this.inputCursor);
      const minLine = Math.min(aInfo.line, cInfo.line);
      const maxLine = Math.max(aInfo.line, cInfo.line);
      const lines = aInfo.lines;
      let lineStart = 0;
      for (let i = 0; i < minLine; i++) {
        lineStart += lines[i].length + 1;
      }
      let lineEnd = lineStart;
      for (let i = minLine; i <= maxLine; i++) {
        lineEnd += lines[i].length + (i < lines.length - 1 ? 1 : 0);
      }
      const text = this.input.slice(lineStart, lineEnd);
      return {
        start: lineStart,
        end: Math.max(lineStart, lineEnd > lineStart ? lineEnd - 1 : lineStart),
        text,
        isLinewise: true,
      };
    } else {
      const start = Math.min(this.visualAnchor, this.inputCursor);
      const end = Math.max(this.visualAnchor, this.inputCursor);
      const text = this.input.length > 0 ? this.input.slice(start, end + 1) : "";
      return { start, end, text, isLinewise: false };
    }
  }

  private yankSelection(): void {
    if (!this.input) {
      this.mode = "EDIT_NORMAL";
      this.statusMessage = "Nothing to yank";
      this.statusIsError = false;
      return;
    }
    const sel = this.getSelectionRange();
    this.clipboard = { text: sel.text, isLinewise: sel.isLinewise };
    this.mode = "EDIT_NORMAL";
    this.inputCursor = sel.start;
    const countDesc = sel.isLinewise
      ? `${sel.text.split("\n").filter((_, idx, arr) => idx < arr.length - 1 || arr[idx].length > 0).length} lines`
      : `${sel.text.length} chars`;
    this.statusMessage = `Yanked ${countDesc} to clipboard`;
    this.statusIsError = false;
  }

  private deleteSelection(isChange: boolean = false): void {
    if (!this.input) {
      this.mode = isChange ? "INSERT" : "EDIT_NORMAL";
      return;
    }
    this.pushTextUndo();
    const sel = this.getSelectionRange();
    this.clipboard = { text: sel.text, isLinewise: sel.isLinewise };
    if (sel.isLinewise) {
      const lines = this.input.split("\n");
      const aInfo = getCursorLineInfo(this.input, this.visualAnchor);
      const cInfo = getCursorLineInfo(this.input, this.inputCursor);
      const minLine = Math.min(aInfo.line, cInfo.line);
      const maxLine = Math.max(aInfo.line, cInfo.line);
      lines.splice(minLine, maxLine - minLine + 1);
      this.input = lines.join("\n");
      const newLines = this.input.split("\n");
      const targetLine = Math.min(minLine, Math.max(0, newLines.length - 1));
      let pos = 0;
      for (let i = 0; i < targetLine; i++) pos += newLines[i].length + 1;
      this.inputCursor = pos;
    } else {
      this.input = this.input.slice(0, sel.start) + this.input.slice(sel.end + 1);
      this.inputCursor = Math.min(sel.start, Math.max(0, this.input.length - 1));
    }
    if (isChange) {
      this.mode = "INSERT";
    } else {
      this.mode = "EDIT_NORMAL";
      this.statusMessage = `Cut ${sel.isLinewise ? "lines" : `${sel.text.length} chars`} to clipboard`;
      this.statusIsError = false;
    }
  }

  private pasteInEditMode(before: boolean = false): void {
    if (!this.clipboard || !this.clipboard.text) {
      this.statusMessage = "Clipboard is empty";
      this.statusIsError = true;
      return;
    }
    this.pushTextUndo();
    // A single-line field has nowhere to put a line break. Trailing newlines
    // are dropped rather than turned into spaces — a linewise yank always
    // carries one, and substituting it left a stray space on every paste.
    const flatten = (text: string): string =>
      this.editingMultiline ? text : text.replace(/[\r\n]+$/, "").replace(/\r?\n/g, " ");

    if (this.mode === "VISUAL") {
      const sel = this.getSelectionRange();
      const pasteText = flatten(this.clipboard.text);
      this.input = this.input.slice(0, sel.start) + pasteText + this.input.slice(sel.end + 1);
      this.inputCursor = sel.start + Math.max(0, pasteText.length - 1);
      this.mode = "EDIT_NORMAL";
    } else {
      const pasteText = flatten(this.clipboard.text);
      if (this.clipboard.isLinewise && !this.editingMultiline) {
        // Linewise content into a one-line field: the nearest thing to "put
        // the line above/below" is the head or tail of the field. Splicing it
        // at the cursor instead would drop it into the middle of a word.
        if (this.input.length === 0) {
          this.input = pasteText;
          this.inputCursor = Math.max(0, pasteText.length - 1);
        } else if (before) {
          this.input = `${pasteText} ${this.input}`;
          this.inputCursor = 0;
        } else {
          this.inputCursor = this.input.length + 1;
          this.input = `${this.input} ${pasteText}`;
        }
      } else if (this.clipboard.isLinewise && this.editingMultiline) {
        const info = getCursorLineInfo(this.input, this.inputCursor);
        const textToInsert = pasteText.endsWith("\n") ? pasteText : pasteText + "\n";
        if (before) {
          this.input = this.input.slice(0, info.lineStart) + textToInsert + this.input.slice(info.lineStart);
          this.inputCursor = info.lineStart;
        } else {
          const insertPos = info.lineEnd < this.input.length ? info.lineEnd + 1 : this.input.length;
          const prefix = info.lineEnd === this.input.length && this.input.length > 0 && !this.input.endsWith("\n") ? "\n" : "";
          this.input = this.input.slice(0, insertPos) + prefix + textToInsert + this.input.slice(insertPos);
          this.inputCursor = insertPos + prefix.length;
        }
      } else {
        if (this.input.length === 0) {
          this.input = pasteText;
          this.inputCursor = Math.max(0, pasteText.length - 1);
        } else {
          const insertPos = before ? this.inputCursor : Math.min(this.input.length, this.inputCursor + 1);
          this.input = this.input.slice(0, insertPos) + pasteText + this.input.slice(insertPos);
          this.inputCursor = insertPos + pasteText.length - 1;
        }
      }
    }
    this.statusMessage = "Pasted from clipboard";
    this.statusIsError = false;
  }

  private yankCurrentNode(): void {
    const current = this.selectedNode;
    if (!current) return;
    this.clipboard = { text: current.title, isLinewise: true };
    this.statusMessage = `Yanked node title to clipboard: "${current.title}"`;
    this.statusIsError = false;
  }

  private pasteNode(before: boolean = false): void {
    if (!this.clipboard || !this.clipboard.text) {
      this.statusMessage = "Clipboard is empty";
      this.statusIsError = true;
      return;
    }
    const current = this.selectedNode;
    this.snapshot();
    const rawLines = this.clipboard.text.replace(/\r\n?/g, "\n").trimEnd().split("\n");
    const title = rawLines[0].trim() || "Untitled";
    const description = rawLines.slice(1).join("\n").trim();

    let newNode: OutlineNode;
    if (!current || current.id === "root") {
      newNode = this.outline.addChild("root", title);
    } else if (before) {
      newNode = this.outline.addSiblingBefore(current.id, title);
    } else {
      newNode = this.outline.addSibling(current.id, title);
    }
    if (description) {
      newNode.description = description;
    }
    const visible = this.visibleNodes;
    const idx = visible.findIndex((item) => item.id === newNode.id);
    if (idx >= 0) this.currentIndex = idx;
    this.clampSelection();
    this.statusMessage = `Pasted new node "${title}" from clipboard`;
    this.statusIsError = false;
  }

  // Programmatic testing helpers
  getMode(): string { return this.mode; }
  getEditField(): EditField { return this.editField; }
  getInput(): string { return this.input; }
  getInputCursor(): number { return this.inputCursor; }
  getVisualAnchor(): number { return this.visualAnchor; }
  getVisualType(): "char" | "line" { return this.visualType; }
  getClipboard(): { text: string; isLinewise: boolean } | null { return this.clipboard ? { ...this.clipboard } : null; }
  setClipboard(slot: { text: string; isLinewise: boolean } | null): void { this.clipboard = slot ? { ...slot } : null; }
  isModified(): boolean { return this.modified; }
  isDiskFileModified(): boolean { return this.diskFileModified; }
  getStatusMessage(): string { return this.statusMessage; }
  getOutline(): Outline { return this.outline; }
  getCurrentIndex(): number { return this.currentIndex; }
  /**
   * Feed a keypress in without a terminal.
   *
   * `sequence` defaults only for single-character names: defaulting it for a
   * named key would invent input no terminal sends (readline delivers Tab as
   * `"\t"`, never `"tab"`) and let a test pass against a dispatcher that a
   * real keyboard cannot reach.
   */
  dispatchKey(key: Partial<readline.Key>): void {
    const name = key.name || "";
    const fullKey: readline.Key = {
      sequence: key.sequence !== undefined ? key.sequence : (name.length === 1 ? name : ""),
      name,
      ctrl: !!key.ctrl,
      meta: !!key.meta,
      shift: !!key.shift,
    };
    this.handleKeypress(fullKey);
  }

  private deleteCurrentNode(): void {
    const node = this.selectedNode;
    if (!node) return;
    this.snapshot();
    const title = node.title;
    if (this.outline.deleteNode(node.id)) {
      this.clampSelection();
      this.statusMessage = `Deleted "${title || 'Untitled'}" (press 'u' to undo)`;
      this.statusIsError = false;
    }
  }

  private undo(): void {
    const prev = this.undoStack.pop();
    if (prev) {
      try {
        this.redoStack.push(this.outline.cloneTree());
        this.outline.restoreTree(prev);
        this.clampSelection();
        this.statusMessage = "Undo applied";
        this.statusIsError = false;
      } catch (err) {
        this.statusMessage = `Undo error: ${err instanceof Error ? err.message : String(err)}`;
        this.statusIsError = true;
      }
    } else {
      this.statusMessage = "Already at oldest change";
      this.statusIsError = false;
    }
  }

  private redo(): void {
    const next = this.redoStack.pop();
    if (next) {
      try {
        this.undoStack.push(this.outline.cloneTree());
        this.outline.restoreTree(next);
        this.clampSelection();
        this.statusMessage = "Redo applied";
        this.statusIsError = false;
      } catch (err) {
        this.statusMessage = `Redo error: ${err instanceof Error ? err.message : String(err)}`;
        this.statusIsError = true;
      }
    } else {
      this.statusMessage = "Already at newest change";
      this.statusIsError = false;
    }
  }

  private handleKeypress(key: readline.Key): void {
    if (this.closed) return;

    if (this.mode === "SHELL") {
      this.resumeFromShell();
      return;
    }

    if (this.showHelpOverlay) {
      const token = editKeyToken(key);
      if (token === "escape" || token === "?" || token === "q" || token === "return") {
        this.showHelpOverlay = false;
        this.helpScroll = 0;
      } else if (token === "j" || token === "down") {
        this.helpScroll++;
      } else if (token === "k" || token === "up") {
        this.helpScroll = Math.max(0, this.helpScroll - 1);
      } else if (token === " " || (key.ctrl && key.name === "f") || token === "pagedown") {
        this.helpScroll += 10;
      } else if ((key.ctrl && key.name === "b") || token === "pageup") {
        this.helpScroll = Math.max(0, this.helpScroll - 10);
      } else if (token === "G" || token === "end") {
        this.helpScroll = Number.MAX_SAFE_INTEGER;
      } else if (token === "home") {
        this.helpScroll = 0;
      }
      // render() clamps helpScroll against the height it actually has.
      this.render();
      return;
    }

    if (this.mode === "VISUAL") {
      const seq = editKeyToken(key);

      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        this.mode = "EDIT_NORMAL";
        this.pendingVisualG = false;
        this.statusMessage = "Visual mode cancelled";
        this.statusIsError = false;
        this.render();
        return;
      }

      if (key.ctrl && key.name === "s") {
        this.finishEdit();
        this.saveFile();
        this.render();
        return;
      }

      // Tab or Shift+Tab switches pane
      if (key.name === "tab") {
        if (key.shift) this.switchPanePrev();
        else this.switchPane();
        this.render();
        return;
      }

      // Toggle visual mode type or exit
      if (seq === "v") {
        if (this.visualType === "char") {
          this.mode = "EDIT_NORMAL";
        } else {
          this.visualType = "char";
        }
        this.render();
        return;
      }
      if (seq === "V") {
        if (this.visualType === "line") {
          this.mode = "EDIT_NORMAL";
        } else {
          this.visualType = "line";
        }
        this.render();
        return;
      }

      // Swap cursor and anchor ends (vim 'o')
      if (seq === "o") {
        const tmp = this.inputCursor;
        this.inputCursor = this.visualAnchor;
        this.visualAnchor = tmp;
        this.render();
        return;
      }

      // Clipboard / editing actions
      if (seq === "y") {
        this.yankSelection();
        this.render();
        return;
      }
      if (seq === "d" || seq === "x" || key.name === "delete") {
        this.deleteSelection(false);
        this.render();
        return;
      }
      if (seq === "c" || seq === "s") {
        this.deleteSelection(true);
        this.render();
        return;
      }
      if (seq === "p" || seq === "P") {
        this.pasteInEditMode(false);
        this.render();
        return;
      }
      if (seq === "u") {
        this.popTextUndo();
        this.mode = "EDIT_NORMAL";
        this.render();
        return;
      }

      // `gg` is two keypresses, so it needs a pending state; a lone `g`
      // followed by anything else is simply dropped, as in NORMAL mode.
      if (this.pendingVisualG) {
        this.pendingVisualG = false;
        if (seq === "g") {
          this.inputCursor = 0;
          this.render();
          return;
        }
      } else if (seq === "g") {
        this.pendingVisualG = true;
        this.render();
        return;
      }

      // Motions
      const info = getCursorLineInfo(this.input, this.inputCursor);
      switch (seq) {
        case "h":
        case "left":
          if (info.col > 0) this.inputCursor--;
          break;
        case "l":
        case "right":
          if (info.lineText.length > 0 && info.col < info.lineText.length - 1) this.inputCursor++;
          break;
        case "j":
        case "down":
          if (this.editingMultiline && info.line < info.lines.length - 1) {
            const nextLineStart = info.lineEnd + 1;
            const nextLineText = info.lines[info.line + 1];
            const targetCol = Math.min(info.col, Math.max(0, nextLineText.length - 1));
            this.inputCursor = nextLineStart + targetCol;
          }
          break;
        case "k":
        case "up":
          if (this.editingMultiline && info.line > 0) {
            const prevLineText = info.lines[info.line - 1];
            const prevLineStart = this.input.slice(0, info.lineStart - 1).lastIndexOf("\n") + 1;
            const targetCol = Math.min(info.col, Math.max(0, prevLineText.length - 1));
            this.inputCursor = prevLineStart + targetCol;
          }
          break;
        case "0":
        case "^":
        case "home":
          this.inputCursor = info.lineStart;
          break;
        case "$":
        case "end":
          this.inputCursor = Math.max(info.lineStart, info.lineEnd > info.lineStart ? info.lineEnd - 1 : info.lineStart);
          break;
        case "w":
          this.inputCursor = this.findNextWordStart(this.input, this.inputCursor);
          break;
        case "b":
          this.inputCursor = this.findPrevWordStart(this.input, this.inputCursor);
          break;
        case "e":
          this.inputCursor = this.findCurrentWordEnd(this.input, this.inputCursor);
          break;
        case "G":
          this.inputCursor = Math.max(0, this.input.length - 1);
          break;
      }

      this.render();
      return;
    }

    if (this.mode === "EDIT_NORMAL") {
      const seq = editKeyToken(key);

      // Ctrl+W window navigation in EDIT_NORMAL
      if (this.pendingCtrlW) {
        this.pendingCtrlW = false;
        const token = normalKeyToken(key);
        if (token === "w" || (key.ctrl && key.name === "w")) {
          this.switchPane();
        } else if (token === "h" || key.name === "left") {
          this.switchPane("title");
        } else if (token === "l" || key.name === "right") {
          this.switchPane("description");
        } else if (token === "j" || key.name === "down") {
          this.switchPane("notes");
        } else if (token === "k" || key.name === "up") {
          this.switchPane("description");
        }
        this.render();
        return;
      }
      if (key.ctrl && key.name === "w") {
        this.pendingCtrlW = true;
        this.render();
        return;
      }

      // Single-character replacement mode: r<char>
      if (this.pendingEditOp === "r") {
        if (key.name === "escape") {
          this.pendingEditOp = "";
        } else if (seq && seq.length === 1 && !key.ctrl && !key.meta) {
          if (this.input.length > 0 && this.inputCursor < this.input.length) {
            this.pushTextUndo();
            this.input = this.input.slice(0, this.inputCursor) + seq + this.input.slice(this.inputCursor + 1);
          }
          this.pendingEditOp = "";
        }
        this.render();
        return;
      }

      // Pending delete, change, or yank operator (dw, de, db, d$, d0, dd, cw, ce, cb, c$, c0, cc, yw, ye, yb, y$, y0, yy)
      if (this.pendingEditOp === "d" || this.pendingEditOp === "c" || this.pendingEditOp === "y") {
        const isYank = this.pendingEditOp === "y";
        const isChange = this.pendingEditOp === "c";
        const op = editKeyToken(key);
        this.pendingEditOp = "";

        if (op === "escape") {
          this.render();
          return;
        }

        const info = getCursorLineInfo(this.input, this.inputCursor);

        if (op === "w" || op === "e") {
          const endIdx = op === "w"
            ? this.findNextWordStart(this.input, this.inputCursor)
            : this.findCurrentWordEnd(this.input, this.inputCursor);
          // `e` is an inclusive motion: the char at endIdx is included too.
          const sliceFrom = op === "e" ? endIdx + 1 : endIdx;
          if (isYank) {
            this.clipboard = { text: this.input.slice(this.inputCursor, sliceFrom), isLinewise: false };
            this.statusMessage = `Yanked ${this.clipboard.text.length} chars to clipboard`;
            this.statusIsError = false;
          } else {
            this.pushTextUndo();
            this.input = this.input.slice(0, this.inputCursor) + this.input.slice(sliceFrom);
            if (isChange) this.mode = "INSERT";
          }
        } else if (op === "b") {
          const startIdx = this.findPrevWordStart(this.input, this.inputCursor);
          if (isYank) {
            this.clipboard = { text: this.input.slice(startIdx, this.inputCursor), isLinewise: false };
            this.statusMessage = `Yanked ${this.clipboard.text.length} chars to clipboard`;
            this.statusIsError = false;
          } else {
            this.pushTextUndo();
            this.input = this.input.slice(0, startIdx) + this.input.slice(this.inputCursor);
            this.inputCursor = startIdx;
            if (isChange) this.mode = "INSERT";
          }
        } else if (op === "$" || op === "end") {
          if (isYank) {
            this.clipboard = { text: this.input.slice(this.inputCursor, info.lineEnd), isLinewise: false };
            this.statusMessage = `Yanked ${this.clipboard.text.length} chars to clipboard`;
            this.statusIsError = false;
          } else {
            this.pushTextUndo();
            this.input = this.input.slice(0, this.inputCursor) + this.input.slice(info.lineEnd);
            if (isChange) this.mode = "INSERT";
          }
        } else if (op === "0" || op === "^" || op === "home") {
          if (isYank) {
            this.clipboard = { text: this.input.slice(info.lineStart, this.inputCursor), isLinewise: false };
            this.statusMessage = `Yanked ${this.clipboard.text.length} chars to clipboard`;
            this.statusIsError = false;
          } else {
            this.pushTextUndo();
            this.input = this.input.slice(0, info.lineStart) + this.input.slice(this.inputCursor);
            this.inputCursor = info.lineStart;
            if (isChange) this.mode = "INSERT";
          }
        } else if ((isChange && op === "c") || (!isChange && !isYank && op === "d")) {
          this.pushTextUndo();
          if (this.editingMultiline && info.lines.length > 1) {
            if (info.line < info.lines.length - 1) {
              this.input = this.input.slice(0, info.lineStart) + this.input.slice(info.lineEnd + 1);
            } else {
              this.input = this.input.slice(0, Math.max(0, info.lineStart - 1));
            }
            this.inputCursor = Math.min(this.input.length, info.lineStart);
          } else {
            this.input = "";
            this.inputCursor = 0;
          }
          if (isChange) this.mode = "INSERT";
        } else if (isYank && op === "y") {
          this.clipboard = { text: info.lineText + "\n", isLinewise: true };
          this.statusMessage = "Yanked 1 line to clipboard";
          this.statusIsError = false;
        }
        this.render();
        return;
      }

      // Exit / Confirm from EDIT_NORMAL
      if (key.ctrl && key.name === "c") {
        this.cancelEdit();
        this.render();
        return;
      }
      if (key.ctrl && key.name === "s") {
        this.finishEdit();
        this.saveFile();
        this.render();
        return;
      }
      if (key.ctrl && key.name === "r") {
        this.popTextRedo();
        this.render();
        return;
      }
      if (key.name === "escape" || key.name === "return") {
        // Return to Level 1 outline navigation
        this.finishEdit();
        this.render();
        return;
      }

      const info = getCursorLineInfo(this.input, this.inputCursor);

      switch (seq) {
        case "h":
        case "left":
          if (info.col > 0) this.inputCursor--;
          break;
        case "l":
        case "right":
          if (info.lineText.length > 0 && info.col < info.lineText.length - 1) this.inputCursor++;
          break;
        case "j":
        case "down":
          if (this.editingMultiline && info.line < info.lines.length - 1) {
            const nextLineStart = info.lineEnd + 1;
            const nextLineText = info.lines[info.line + 1];
            const targetCol = Math.min(info.col, Math.max(0, nextLineText.length - 1));
            this.inputCursor = nextLineStart + targetCol;
          }
          break;
        case "k":
        case "up":
          if (this.editingMultiline && info.line > 0) {
            const prevLineText = info.lines[info.line - 1];
            const prevLineStart = this.input.slice(0, info.lineStart - 1).lastIndexOf("\n") + 1;
            const targetCol = Math.min(info.col, Math.max(0, prevLineText.length - 1));
            this.inputCursor = prevLineStart + targetCol;
          }
          break;
        case "0":
        case "^":
        case "home":
          this.inputCursor = info.lineStart;
          break;
        case "$":
        case "end":
          this.inputCursor = Math.max(info.lineStart, info.lineEnd > info.lineStart ? info.lineEnd - 1 : info.lineStart);
          break;
        case "w":
          this.inputCursor = this.findNextWordStart(this.input, this.inputCursor);
          break;
        case "b":
          this.inputCursor = this.findPrevWordStart(this.input, this.inputCursor);
          break;
        case "e":
          this.inputCursor = this.findCurrentWordEnd(this.input, this.inputCursor);
          break;

        // Visual mode entry
        case "v":
          this.mode = "VISUAL";
          this.visualType = "char";
          this.visualAnchor = this.inputCursor;
          break;
        case "V":
          this.mode = "VISUAL";
          this.visualType = "line";
          this.visualAnchor = this.inputCursor;
          break;

        // Clipboard operations
        case "y":
          this.pendingEditOp = "y";
          break;
        case "Y": {
          const lineInfo = getCursorLineInfo(this.input, this.inputCursor);
          this.clipboard = { text: lineInfo.lineText + "\n", isLinewise: true };
          this.statusMessage = "Yanked 1 line to clipboard";
          this.statusIsError = false;
          break;
        }
        case "p":
          this.pasteInEditMode(false);
          break;
        case "P":
          this.pasteInEditMode(true);
          break;

        // Pane navigation
        case "tab":
          if (key.shift) this.switchPanePrev();
          else this.switchPane();
          break;

        // Enter INSERT mode (Level 3)
        case "i":
          this.mode = "INSERT";
          break;
        case "a":
          if (this.input.length > 0 && this.inputCursor < info.lineEnd) {
            this.inputCursor++;
          }
          this.mode = "INSERT";
          break;
        case "I":
          this.inputCursor = info.lineStart;
          this.mode = "INSERT";
          break;
        case "A":
          this.inputCursor = info.lineEnd;
          this.mode = "INSERT";
          break;
        case "o":
          this.pushTextUndo();
          if (this.editingMultiline) {
            this.input = this.input.slice(0, info.lineEnd) + "\n" + this.input.slice(info.lineEnd);
            this.inputCursor = info.lineEnd + 1;
          } else {
            this.inputCursor = this.input.length;
          }
          this.mode = "INSERT";
          break;
        case "O":
          this.pushTextUndo();
          if (this.editingMultiline) {
            this.input = this.input.slice(0, info.lineStart) + "\n" + this.input.slice(info.lineStart);
            this.inputCursor = info.lineStart;
          } else {
            this.inputCursor = 0;
          }
          this.mode = "INSERT";
          break;

        // In-place edits
        case "x":
        case "delete":
          if (this.input.length > 0 && this.inputCursor < this.input.length) {
            this.pushTextUndo();
            this.input = this.input.slice(0, this.inputCursor) + this.input.slice(this.inputCursor + 1);
            if (this.inputCursor >= this.input.length && this.inputCursor > 0) this.inputCursor--;
          }
          break;
        case "X":
        case "backspace":
          if (info.col > 0) {
            this.pushTextUndo();
            this.input = this.input.slice(0, this.inputCursor - 1) + this.input.slice(this.inputCursor);
            this.inputCursor--;
          }
          break;
        case "s":
          this.pushTextUndo();
          if (this.input.length > 0 && this.inputCursor < this.input.length) {
            this.input = this.input.slice(0, this.inputCursor) + this.input.slice(this.inputCursor + 1);
          }
          this.mode = "INSERT";
          break;
        case "S":
          this.pushTextUndo();
          this.input = this.input.slice(0, info.lineStart) + this.input.slice(info.lineEnd);
          this.inputCursor = info.lineStart;
          this.mode = "INSERT";
          break;
        case "D":
          this.pushTextUndo();
          this.input = this.input.slice(0, this.inputCursor) + this.input.slice(info.lineEnd);
          // Clamp cursor: in EDIT_NORMAL the cursor must sit ON a char (not past last)
          if (this.input.length > 0 && this.inputCursor >= this.input.length) {
            this.inputCursor = this.input.length - 1;
          }
          break;
        case "C":
          this.pushTextUndo();
          this.input = this.input.slice(0, this.inputCursor) + this.input.slice(info.lineEnd);
          this.mode = "INSERT";
          break;
        case "~":
          if (this.input.length > 0 && this.inputCursor < this.input.length) {
            this.pushTextUndo();
            const ch = this.input[this.inputCursor];
            const flipped = ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
            this.input = this.input.slice(0, this.inputCursor) + flipped + this.input.slice(this.inputCursor + 1);
            if (this.inputCursor < info.lineEnd - 1) this.inputCursor++;
          }
          break;
        case "u":
          this.popTextUndo();
          break;
        case "d":
        case "c":
        case "r":
          this.pendingEditOp = seq;
          break;
      }
      this.render();
      return;
    }

    if (this.mode === "INSERT") {
      if (key.name === "return") {
        if (this.editingMultiline) {
          this.pushTextUndo();
          this.input = this.input.slice(0, this.inputCursor) + "\n" + this.input.slice(this.inputCursor);
          this.inputCursor++;
        } else {
          this.finishEdit();
        }
      } else if (key.name === "escape") {
        // Escape returns to Level 2: Node Text Navigation
        this.mode = "EDIT_NORMAL";
        if (this.inputCursor > 0) this.inputCursor--;
      } else if (key.name === "backspace") {
        if (this.inputCursor > 0) {
          this.pushTextUndo();
          this.input = this.input.slice(0, this.inputCursor - 1) + this.input.slice(this.inputCursor);
          this.inputCursor--;
        }
      } else if (key.name === "delete") {
        if (this.inputCursor < this.input.length) {
          this.pushTextUndo();
          this.input = this.input.slice(0, this.inputCursor) + this.input.slice(this.inputCursor + 1);
        }
      } else if (key.name === "left") {
        if (this.inputCursor > 0) this.inputCursor--;
      } else if (key.name === "right") {
        if (this.inputCursor < this.input.length) this.inputCursor++;
      } else if (key.name === "home") {
        const info = getCursorLineInfo(this.input, this.inputCursor);
        this.inputCursor = info.lineStart;
      } else if (key.name === "end") {
        const info = getCursorLineInfo(this.input, this.inputCursor);
        this.inputCursor = info.lineEnd;
      } else if (key.ctrl && key.name === "w") {
        // Ctrl+W: delete word backward (vim INSERT mode standard)
        if (this.inputCursor > 0) {
          this.pushTextUndo();
          const startIdx = this.findPrevWordStart(this.input, this.inputCursor);
          this.input = this.input.slice(0, startIdx) + this.input.slice(this.inputCursor);
          this.inputCursor = startIdx;
        }
      } else if (key.ctrl && key.name === "u") {
        // Ctrl+U: delete from cursor to start of line (vim INSERT mode standard)
        if (this.inputCursor > 0) {
          this.pushTextUndo();
          const info = getCursorLineInfo(this.input, this.inputCursor);
          this.input = this.input.slice(0, info.lineStart) + this.input.slice(this.inputCursor);
          this.inputCursor = info.lineStart;
        }
      } else if (key.ctrl && key.name === "h") {
        // Ctrl+H: backspace (vim INSERT mode alias)
        if (this.inputCursor > 0) {
          this.pushTextUndo();
          this.input = this.input.slice(0, this.inputCursor - 1) + this.input.slice(this.inputCursor);
          this.inputCursor--;
        }
      } else if (isPrintable(key)) {
        this.input = this.input.slice(0, this.inputCursor) + key.sequence + this.input.slice(this.inputCursor);
        this.inputCursor += key.sequence!.length;
      }
      this.render();
      return;
    }

    if (this.mode === "COMMAND") {
      if (key.name === "return") {
        const cmd = this.command;
        this.mode = "NORMAL";
        this.command = "";
        this.commandCursor = 0;
        // Save non-trivial commands to history (avoid saving bare ":")
        const cmdContent = cmd.startsWith(":") ? cmd.slice(1).trim() : cmd.trim();
        if (cmdContent && (this.commandHistory.length === 0 || this.commandHistory[this.commandHistory.length - 1] !== cmd)) {
          this.commandHistory.push(cmd);
          if (this.commandHistory.length > 100) this.commandHistory.shift();
        }
        this.commandHistoryIdx = -1;
        this.executeCommand(cmd);
      } else if (key.name === "escape") {
        this.mode = "NORMAL";
        this.command = "";
        this.commandCursor = 0;
        this.commandHistoryIdx = -1;
      } else if (key.name === "up") {
        // Browse command history backwards
        if (this.commandHistory.length > 0) {
          if (this.commandHistoryIdx === -1) {
            this.commandHistoryIdx = this.commandHistory.length - 1;
          } else if (this.commandHistoryIdx > 0) {
            this.commandHistoryIdx--;
          }
          this.command = this.commandHistory[this.commandHistoryIdx];
          this.commandCursor = this.command.length;
        }
      } else if (key.name === "down") {
        // Browse command history forwards
        if (this.commandHistoryIdx !== -1) {
          if (this.commandHistoryIdx < this.commandHistory.length - 1) {
            this.commandHistoryIdx++;
            this.command = this.commandHistory[this.commandHistoryIdx];
          } else {
            this.commandHistoryIdx = -1;
            this.command = ":";
          }
          this.commandCursor = this.command.length;
        }
      } else if (key.name === "backspace") {
        if (this.commandCursor > 0) {
          this.command = this.command.slice(0, this.commandCursor - 1) + this.command.slice(this.commandCursor);
          this.commandCursor--;
          if (this.command.length === 0) {
            this.mode = "NORMAL";
            this.commandHistoryIdx = -1;
          }
        }
      } else if (key.name === "left") {
        if (this.commandCursor > 0) this.commandCursor--;
      } else if (key.name === "right") {
        if (this.commandCursor < this.command.length) this.commandCursor++;
      } else if (key.name === "home") {
        this.commandCursor = 1; // stay after the leading ":"
      } else if (key.name === "end") {
        this.commandCursor = this.command.length;
      } else if (isPrintable(key)) {
        this.command = this.command.slice(0, this.commandCursor) + key.sequence + this.command.slice(this.commandCursor);
        this.commandCursor += key.sequence!.length;
        this.commandHistoryIdx = -1; // typing breaks history browsing
      }
      this.render();
      return;
    }

    // NORMAL Mode Shortcuts
    if (key.ctrl && key.name === "c") {
      this.quit();
      return;
    }
    if (key.ctrl && key.name === "s") {
      this.saveFile();
      this.render();
      return;
    }
    if (key.ctrl && key.name === "e") {
      this.exportMarkdown();
      this.render();
      return;
    }
    if (key.ctrl && key.name === "r") {
      this.redo();
      this.render();
      return;
    }
    if (key.ctrl && key.name === "f") {
      // Ctrl+F: page down (scroll one full viewport)
      const pageSize = Math.max(1, (process.stdout.rows || 24) - 5);
      this.moveSelection(pageSize);
      this.render();
      return;
    }
    if (key.ctrl && key.name === "b") {
      // Ctrl+B: page up (scroll one full viewport)
      const pageSize = Math.max(1, (process.stdout.rows || 24) - 5);
      this.moveSelection(-pageSize);
      this.render();
      return;
    }
    if (key.ctrl && key.name === "d") {
      // Ctrl+D: half-page down
      const halfPage = Math.max(1, Math.floor(((process.stdout.rows || 24) - 5) / 2));
      this.moveSelection(halfPage);
      this.render();
      return;
    }
    if (key.ctrl && key.name === "u") {
      // Ctrl+U: half-page up
      const halfPage = Math.max(1, Math.floor(((process.stdout.rows || 24) - 5) / 2));
      this.moveSelection(-halfPage);
      this.render();
      return;
    }

    if (this.pendingCtrlW) {
      this.pendingCtrlW = false;
      const token = normalKeyToken(key);
      if (token === "w" || token === "l" || key.name === "right") {
        this.beginEdit("description");
      } else if (token === "j" || key.name === "down") {
        this.beginEdit("notes");
      } else if (token === "h" || key.name === "left") {
        this.beginEdit("title");
      }
      this.render();
      return;
    }
    if (key.ctrl && key.name === "w") {
      this.pendingCtrlW = true;
      this.render();
      return;
    }

    const seq = key.sequence || "";

    if (key.name === "colon" || seq === ":") {
      this.mode = "COMMAND";
      this.command = ":";
      this.commandCursor = 1;
      this.render();
      return;
    }

    // Multi-key sequences (gg, zc, zo, za, zM, zR, yy)
    if (this.pendingSequence === "g") {
      if (seq === "g") {
        this.jumpTop();
      }
      this.pendingSequence = "";
    } else if (this.pendingSequence === "z") {
      if (seq === "c") this.toggleFold(false);
      else if (seq === "o") this.toggleFold(true);
      else if (seq === "a") this.toggleFold();
      else if (seq === "M") {
        this.outline.setAllCollapsed(true);
        this.jumpTop();
      } else if (seq === "R") {
        this.outline.setAllCollapsed(false);
      }
      this.pendingSequence = "";
    } else if (this.pendingSequence === "y") {
      if (seq === "y") {
        this.yankCurrentNode();
      }
      this.pendingSequence = "";
    } else if (seq === "g" || seq === "z" || seq === "y") {
      this.pendingSequence = seq;
    } else {
      this.pendingSequence = "";
      switch (normalKeyToken(key)) {
        case "down":
        case "j":
          this.moveSelection(1);
          break;
        case "up":
        case "k":
          this.moveSelection(-1);
          break;
        case "home":
          this.jumpTop();
          break;
        case "end":
        case "G":
          this.jumpBottom();
          break;
        case "w":
          this.nextSibling();
          break;
        case "b":
          this.previousSibling();
          break;
        case "left":
        case "h":
          this.toggleFold(false);
          break;
        case "right":
        case "l":
          this.toggleFold(true);
          break;
        case "space":
          this.toggleFold();
          break;
        case "J":
          this.moveSibling(1);
          break;
        case "K":
          this.moveSibling(-1);
          break;
        case "tab":
          if (key.shift) this.dedentNode();
          else this.indentNode();
          break;
        case ">":
        case "L":
          this.indentNode();
          break;
        case "<":
        case "H":
          this.dedentNode();
          break;
        case "o":
          this.beginEdit("siblingBelow");
          break;
        case "O":
          this.beginEdit("siblingAbove");
          break;
        case "c":
          this.beginEdit("child");
          break;
        case "e":
        case "R":
        case "return":
          this.beginEdit("title");
          break;
        case "i":
          this.beginEdit("title");
          this.inputCursor = this.input.length;
          this.mode = "INSERT";
          break;
        case "E":
          this.beginEdit("description");
          break;
        case "N":
          this.beginEdit("notes");
          break;
        // beginEdit bails out when there is no node, so entering VISUAL is
        // conditional on it having actually opened a buffer — otherwise the
        // badge would read VISUAL over the previous node's stale text.
        case "v":
        case "V":
          if (this.selectedNode) {
            this.beginEdit("title");
            this.mode = "VISUAL";
            this.visualType = normalKeyToken(key) === "V" ? "line" : "char";
            this.visualAnchor = 0;
            this.inputCursor = Math.max(0, this.input.length - 1);
          }
          break;
        case "Y":
          this.yankCurrentNode();
          break;
        case "p":
          this.pasteNode(false);
          break;
        case "P":
          this.pasteNode(true);
          break;
        case "d":
        case "x":
        case "delete":
          this.deleteCurrentNode();
          break;
        case "u":
          this.undo();
          break;
        case "?":
          this.showHelpOverlay = true;
          break;
        case "q":
          this.quit();
          break;
      }
    }

    this.render();
  }

  private executeCommand(cmdLine: string): void {
    const raw = cmdLine.startsWith(":") ? cmdLine.slice(1).trim() : cmdLine.trim();
    if (raw.startsWith("!")) {
      // Split before this point would mangle a shell command's own
      // whitespace/quoting, so `!` is handled before the generic tokenizer.
      const shellCmd = raw.slice(1).trim();
      if (shellCmd) this.runShellCommand(shellCmd);
      return;
    }
    const parts = raw.split(/\s+/);
    const cmd = parts[0];
    const arg = parts[1];

    if (cmd === "w" || cmd === "write") {
      this.saveFile(arg, false);
    } else if (cmd === "w!" || cmd === "write!") {
      this.saveFile(arg, true);
    } else if (cmd === "q" || cmd === "quit") {
      this.quit();
    } else if (cmd === "wq" || cmd === "x") {
      this.saveFile(arg, false);
      if (!this.statusIsError) this.quit();
    } else if (cmd === "wq!" || cmd === "x!") {
      this.saveFile(arg, true);
      this.quit(true);
    } else if (cmd === "e" || cmd === "edit" || cmd === "load") {
      this.loadFile(arg || this.filename, false);
    } else if (cmd === "e!" || cmd === "edit!" || cmd === "load!") {
      this.loadFile(arg || this.filename, true);
    } else if (cmd === "m" || cmd === "md" || cmd === "markdown") {
      this.exportMarkdown(arg);
    } else if (cmd === "help") {
      this.showHelpOverlay = true;
    } else if (cmd === "q!" || cmd === "quit!") {
      this.quit(true);
    } else if (cmd) {
      this.statusMessage = `Unknown command: :${cmd}`;
      this.statusIsError = true;
    }
  }

  /**
   * Vim-style `:!cmd`: suspend the TUI, run the command with the real
   * terminal (so it can show output and read input), then wait for a key
   * before redrawing — otherwise the alternate-screen switch back would hide
   * the command's output before anyone could read it.
   */
  private runShellCommand(cmd: string): void {
    this.mode = "SHELL";
    this.shellResumeIsTTY = !!process.stdin.isTTY;
    if (this.shellResumeIsTTY) {
      process.stdin.setRawMode(false);
      process.stdout.write("\x1b[?25h\x1b[?1049l");
    }
    process.stdout.write(`\n\x1b[1m$ ${cmd}\x1b[0m\n`);

    let status: number | null = null;
    try {
      const shell = process.env.SHELL || "/bin/sh";
      const result = spawnSync(shell, ["-c", cmd], { stdio: "inherit" });
      if (result.error) {
        process.stdout.write(`\n${result.error.message}\n`);
        status = 1;
      } else {
        status = result.status;
      }
    } catch (err) {
      process.stdout.write(`\n${err instanceof Error ? err.message : String(err)}\n`);
      status = 1;
    }

    process.stdout.write(
      `\n\x1b[2m[Command exited with code ${status ?? 0} — press any key to continue]\x1b[0m`
    );
    this.statusMessage = `Ran: ${cmd} (exit ${status ?? 0})`;
    this.statusIsError = !!status;
  }

  /** Any key dismisses the `:!cmd` pause and redraws the TUI. */
  private resumeFromShell(): void {
    this.mode = "NORMAL";
    if (this.shellResumeIsTTY) {
      process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J");
      process.stdin.setRawMode(true);
    }
    this.render();
  }

  private initFileWatcher(): void {
    this.closeFileWatcher();
    try {
      if (fs.existsSync(this.filename)) {
        this.fileMtimeMs = fs.statSync(this.filename).mtimeMs;
      } else {
        this.fileMtimeMs = 0;
      }
    } catch {
      this.fileMtimeMs = 0;
    }

    try {
      const fullPath = path.resolve(this.filename);
      const dir = path.dirname(fullPath);
      const base = path.basename(fullPath);
      if (fs.existsSync(dir)) {
        this.fileWatcher = fs.watch(dir, (_event, changedFile) => {
          if (changedFile && changedFile !== base) return;
          this.onFileChangedOnDisk();
        });
      }
    } catch {
      this.fileWatcher = null;
    }
  }

  private closeFileWatcher(): void {
    if (this.fileWatcher) {
      try {
        this.fileWatcher.close();
      } catch {}
      this.fileWatcher = null;
    }
    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer);
      this.reloadDebounceTimer = null;
    }
  }

  /**
   * Where the selection points, in terms that survive a reparse.
   *
   * Node ids are regenerated positionally by `fromMarkdown` (`node-1`,
   * `node-2`, ...), so they identify a *slot*, not a node: insert a heading
   * externally above the cursor and the old id still resolves — to the wrong
   * node. The heading path is stable under that edit, so it is tried first,
   * with the slot kept only as a fallback for a genuine rename.
   */
  private selectionAnchor(): { titlePath: string[]; index: number } | null {
    const node = this.selectedNode;
    if (!node) return null;
    const titlePath: string[] = [];
    let cur: OutlineNode | null = node;
    while (cur && cur.id !== "root") {
      titlePath.unshift(cur.title);
      cur = this.outline.findParent(this.outline.root, cur.id);
    }
    return { titlePath, index: this.currentIndex };
  }

  private restoreSelection(anchor: { titlePath: string[]; index: number } | null): void {
    if (!anchor) {
      this.clampSelection();
      return;
    }
    const visible = this.visibleNodes;
    const pathOf = (node: OutlineNode): string[] => {
      const out: string[] = [];
      let cur: OutlineNode | null = node;
      while (cur && cur.id !== "root") {
        out.unshift(cur.title);
        cur = this.outline.findParent(this.outline.root, cur.id);
      }
      return out;
    };
    const key = anchor.titlePath.join("\u0000");
    const byPath = visible.findIndex((n) => pathOf(n).join("\u0000") === key);
    this.currentIndex = byPath >= 0 ? byPath : anchor.index;
    this.clampSelection();
  }

  /**
   * Pull the file back in over a clean buffer.
   *
   * The undo history is dropped rather than kept: its snapshots predate the
   * reload, so a single `u` afterwards would restore the pre-reload tree and
   * silently discard whatever the external writer had just added — and mark
   * the result dirty, so the next `:w` would write that loss back out.
   */
  private applyReloadFromDisk(mtimeMs: number): boolean {
    try {
      const data = fs.readFileSync(this.filename, "utf8");
      const anchor = this.selectionAnchor();
      this.outline.fromMarkdown(data);

      this.restoreSelection(anchor);
      this.undoStack = [];
      this.redoStack = [];
      this.markSaved();
      this.fileMtimeMs = mtimeMs;
      this.diskFileModified = false;
      this.pendingReload = false;
      this.statusMessage = `⟳ Auto-reloaded ${path.basename(this.filename)} (external changes detected)`;
      this.statusIsError = false;
      return true;
    } catch (err) {
      this.statusMessage = `✗ Error auto-reloading: ${err instanceof Error ? err.message : String(err)}`;
      this.statusIsError = true;
      return false;
    }
  }

  /** Editing modes hold text outside the tree, so a reload waits them out. */
  private get reloadIsSafeNow(): boolean {
    return this.mode === "NORMAL" || this.mode === "COMMAND";
  }

  /**
   * Run a reload that arrived while the user was inside an edit mode. Called
   * on every return to NORMAL, so a deferred refresh lands as soon as it is
   * safe instead of waiting for the next external write.
   */
  private applyPendingReload(): void {
    if (!this.pendingReload || !this.reloadIsSafeNow || this.closed) return;
    this.pendingReload = false;

    // The buffer may have been edited between the deferral and now, or the
    // file may be gone. Either way the refresh is off — but it must degrade
    // into the conflict guard, not vanish: dropping it silently would leave
    // the next :w free to overwrite the external change without a warning.
    let mtime = 0;
    const exists = fs.existsSync(this.filename);
    if (exists) {
      try {
        mtime = fs.statSync(this.filename).mtimeMs;
      } catch {
        return;
      }
    }
    if (!exists || this.modified) {
      this.diskFileModified = true;
      this.statusMessage = exists
        ? `⚠ File changed on disk! Local changes pending.`
        : `⚠ File ${path.basename(this.filename)} was deleted externally!`;
      this.statusIsError = true;
      return;
    }
    this.applyReloadFromDisk(mtime);
  }

  private onFileChangedOnDisk(): void {
    if (this.reloadDebounceTimer) clearTimeout(this.reloadDebounceTimer);
    this.reloadDebounceTimer = setTimeout(() => {
      this.reloadDebounceTimer = null;
      if (this.closed) return;

      if (!fs.existsSync(this.filename)) {
        // Worth saying even over a clean buffer: the next :w recreates the
        // file, and silence would make that look like an ordinary save.
        this.diskFileModified = true;
        this.statusMessage = `⚠ File ${path.basename(this.filename)} was deleted externally!`;
        this.statusIsError = true;
        this.render();
        return;
      }

      let currentMtime = 0;
      try {
        currentMtime = fs.statSync(this.filename).mtimeMs;
      } catch {
        return;
      }

      if (this.fileMtimeMs > 0 && currentMtime <= this.fileMtimeMs) {
        return;
      }

      if (this.modified) {
        this.diskFileModified = true;
        this.statusMessage = `⚠ File changed on disk! Local changes pending.`;
        this.statusIsError = true;
      } else if (this.reloadIsSafeNow) {
        this.applyReloadFromDisk(currentMtime);
      } else {
        // Clean, but the edit buffer is open: defer until it closes.
        this.pendingReload = true;
        this.statusMessage = `⟳ ${path.basename(this.filename)} changed on disk — reloading when you leave edit mode`;
        this.statusIsError = false;
      }
      this.render();
    }, 50);
  }

  private saveFile(targetFile?: string, force: boolean = false): void {
    const file = targetFile || this.filename;
    try {
      let currentMtime = 0;
      if (fs.existsSync(file)) {
        try {
          currentMtime = fs.statSync(file).mtimeMs;
        } catch {}
      }

      if (!force && (this.diskFileModified || (this.fileMtimeMs > 0 && currentMtime > this.fileMtimeMs))) {
        this.statusMessage = "✗ Conflict: File modified externally! Use :w! to overwrite or :e! to reload.";
        this.statusIsError = true;
        return;
      }

      // The rename replaces the inode, so carry the original mode over instead
      // of silently tightening permissions on every save.
      let mode = 0o600;
      try {
        mode = fs.statSync(file).mode & 0o777;
      } catch {
        // New file: fall back to the restrictive default.
      }
      const tempPath = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tempPath, this.outline.toMarkdown(), { encoding: "utf8", mode });
      fs.renameSync(tempPath, file);

      try {
        this.fileMtimeMs = fs.statSync(file).mtimeMs;
      } catch {
        this.fileMtimeMs = Date.now();
      }

      if (file !== this.filename) {
        this.filename = file;
        this.initFileWatcher();
      }

      this.markSaved();
      this.diskFileModified = false;
      this.statusMessage = `✓ Saved to ${file}`;
      this.statusIsError = false;
    } catch (err) {
      this.statusMessage = `✗ Error saving: ${err instanceof Error ? err.message : String(err)}`;
      this.statusIsError = true;
    }
  }

  private loadFile(file: string, force: boolean = false): void {
    if (!force && this.modified) {
      this.statusMessage = "✗ Unsaved changes! Use :e! to discard changes and reload.";
      this.statusIsError = true;
      return;
    }
    try {
      if (fs.existsSync(file)) {
        const data = fs.readFileSync(file, "utf8");
        this.outline.fromMarkdown(data);
        this.filename = file;
        this.currentIndex = 0;
        this.scrollOffset = 0;
        this.markSaved();
        this.diskFileModified = false;
        this.pendingReload = false;
        this.initFileWatcher();
        this.statusMessage = `✓ Loaded from ${file}`;
        this.statusIsError = false;
      } else {
        this.statusMessage = `✗ File not found: ${file}`;
        this.statusIsError = true;
      }
    } catch (err) {
      this.statusMessage = `✗ Error loading: ${err instanceof Error ? err.message : String(err)}`;
      this.statusIsError = true;
    }
  }

  private exportMarkdown(targetFile?: string): void {
    // Any extension is swapped for .md, so exporting foo.md no longer produces
    // foo.md.md; without an argument it simply rewrites the current file.
    const file = targetFile || this.filename.replace(/(\.[^./\\]*)?$/, ".md");
    try {
      fs.writeFileSync(file, this.outline.toMarkdown(), "utf8");
      if (file === this.filename) this.markSaved();
      this.statusMessage = `✓ Exported markdown to ${file}`;
      this.statusIsError = false;
    } catch (err) {
      this.statusMessage = `✗ Error exporting: ${err instanceof Error ? err.message : String(err)}`;
      this.statusIsError = true;
    }
  }

  private render(): void {
    if (this.closed) return;
    // While a `:!cmd` is suspended, the terminal is showing raw command
    // output on the normal screen buffer, not the TUI.
    if (this.mode === "SHELL") return;

    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const buffer: string[] = [];

    // Header bar
    const modTag = (this.modified ? " \x1b[33m[+Modified]\x1b[0m" : "") +
                   (this.diskFileModified ? " \x1b[31m[Disk Modified]\x1b[0m" : "");
    let modeBadge = "\x1b[42;30m OUTLINE \x1b[0m";
    const fieldTag = this.editField === "notes" ? "NOTE" : this.editField === "description" ? "CONTENT" : "TITLE";
    if (this.mode === "EDIT_NORMAL") {
      modeBadge = this.editingMultiline ? `\x1b[44;37m ${fieldTag}-NAV \x1b[0m` : "\x1b[44;37m EDIT-NAV \x1b[0m";
    } else if (this.mode === "VISUAL") {
      modeBadge = this.editingMultiline ? `\x1b[45;37m ${fieldTag}-VIS \x1b[0m` : "\x1b[45;37m EDIT-VIS \x1b[0m";
    } else if (this.mode === "INSERT") {
      modeBadge = this.editingMultiline ? `\x1b[45;37m ${fieldTag}-INS \x1b[0m` : "\x1b[43;30m INSERT \x1b[0m";
    } else if (this.mode === "COMMAND") {
      modeBadge = "\x1b[46;30m COMMAND \x1b[0m";
    }

    const headerLeftBase = " \x1b[1mOUTLINE EDITOR\x1b[0m  \x1b[36m";
    const headerRight = `${modeBadge} `;
    const rightLen = stringWidth(headerRight);
    const maxFileLen = Math.max(8, cols - 20 - rightLen - (this.modified ? 12 : 0) - (this.diskFileModified ? 16 : 0));
    const dispFile = this.filename.length > maxFileLen ? `...${this.filename.slice(-(maxFileLen - 3))}` : this.filename;
    const headerLeft = `${headerLeftBase}${dispFile}\x1b[0m${modTag}`;
    const leftLen = stringWidth(headerLeft);
    const headerPad = Math.max(1, cols - leftLen - rightLen);
    const headerLine = truncateToWidth(`${headerLeft}${" ".repeat(headerPad)}${headerRight}`, cols, false);
    buffer.push(padRight(headerLine, cols));

    // Top divider
    buffer.push(`\x1b[2m${"─".repeat(cols)}\x1b[0m`);

    // Viewport calculation: exact height so rows never exceed screen height
    const paneHeight = Math.max(3, rows - 5);
    const sep = " \x1b[2m│\x1b[0m ";
    const sepWidth = 3;
    const usable = Math.max(2, cols - sepWidth);
    let leftWidth = Math.max(24, Math.min(Math.floor(usable * 0.52), usable - 26));
    let rightWidth = Math.max(20, usable - leftWidth);
    if (leftWidth + rightWidth > usable) {
      // Too narrow to honour both minimums: split what there is.
      leftWidth = Math.max(1, Math.floor(usable * 0.52));
      rightWidth = Math.max(1, usable - leftWidth);
    }

    const visible = this.visibleNodes;
    if (this.currentIndex < this.scrollOffset) {
      this.scrollOffset = this.currentIndex;
    } else if (this.currentIndex >= this.scrollOffset + paneHeight) {
      this.scrollOffset = this.currentIndex - paneHeight + 1;
    }
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, Math.max(0, visible.length - paneHeight)));

    const selected = this.selectedNode;

    // Right pane: metadata, then the description, with speaker notes pinned to
    // the bottom so the lower right corner is put to use. While a multi-line
    // field is being edited the pane switches to a focus layout — metadata
    // collapses to the title and the other field to a single row — so the text
    // under the cursor gets nearly the whole pane instead of five or six rows.
    const editingField = this.mode === "EDIT_NORMAL" || this.mode === "INSERT" || this.mode === "VISUAL" ? this.editField : null;
    const focused = editingField === "description" || editingField === "notes";

    const overflowTag = (block: { above: number; below: number }): string => {
      const marks: string[] = [];
      if (block.above > 0) marks.push(`↑${block.above}`);
      if (block.below > 0) marks.push(`↓${block.below}`);
      return marks.length ? ` \x1b[2m${marks.join(" ")}\x1b[0m` : "";
    };

    const rightLines: string[] = [];
    if (selected) {
      const metaLines: string[] = [];
      if (focused) {
        metaLines.push(truncateToWidth(`\x1b[1mTitle:\x1b[0m ${selected.title || "(empty)"}`, rightWidth, true));
      } else {
        metaLines.push(truncateToWidth(`\x1b[1mID:\x1b[0m \x1b[36m${selected.id}\x1b[0m`, rightWidth, true));
        metaLines.push(truncateToWidth(`\x1b[1mTitle:\x1b[0m ${selected.title || "(empty)"}`, rightWidth, true));
        // Path: wrap across multiple lines so long paths never overflow. The
        // crumbs are drawn in the default foreground — bright black is the
        // background colour in Solarized Dark, which made them invisible.
        const pathLabel = "Path: ";
        const pathLabelWidth = pathLabel.length;
        const pathCrumbs = this.getNodePathParts(selected);
        const pathFull = pathCrumbs.join(" > ");
        if (pathFull.length + pathLabelWidth <= rightWidth) {
          metaLines.push(truncateToWidth(`\x1b[1m${pathLabel}\x1b[0m${pathFull}`, rightWidth, false));
        } else {
          // Wrap: build visual lines fitting in rightWidth, joining crumbs with " > "
          const contIndent = " ".repeat(pathLabelWidth);
          let firstLine = true;
          let segment = "";
          for (let ci = 0; ci < pathCrumbs.length; ci++) {
            const crumb = pathCrumbs[ci];
            const sep = ci < pathCrumbs.length - 1 ? " >" : "";
            const candidate = segment ? `${segment} > ${crumb}${sep}` : `${crumb}${sep}`;
            const prefix = firstLine ? pathLabel : contIndent;
            if (prefix.length + candidate.length > rightWidth && segment) {
              metaLines.push(`\x1b[1m${firstLine ? pathLabel : contIndent}\x1b[0m${segment}`);
              segment = `${crumb}${sep}`;
              firstLine = false;
            } else {
              segment = candidate;
            }
          }
          if (segment) {
            metaLines.push(`\x1b[1m${firstLine ? pathLabel : contIndent}\x1b[0m${segment}`);
          }
        }
        metaLines.push(truncateToWidth(`\x1b[1mChildren:\x1b[0m ${selected.children.length}  \x1b[1mDepth:\x1b[0m ${this.getSubtreeDepth(selected)}`, rightWidth, true));
      }

      // Each section costs a divider and a label row on top of its body.
      const budget = paneHeight - metaLines.length - 2;
      const showNotes = budget >= 4;
      const bodyBudget = showNotes ? budget - 2 : budget;

      let descHeight: number;
      let notesHeight: number;
      if (!showNotes) {
        descHeight = Math.max(0, bodyBudget);
        notesHeight = 0;
      } else if (editingField === "description") {
        notesHeight = 1;
        descHeight = bodyBudget - notesHeight;
      } else if (editingField === "notes") {
        descHeight = 1;
        notesHeight = bodyBudget - descHeight;
      } else {
        // Notes get about a third of the pane, but never at the cost of
        // squeezing the description below two rows.
        notesHeight = Math.max(1, Math.min(Math.floor(paneHeight / 3) - 2, bodyBudget - 2));
        descHeight = bodyBudget - notesHeight;
      }

      const desc = this.renderTextBlock(
        selected.description,
        rightWidth,
        descHeight,
        editingField === "description",
        "(no content — press 'E' to add)",
        true
      );
      const notes = showNotes
        ? this.renderTextBlock(
            selected.notes,
            rightWidth,
            notesHeight,
            editingField === "notes",
            "(no speaker notes — press 'N' to add)",
            false
          )
        : { rows: [], above: 0, below: 0 };

      const divider = `\x1b[2m${"─".repeat(rightWidth)}\x1b[0m`;
      rightLines.push(...metaLines);
      rightLines.push(divider);
      rightLines.push(`\x1b[1mContent:\x1b[0m${overflowTag(desc)}`);
      rightLines.push(...desc.rows);
      // Pad the description out so the notes section stays flush to the bottom.
      while (rightLines.length < metaLines.length + 2 + descHeight) rightLines.push("");
      if (showNotes) {
        rightLines.push(divider);
        rightLines.push(`\x1b[1mNotes:\x1b[0m${overflowTag(notes)}`);
        rightLines.push(...notes.rows);
      }
    } else {
      rightLines.push(truncateToWidth("\x1b[2m(no node selected)\x1b[0m", rightWidth, false));
    }

    // Middle rows
    for (let r = 0; r < paneHeight; r++) {
      const nodeIndex = this.scrollOffset + r;
      let leftCell = "";

      if (nodeIndex < visible.length) {
        const node = visible[nodeIndex];
        const isSelected = nodeIndex === this.currentIndex;
        const depth = this.outline.getNodeDepth(node.id);
        const indent = "  ".repeat(Math.max(0, depth - 1));
        const foldIcon = node.children.length > 0 ? (node.collapsed ? "\x1b[33m▶\x1b[0m" : "\x1b[33m▼\x1b[0m") : "\x1b[2m•\x1b[0m";
        const branch = depth > 1 ? "\x1b[2m├─\x1b[0m" : "";
        const selMark = isSelected ? "\x1b[1;36m❯\x1b[0m " : "  ";

        const prefix = `${selMark}${indent}${branch}${foldIcon} `;
        const prefixW = stringWidth(prefix);
        const availTitleW = Math.max(1, leftWidth - prefixW);

        let titleStr = node.title || "(empty)";
        if (isSelected && (this.mode === "EDIT_NORMAL" || this.mode === "INSERT" || this.mode === "VISUAL") && !this.editingMultiline) {
          if (this.mode === "VISUAL") {
            const sel = this.getSelectionRange();
            let formatted = "";
            let inSel = false;
            for (let i = 0; i < this.input.length; i++) {
              const ch = this.input[i];
              const isCursor = i === this.inputCursor;
              const isSelectedChar = i >= sel.start && i <= sel.end;
              if (isCursor) {
                if (inSel) { formatted += "\x1b[0m"; inSel = false; }
                formatted += `\x1b[7;1m${ch}\x1b[0m`;
              } else if (isSelectedChar) {
                if (!inSel) { formatted += "\x1b[48;5;24;37m"; inSel = true; }
                formatted += ch;
              } else {
                if (inSel) { formatted += "\x1b[0m"; inSel = false; }
                formatted += ch;
              }
            }
            if (inSel) { formatted += "\x1b[0m"; inSel = false; }
            if (this.inputCursor >= this.input.length) {
              formatted += `\x1b[7;1m \x1b[0m`;
            }
            titleStr = formatted;
          } else {
            const cur = Math.max(0, Math.min(this.inputCursor, this.input.length));
            const before = this.input.slice(0, cur);
            const cursorChar = cur < this.input.length ? this.input[cur] : " ";
            const after = cur < this.input.length ? this.input.slice(cur + 1) : "";
            titleStr = `${before}\x1b[7m${cursorChar}\x1b[0m${after}`;
          }
        }

        const truncatedTitle = truncateToWidth(titleStr, availTitleW, true);
        const lineContent = `${prefix}${truncatedTitle}`;
        const padCount = Math.max(0, leftWidth - stringWidth(lineContent));
        const fullLine = lineContent + " ".repeat(padCount);

        if (isSelected) {
          leftCell = `\x1b[48;5;236m${fullLine}\x1b[0m`;
        } else {
          leftCell = fullLine;
        }
      } else {
        leftCell = " ".repeat(leftWidth);
      }

      const rawRight = rightLines[r] || "";
      const truncatedRight = truncateToWidth(rawRight, rightWidth, false);
      const padRightCount = Math.max(0, rightWidth - stringWidth(truncatedRight));
      const rightCell = truncatedRight + " ".repeat(padRightCount);

      // Belt and braces: a middle row must never be wider than the screen.
      buffer.push(padRight(truncateToWidth(`${leftCell}${sep}${rightCell}`, cols, false), cols));
    }

    // Middle divider
    buffer.push(`\x1b[2m${"─".repeat(cols)}\x1b[0m`);

    // Status / Prompt line
    let statusLine = "";
    if (this.mode === "VISUAL") {
      const fieldName = this.editField === "notes" ? "NOTES" : this.editField === "description" ? "CONTENT" : "TITLE";
      const sel = this.getSelectionRange();
      const countDesc = sel.isLinewise
        ? `${sel.text.split("\n").filter((_, idx, arr) => idx < arr.length - 1 || arr[idx].length > 0).length} lines`
        : `${sel.text.length} chars`;
      const typeDesc = this.visualType === "line" ? "LINE" : "CHAR";
      statusLine = ` \x1b[1;35mVISUAL (${typeDesc}) ${fieldName}:\x1b[0m \x1b[1m[${countDesc} selected]\x1b[0m \x1b[2m[y:Yank d:Cut p:Paste o:SwapEnd Tab:Pane Esc:Cancel]\x1b[0m`;
    } else if (this.mode === "EDIT_NORMAL" || this.mode === "INSERT") {
      const fieldName = this.editField === "notes" ? "NOTES" : this.editField === "description" ? "CONTENT" : "TITLE";
      const nav = this.mode === "EDIT_NORMAL";
      const promptLabel = `EDIT ${fieldName} (${nav ? "NAV" : "INSERT"}): `;
      // Multi-line fields echo just the line under the cursor; the full text
      // lives in the right-hand pane.
      const info = getCursorLineInfo(this.input, this.inputCursor);
      const echo = this.editingMultiline ? info.lineText : this.input;
      const cur = this.editingMultiline
        ? Math.max(0, Math.min(info.col, echo.length))
        : Math.max(0, Math.min(this.inputCursor, echo.length));
      const cursorChar = cur < echo.length ? echo[cur] : " ";
      const displayLine = this.editingMultiline ? `[Line ${info.line + 1}/${info.lines.length}] ` : "";
      const hint = nav ? "[h/l:Move w/b:Word v:Visual Tab:Pane Esc/Enter:Done]" : "[Esc: Nav Mode | Enter: Confirm]";
      const color = nav ? "\x1b[1;34m" : "\x1b[1;33m";
      statusLine = ` ${color}${promptLabel}\x1b[0m${displayLine}\x1b[1m${echo.slice(0, cur)}\x1b[7m${cursorChar}\x1b[0m\x1b[1m${echo.slice(cur + 1)}\x1b[0m \x1b[2m${hint}\x1b[0m`;
    } else if (this.mode === "COMMAND") {
      statusLine = ` \x1b[36m${this.command}\x1b[0m\x1b[7m \x1b[0m`;
    } else {
      const statusColor = this.statusIsError ? "\x1b[31m" : "\x1b[32m";
      statusLine = ` ${statusColor}${this.statusMessage}\x1b[0m`;
    }
    const truncatedStatus = truncateToWidth(statusLine, cols, false);
    const statusPad = Math.max(0, cols - stringWidth(truncatedStatus));
    buffer.push(truncatedStatus + " ".repeat(statusPad));

    // Footer hints line
    let footerHints = "";
    if (this.mode === "VISUAL") {
      footerHints = " y:Yank  d/x:Cut  c:Change  p:Paste  o:SwapCursor  w/b/e:Word  0/$:LineEnd  Tab:Pane  Esc:Cancel";
    } else if (this.mode === "EDIT_NORMAL") {
      footerHints = " h/l:Move  w/b/e:Word  v/V:Visual  yw/yy:Yank  p/P:Paste  Tab:Pane  cw/de:Change  u:Undo  Esc:Done";
    } else if (this.mode === "INSERT") {
      footerHints = ` Type to edit  BS:Delete  Ctrl+W:DelWord  Ctrl+U:DelLine  Esc:NavMode  Enter:${this.editingMultiline ? "Newline" : "Confirm"}`;
    } else if (this.mode === "COMMAND") {
      footerHints = " Enter:Execute  Esc:Cancel  ↑/↓:History  ← →:Move";
    } else {
      footerHints = " j/k:Move  h/l:Fold  o/c:New  e/E/N:Edit  v/y/p:Clip  d:Del  u:Undo  ?:Help  Tab:Indent  J/K:Reorder";
    }
    const truncatedFooter = truncateToWidth(`\x1b[2m${footerHints}\x1b[0m`, cols, false);
    const footerPad = Math.max(0, cols - stringWidth(truncatedFooter));
    buffer.push(truncatedFooter + " ".repeat(footerPad));

    // Help overlay modal
    if (this.showHelpOverlay) {
      this.renderHelpModal(buffer, cols, rows);
    }

    process.stdout.write("\x1b[H" + buffer.join("\n"));
  }

  private renderHelpModal(buffer: string[], cols: number, rows: number): void {
    const modalLines = [
      "╔══════════════════════════════════════════════════════════════════════╗",
      "║                   OUTLINE EDITOR  —  HELP & KEYMAP                   ║",
      "╠══════════════════════════════════════════════════════════════════════╣",
      "║  NORMAL MODE  (outline navigation)                                   ║",
      "║    j / k          Move selection  │  gg / G       Top / bottom       ║",
      "║    Ctrl+F/B       Page ↓ / ↑      │  Ctrl+D/U     Half-page ↓ / ↑    ║",
      "║    h / l / Space  Collapse / expand / toggle fold                    ║",
      "║    w / b          Next / previous sibling                            ║",
      "║    zM / zR        Fold all / Unfold all                              ║",
      "║    J / K          Reorder: move node down / up within siblings       ║",
      "║    Tab / >        Indent (demote)   Shift+Tab / <  Dedent (promote)  ║",
      "║    e / R / Enter  Edit title        i  Edit title → INSERT           ║",
      "║    E / N          Edit content / speaker notes                       ║",
      "║    v / V          Visual text selection on title                     ║",
      "║    yy / Y         Yank node title to clipboard                       ║",
      "║    p / P          Paste clipboard as new sibling below / above       ║",
      "║    o / O          New sibling below / above  → INSERT                ║",
      "║    c              New child  → INSERT                                ║",
      "║    d / x          Delete node       u / Ctrl+R   Undo / Redo         ║",
      "║    q              Quit              ?            Toggle this help    ║",
      "║                                                                      ║",
      "║  EDIT-NAV MODE  (vim motions on node text)                           ║",
      "║    h/l/w/b/e/0/$ move; d/c/D/C/x/X/r/~/s/S edit; i/a/I/A/o/O insert  ║",
      "║    v / V          Start characterwise / linewise visual selection    ║",
      "║    yw / ye / yy   Yank word / line to app-internal clipboard         ║",
      "║    p / P          Paste clipboard after / before cursor              ║",
      "║    Tab / S-Tab    Cycle pane (Title ↔ Content ↔ Notes)               ║",
      "║    Ctrl+W w       Cycle pane;  Ctrl+W h/l/j/k direct pane jump       ║",
      "║    j / k          Move by logical line (content / notes); a          ║",
      "║                   wrapped line is stepped over whole, as in vim      ║",
      "║    Esc / Enter    Confirm and return to NORMAL                       ║",
      "║    Editing content / notes expands the right-hand pane; the          ║",
      "║    arrows on a label (Content: ↑3 ↓12) count rows off-screen         ║",
      "║                                                                      ║",
      "║  VISUAL MODE  (text selection across every pane)                     ║",
      "║    h/j/k/l/w/b/e  Extend selection  │  o  Swap cursor / anchor ends  ║",
      "║    0 / $ / gg / G Extend to line start / end, field start / end      ║",
      "║    y              Yank selection to clipboard                        ║",
      "║    d / x          Cut selection to clipboard                         ║",
      "║    c / s          Change selection (cut and enter INSERT)            ║",
      "║    p / P          Replace selection with clipboard content           ║",
      "║    v / V / Esc    Toggle mode / Cancel visual selection              ║",
      "║                                                                      ║",
      "║  FILESYSTEM & COMMANDS  (:)                                          ║",
      "║    Auto-reloads when clean; a reload arriving mid-edit is applied    ║",
      "║    on return to NORMAL. Warns instead when local edits are pending   ║",
      "║    :w  save   :w!  force save (overwrite external disk changes)      ║",
      "║    :q  quit   :q!  force quit   :wq / :wq!  save & quit              ║",
      "║    :e <file>  open file         :e!  discard local edits & reload    ║",
      "║    :m [file]  export Markdown                                        ║",
      "║    :!<cmd>    run a shell command (any key resumes the editor)       ║",
      "╚══════════════════════════════════════════════════════════════════════╝",
    ];

    buffer.length = 0;
    const modalWidth = Math.min(72, cols);
    const boxLeftPad = Math.max(0, Math.floor((cols - modalWidth) / 2));
    const topPad = Math.max(0, Math.floor((rows - modalLines.length - 1) / 2));
    for (let i = 0; i < topPad; i++) {
      buffer.push(" ".repeat(cols));
    }
    // The box is taller than a 24-row terminal, so it scrolls rather than
    // running off the bottom of the screen and taking the layout with it.
    const viewport = Math.max(1, rows - topPad - 1);
    const maxScroll = Math.max(0, modalLines.length - viewport);
    this.helpScroll = Math.min(Math.max(0, this.helpScroll), maxScroll);
    const visibleLines = modalLines.slice(this.helpScroll, this.helpScroll + viewport);
    for (const line of visibleLines) {
      const truncated = truncateToWidth(line, modalWidth, false);
      const rightPad = Math.max(0, cols - boxLeftPad - stringWidth(truncated));
      buffer.push(`${" ".repeat(boxLeftPad)}\x1b[1;37m${truncated}\x1b[0m${" ".repeat(rightPad)}`);
    }
    const scrollTag = maxScroll > 0
      ? ` ${this.helpScroll > 0 ? "↑" : " "}${this.helpScroll < maxScroll ? "↓" : " "} j/k scroll `
      : "";
    const footerText = `${scrollTag} Press ? or Escape to return to editor `;
    const truncatedFooterText = truncateToWidth(footerText, cols, false);
    const footerWidth = stringWidth(truncatedFooterText);
    const footerLeftPad = Math.max(0, Math.floor((cols - footerWidth) / 2));
    const footerRightPad = Math.max(0, cols - footerLeftPad - footerWidth);
    buffer.push(`${" ".repeat(footerLeftPad)}\x1b[7m${truncatedFooterText}\x1b[0m${" ".repeat(footerRightPad)}`);
    while (buffer.length < rows) {
      buffer.push(" ".repeat(cols));
    }
  }

  /**
   * Draw a multi-line field into exactly `height` rows.
   *
   * Both the read-only and the editing view soft-wrap: long lines are broken
   * onto continuation rows rather than being cut off at the pane edge, so no
   * part of a description is ever unreachable. While editing, the cursor
   * offset is mapped through the wrap so it lands on the right visual row, and
   * the window scrolls vertically to keep that row on screen. Motions still
   * operate on logical lines — `j`/`k` step over a wrapped line as a whole,
   * the way vim does without `gj`/`gk`. A visual selection is painted through
   * the same mapping, so a highlight spans continuation rows unbroken.
   *
   * Returns the count of rows hidden above and below so the caller can flag
   * the overflow on the section label instead of spending a row on it.
   */
  private renderTextBlock(
    text: string,
    width: number,
    height: number,
    editing: boolean,
    emptyHint: string,
    trackStructure: boolean
  ): { rows: string[]; above: number; below: number } {
    const empty = { rows: [] as string[], above: 0, below: 0 };
    if (height <= 0 || width <= 0) return empty;
    if (!editing && !text) {
      return { rows: [truncateToWidth(`\x1b[2m${emptyHint}\x1b[0m`, width, false)], above: 0, below: 0 };
    }

    const info = editing ? getCursorLineInfo(this.input, this.inputCursor) : null;
    const logical = info ? info.lines : text.split("\n");
    const lineStyles = computeMarkdownStyles(logical, trackStructure);
    // A block cursor can sit one column past the end of a row, so editing
    // wraps one column early to keep it inside the pane.
    const bodyWidth = editing ? Math.max(1, width - 1) : width;
    const indent = bodyWidth > WRAP_CONTINUATION_INDENT + 8 ? WRAP_CONTINUATION_INDENT : 0;

    const rows: Array<{ text: string; line: number; start: number; indent: number }> = [];
    for (let li = 0; li < logical.length; li++) {
      const segments = wrapLineSegments(logical[li], bodyWidth, bodyWidth - indent);
      for (let si = 0; si < segments.length; si++) {
        rows.push({ text: segments[si].text, line: li, start: segments[si].start, indent: si === 0 ? 0 : indent });
      }
    }

    // Locate the cursor: the last row of its logical line that starts at or
    // before it. That also catches a cursor resting on a wrapped-away space.
    let cursorRow = -1;
    let cursorCol = 0;
    if (info) {
      for (let ri = 0; ri < rows.length; ri++) {
        if (rows[ri].line < info.line) continue;
        if (rows[ri].line > info.line) break;
        if (rows[ri].start <= info.col) cursorRow = ri;
      }
      if (cursorRow >= 0) {
        cursorCol = Math.min(info.col - rows[cursorRow].start, rows[cursorRow].text.length);
      }
    }

    let first = 0;
    if (rows.length > height && cursorRow >= 0) {
      first = Math.max(0, Math.min(cursorRow - Math.floor(height / 2), rows.length - height));
    }
    const last = Math.min(rows.length, first + height);

    const lineOffsets: number[] = [];
    let curOff = 0;
    for (let i = 0; i < logical.length; i++) {
      lineOffsets.push(curOff);
      curOff += logical[i].length + 1;
    }

    const out: string[] = [];
    for (let ri = first; ri < last; ri++) {
      const row = rows[ri];
      const pad = " ".repeat(row.indent);
      const rowStyles = lineStyles[row.line].slice(row.start, row.start + row.text.length);

      if (editing && this.mode === "VISUAL") {
        const sel = this.getSelectionRange();
        const lineStart = lineOffsets[row.line];
        const rowCharAbsStart = lineStart + row.start;
        let rowFormatted = "";
        let openKey: string | null = null;
        for (let col = 0; col < row.text.length; col++) {
          const absIdx = rowCharAbsStart + col;
          const isSelected = absIdx >= sel.start && absIdx <= sel.end;
          const isCursor = absIdx === this.inputCursor;
          const ch = row.text[col];
          const style = rowStyles[col] || "";

          if (isCursor) {
            if (openKey !== null) { rowFormatted += "\x1b[0m"; openKey = null; }
            rowFormatted += `\x1b[7;1m${ch}\x1b[0m`;
            continue;
          }
          const key = isSelected || style ? `${isSelected ? 1 : 0}:${style}` : null;
          if (key !== openKey) {
            if (openKey !== null) rowFormatted += "\x1b[0m";
            if (key !== null) {
              if (isSelected) rowFormatted += "\x1b[48;5;24;37m";
              if (style) rowFormatted += style;
            }
            openKey = key;
          }
          rowFormatted += ch;
        }
        if (openKey !== null) rowFormatted += "\x1b[0m";

        if (ri === cursorRow && cursorCol >= row.text.length) {
          rowFormatted += `\x1b[7;1m \x1b[0m`;
        }
        out.push(truncateToWidth(pad + rowFormatted, width, false));
        continue;
      }

      if (ri !== cursorRow) {
        out.push(truncateToWidth(pad + applyLineStyles(row.text, rowStyles), width, false));
        continue;
      }
      const col = Math.max(0, Math.min(cursorCol, row.text.length));
      const before = applyLineStyles(row.text.slice(0, col), rowStyles.slice(0, col));
      const cursorChar = col < row.text.length ? row.text[col] : " ";
      const after = applyLineStyles(row.text.slice(col + 1), rowStyles.slice(col + 1));
      out.push(truncateToWidth(`${pad}${before}\x1b[7m${cursorChar}\x1b[0m${after}`, width, false));
    }

    return { rows: out, above: first, below: rows.length - last };
  }

  private getNodePathParts(node: OutlineNode): string[] {
    const crumbs: string[] = [];
    let cur: OutlineNode | null = node;
    while (cur && cur.id !== "root") {
      crumbs.unshift(cur.title || "Untitled");
      cur = this.outline.findParent(this.outline.root, cur.id);
    }
    return crumbs;
  }

  private getNodePath(node: OutlineNode): string {
    return this.getNodePathParts(node).join(" \x1b[2m>\x1b[0m ");
  }

  private getSubtreeDepth(node: OutlineNode): number {
    const walk = (n: OutlineNode): number => {
      if (n.children.length === 0) return 0;
      return 1 + Math.max(...n.children.map(walk));
    };
    return walk(node);
  }

  private quit(force: boolean = false): void {
    if (this.closed) return;

    // Guard against accidental data loss when there are unsaved changes.
    if (!force && this.modified) {
      this.statusMessage = "Unsaved changes! Use :w to save, :wq to save+quit, or :q! to force quit.";
      this.statusIsError = true;
      this.render();
      return;
    }

    this.closeFileWatcher();
    this.closed = true;

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.removeListener("keypress", this.onKey);
    process.stdout.removeListener("resize", this.onResize);
    process.removeListener("SIGINT", this.onSignal);
    process.removeListener("SIGTERM", this.onSignal);
    // A raw-mode stdin remains referenced after its keypress listener is
    // removed. Pause it so the resolved run() promise can actually return to
    // the shell instead of leaving the Node process alive.
    process.stdin.pause();

    // Leave alternate screen buffer, restore cursor
    process.stdout.write("\x1b[?25h\x1b[?1049l\n");

    const done = this.onClosed;
    this.onClosed = null;
    if (done) done();
  }
}

// Command-line documentation
const VERSION = "0.2.0";

const HELP_TEXT = `OUTLINE EDITOR ${VERSION} - Interactive direct-manipulation terminal outline editor

SYNOPSIS
  outline-editor [OPTIONS] [FILE]

DESCRIPTION
  Edit a hierarchical outline tree in a responsive, full-screen direct-manipulation
  terminal UI with raw-mode single-keystroke navigation, instant tree reordering,
  indent/dedent restructuring, inline editing, undo/redo, and two-pane inspection.

  FILE specifies the Markdown slide file to read/write (defaults to outline.md).
  If FILE does not exist, a starter outline is created in memory. Changes remain in memory
  until saved via :w or Ctrl+S.

  Auto-reloads external changes from the filesystem when no local edits are pending.
  A change arriving while a node is open for editing is applied on the return to
  NORMAL, so the edit buffer is never swapped out from under the cursor.
  Warns and blocks save on conflict if the file was modified externally.

OPTIONS
  -h, --help       Print this help text and exit
  -v, --version    Print the version number and exit

KEYBOARD SHORTCUTS
  NORMAL MODE  (outline navigation — vim-style)
    j / k          Move selection down / up
    Ctrl+F / Ctrl+B  Page down / up      Ctrl+D / Ctrl+U  Half-page
    gg / G         Jump to top / bottom
    h / l / Space  Collapse / expand / toggle fold  (NOT cursor movement)
    w / b          Next / previous sibling          (NOT word movement)
    zM / zR        Fold all / Unfold all
    J / K          Reorder: move node down / up within siblings
    Tab / >        Indent (demote)     Shift+Tab / <  Dedent (promote)
    e / R / Enter  Edit title → EDIT-NAV mode
    i              Edit title → INSERT mode directly
    E              Edit content (→ INSERT if currently empty)
    N              Edit speaker notes (→ INSERT if currently empty)
    v / V          Visual text selection on title
    yy / Y         Yank node title to clipboard
    p / P          Paste clipboard as new sibling below / above
    o / O          New sibling below / above → INSERT
    c              New child → INSERT
    d / x          Delete node and all descendants
    u / Ctrl+R     Undo / Redo structural changes
    q              Quit (warns if unsaved)    ?  Toggle help overlay

  EDIT-NAV MODE  (vim normal-mode motions on the node text)
    Standard vim motions and operators apply: h/l/w/b/e/0/$ move;
    d/c/D/C/x/X/r/~/s/S edit; i/a/I/A/o/O → INSERT.
    v / V          Start characterwise / linewise visual selection
    yw / ye / yy   Yank word / line to single-slot clipboard
    p / P          Paste clipboard after / before cursor
    Tab / Shift+Tab Cycle active pane (Title ↔ Content ↔ Notes)
    Ctrl+W w       Cycle active pane (Ctrl+W h/l/j/k for directional jump)
    j / k          Move cursor to next / previous logical line (content /
                   notes). Long lines are soft-wrapped onto continuation rows,
                   so j / k step over a wrapped line as a whole, as in vim
                   without gj / gk.
    Ctrl+W         Delete word backward (in INSERT)
    Ctrl+U         Delete to beginning of line (in INSERT)
    Esc / Enter    Confirm and return to NORMAL mode

  While a content or notes field is being edited, the right-hand pane
  switches to a focus layout: the metadata collapses to the title and the other
  field to a single row, so the text being edited gets nearly the whole pane.
  Arrows on a section label (for example \`Content: ↑3 ↓12\`) count the rows
  scrolled out of view above and below.

  VISUAL MODE  (text selection across every pane)
    h / j / k / l  Extend selection by char / line
    w / b / e      Extend selection by word start / prev / word end
    0 / $ / gg / G Extend selection to line start / end / file start / end
    o              Swap cursor and anchor ends of selection
    y              Yank selection to clipboard
    d / x          Cut selection to clipboard
    c / s          Cut selection and enter INSERT mode
    p / P          Replace selection with clipboard content
    v / V / Esc    Toggle mode / Cancel visual selection
    Tab / Shift+Tab Switch pane

  COMMANDS  (:)
    ↑ / ↓          Browse command history
    :w / Ctrl+S    Save as Markdown slides (warns if disk file changed)
    :w!            Force save (overwrite external disk modifications)
    :q             Quit (warns if unsaved)
    :q!            Force quit without saving
    :wq            Save and quit
    :wq!           Force save and quit
    :e <file>      Open another file (warns if unsaved changes exist)
    :e!            Force reload from disk (discard local edits)
    :m [file]      Export outline to Markdown
    :!<cmd>        Run a shell command (any key resumes the editor)

FILE FORMAT
  Files are saved as Markdown slides. Top-level outline items become slides and
  are separated by \`---\`; child items become headings within their parent slide.
  Speaker notes round-trip as pandoc \`::: notes\` fenced divs, which both the
  reveal.js and the Beamer writers understand:
    # Introduction

    Welcome to the presentation.

    ::: notes
    Remember to mention the schedule.
    :::

    ---

    # Main Content
    ## Section 1

ENVIRONMENT
  OUTLINE_ESCAPE_TIMEOUT  Milliseconds to wait after a lone ESC for the rest of
                          an escape sequence (default 25). Raise it if arrow
                          keys misbehave over a slow connection.

EXAMPLES
  outline-editor
  outline-editor article.md
  outline-editor --help
`;

function printHelp(): void {
  process.stdout.write(HELP_TEXT);
}

function printVersion(): void {
  process.stdout.write(`outline-editor ${VERSION}\n`);
}

// Main entrypoint
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);

    if (args.includes("--help") || args.includes("-h")) {
      printHelp();
      return;
    }
    if (args.includes("--version") || args.includes("-v")) {
      printVersion();
      return;
    }

    const filename = args[0] || "outline.md";
    const editor = new OutlineEditorTUI(filename);
    await editor.run();
  })();
}
