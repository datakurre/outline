import * as fs from "fs";
import * as readline from "readline";

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

  toJSON(): string {
    return JSON.stringify(this.root, null, 2);
  }

  fromJSON(json: string): void {
    const parsed: unknown = JSON.parse(json);
    if (!this.isValidTree(parsed) || parsed.id !== "root") {
      throw new Error("Invalid outline: expected a root node with a valid node tree");
    }

    parsed.collapsed = false;
    this.root = parsed;
    // `notes` post-dates the original format, so older trees — and undo
    // snapshots taken before it existed — may omit it entirely.
    this.walkNodes(this.root, (node) => {
      if (typeof node.notes !== "string") node.notes = "";
    });
    this.updateNextId();
  }

  private isValidTree(value: unknown, ids = new Set<string>()): value is OutlineNode {
    if (typeof value !== "object" || value === null) return false;
    const node = value as Partial<OutlineNode>;
    if (
      typeof node.id !== "string" ||
      typeof node.title !== "string" ||
      typeof node.description !== "string" ||
      (node.notes !== undefined && typeof node.notes !== "string") ||
      typeof node.collapsed !== "boolean" ||
      !Array.isArray(node.children) ||
      ids.has(node.id)
    ) {
      return false;
    }
    ids.add(node.id);
    return node.children.every((child) => this.isValidTree(child, ids));
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

      const heading = rawLine.match(/^(#{1,6})[ \t]+(.+?)\s*#*\s*$/);
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
        lastNode.description +=
          (lastNode.description ? "\n".repeat(pendingBlanks + 1) : "") + rawLine;
        pendingBlanks = 0;
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
  // Two levels of navigation:
  // Level 1: "NORMAL" (outline tree navigation)
  // Level 2: "EDIT_NORMAL" (node text navigation before typing changes)
  // Level 3: "INSERT" (typing changes)
  private mode: "NORMAL" | "EDIT_NORMAL" | "INSERT" | "COMMAND" = "NORMAL";
  private input: string = "";
  private inputCursor: number = 0;
  private editField: EditField = "title";
  private pendingEditOp: string = "";
  private textUndoStack: { input: string; cursor: number }[] = [];
  private textRedoStack: { input: string; cursor: number }[] = [];
  private textYankBuffer: string = "";
  private command: string = "";
  private commandCursor: number = 0;
  private statusMessage: string = "Ready";
  private statusIsError: boolean = false;
  private modified: boolean = false;
  private closed: boolean = false;
  private onClosed: (() => void) | null = null;
  private showHelpOverlay: boolean = false;
  private pendingSequence: string = "";
  private undoStack: string[] = [];
  private redoStack: string[] = [];
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
        // Keep existing JSON outlines readable, but all writes use Markdown.
        if (/^\s*\{/.test(data)) this.outline.fromJSON(data);
        else this.outline.fromMarkdown(data);
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

  private snapshot(): void {
    this.undoStack.push(this.outline.toJSON());
    if (this.undoStack.length > 100) {
      this.undoStack.shift();
    }
    this.redoStack = [];
    this.modified = true;
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
      this.modified = true;
    }
  }

  private popTextRedo(): void {
    if (this.textRedoStack.length > 0) {
      const state = this.textRedoStack.pop()!;
      this.textUndoStack.push({ input: this.input, cursor: this.inputCursor });
      this.input = state.input;
      this.inputCursor = Math.min(this.input.length, state.cursor);
      this.modified = true;
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

  private finishEdit(): void {
    const node = this.selectedNode;
    if (node) {
      if (this.editField === "description") {
        node.description = this.input;
      } else if (this.editField === "notes") {
        node.notes = this.input;
      } else {
        node.title = this.input.trim() || "Untitled";
      }
      this.modified = true;
    }
    this.mode = "NORMAL";
    this.input = "";
    this.inputCursor = 0;
    this.editField = "title";
    this.pendingEditOp = "";
    this.textUndoStack = [];
    this.textRedoStack = [];
    this.statusMessage = "Ready";
    this.statusIsError = false;
  }

  private cancelEdit(): void {
    const node = this.selectedNode;
    if (node && !node.title && this.editField === "title") {
      // A new node was created but the user cancelled without entering a title.
      // Pop the snapshot that beginEdit pushed so undo history stays clean.
      const prev = this.undoStack.pop();
      if (prev) {
        try {
          this.outline.fromJSON(prev);
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
    this.textUndoStack = [];
    this.textRedoStack = [];
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
        this.redoStack.push(this.outline.toJSON());
        this.outline.fromJSON(prev);
        this.clampSelection();
        this.modified = true;
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
        this.undoStack.push(this.outline.toJSON());
        this.outline.fromJSON(next);
        this.clampSelection();
        this.modified = true;
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

    if (this.showHelpOverlay) {
      if (key.name === "escape" || key.name === "?" || key.name === "q" || key.name === "return") {
        this.showHelpOverlay = false;
      }
      this.render();
      return;
    }

    if (this.mode === "EDIT_NORMAL") {
      const seq = key.sequence || "";

      // Single-character replacement mode: r<char>
      if (this.pendingEditOp === "r") {
        if (key.name === "escape") {
          this.pendingEditOp = "";
        } else if (seq && seq.length === 1 && !key.ctrl && !key.meta) {
          if (this.input.length > 0 && this.inputCursor < this.input.length) {
            this.pushTextUndo();
            this.input = this.input.slice(0, this.inputCursor) + seq + this.input.slice(this.inputCursor + 1);
            this.modified = true;
          }
          this.pendingEditOp = "";
        }
        this.render();
        return;
      }

      // Pending delete or change operator (dw, de, db, d$, d0, dd, cw, ce, cb, c$, c0, cc)
      if (this.pendingEditOp === "d" || this.pendingEditOp === "c") {
        const isChange = this.pendingEditOp === "c";
        const op = seq || key.name;
        this.pendingEditOp = "";

        if (op === "escape") {
          this.render();
          return;
        }

        const info = getCursorLineInfo(this.input, this.inputCursor);

        if (op === "w" || op === "e") {
          this.pushTextUndo();
          const endIdx = op === "w"
            ? this.findNextWordStart(this.input, this.inputCursor)
            : this.findCurrentWordEnd(this.input, this.inputCursor);
          // `e` is an inclusive motion: the char at endIdx is deleted too.
          const sliceFrom = op === "e" ? endIdx + 1 : endIdx;
          this.input = this.input.slice(0, this.inputCursor) + this.input.slice(sliceFrom);
          if (isChange) this.mode = "INSERT";
          this.modified = true;
        } else if (op === "b") {
          this.pushTextUndo();
          const startIdx = this.findPrevWordStart(this.input, this.inputCursor);
          this.input = this.input.slice(0, startIdx) + this.input.slice(this.inputCursor);
          this.inputCursor = startIdx;
          if (isChange) this.mode = "INSERT";
          this.modified = true;
        } else if (op === "$" || op === "end") {
          this.pushTextUndo();
          this.input = this.input.slice(0, this.inputCursor) + this.input.slice(info.lineEnd);
          if (isChange) this.mode = "INSERT";
          this.modified = true;
        } else if (op === "0" || op === "^" || op === "home") {
          this.pushTextUndo();
          this.input = this.input.slice(0, info.lineStart) + this.input.slice(this.inputCursor);
          this.inputCursor = info.lineStart;
          if (isChange) this.mode = "INSERT";
          this.modified = true;
        } else if ((isChange && op === "c") || (!isChange && op === "d")) {
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
          this.modified = true;
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

      switch (seq || key.name) {
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
          this.modified = true;
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
          this.modified = true;
          break;

        // In-place edits
        case "x":
        case "delete":
          if (this.input.length > 0 && this.inputCursor < this.input.length) {
            this.pushTextUndo();
            this.input = this.input.slice(0, this.inputCursor) + this.input.slice(this.inputCursor + 1);
            if (this.inputCursor >= this.input.length && this.inputCursor > 0) this.inputCursor--;
            this.modified = true;
          }
          break;
        case "X":
        case "backspace":
          if (info.col > 0) {
            this.pushTextUndo();
            this.input = this.input.slice(0, this.inputCursor - 1) + this.input.slice(this.inputCursor);
            this.inputCursor--;
            this.modified = true;
          }
          break;
        case "s":
          this.pushTextUndo();
          if (this.input.length > 0 && this.inputCursor < this.input.length) {
            this.input = this.input.slice(0, this.inputCursor) + this.input.slice(this.inputCursor + 1);
          }
          this.mode = "INSERT";
          this.modified = true;
          break;
        case "S":
          this.pushTextUndo();
          this.input = this.input.slice(0, info.lineStart) + this.input.slice(info.lineEnd);
          this.inputCursor = info.lineStart;
          this.mode = "INSERT";
          this.modified = true;
          break;
        case "D":
          this.pushTextUndo();
          this.input = this.input.slice(0, this.inputCursor) + this.input.slice(info.lineEnd);
          // Clamp cursor: in EDIT_NORMAL the cursor must sit ON a char (not past last)
          if (this.input.length > 0 && this.inputCursor >= this.input.length) {
            this.inputCursor = this.input.length - 1;
          }
          this.modified = true;
          break;
        case "C":
          this.pushTextUndo();
          this.input = this.input.slice(0, this.inputCursor) + this.input.slice(info.lineEnd);
          this.mode = "INSERT";
          this.modified = true;
          break;
        case "~":
          if (this.input.length > 0 && this.inputCursor < this.input.length) {
            this.pushTextUndo();
            const ch = this.input[this.inputCursor];
            const flipped = ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
            this.input = this.input.slice(0, this.inputCursor) + flipped + this.input.slice(this.inputCursor + 1);
            if (this.inputCursor < info.lineEnd - 1) this.inputCursor++;
            this.modified = true;
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
          this.modified = true;
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
          this.modified = true;
        }
      } else if (key.name === "delete") {
        if (this.inputCursor < this.input.length) {
          this.pushTextUndo();
          this.input = this.input.slice(0, this.inputCursor) + this.input.slice(this.inputCursor + 1);
          this.modified = true;
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
          this.modified = true;
        }
      } else if (key.ctrl && key.name === "u") {
        // Ctrl+U: delete from cursor to start of line (vim INSERT mode standard)
        if (this.inputCursor > 0) {
          this.pushTextUndo();
          const info = getCursorLineInfo(this.input, this.inputCursor);
          this.input = this.input.slice(0, info.lineStart) + this.input.slice(this.inputCursor);
          this.inputCursor = info.lineStart;
          this.modified = true;
        }
      } else if (key.ctrl && key.name === "h") {
        // Ctrl+H: backspace (vim INSERT mode alias)
        if (this.inputCursor > 0) {
          this.pushTextUndo();
          this.input = this.input.slice(0, this.inputCursor - 1) + this.input.slice(this.inputCursor);
          this.inputCursor--;
          this.modified = true;
        }
      } else if (isPrintable(key)) {
        this.input = this.input.slice(0, this.inputCursor) + key.sequence + this.input.slice(this.inputCursor);
        this.inputCursor += key.sequence!.length;
        this.modified = true;
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

    const seq = key.sequence || "";

    if (key.name === "colon" || seq === ":") {
      this.mode = "COMMAND";
      this.command = ":";
      this.commandCursor = 1;
      this.render();
      return;
    }

    // Multi-key sequences (gg, zc, zo, za, zM, zR)
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
    } else if (seq === "g" || seq === "z") {
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
    const parts = raw.split(/\s+/);
    const cmd = parts[0];
    const arg = parts[1];

    if (cmd === "w" || cmd === "write") {
      this.saveFile(arg);
    } else if (cmd === "q" || cmd === "quit") {
      this.quit();
    } else if (cmd === "wq" || cmd === "x") {
      this.saveFile(arg);
      this.quit();
    } else if (cmd === "e" || cmd === "edit" || cmd === "load") {
      this.loadFile(arg || this.filename);
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

  private saveFile(targetFile?: string): void {
    // A legacy .json input is migrated to a Markdown file instead of being
    // silently overwritten with a different format.
    const file = targetFile || (/\.json$/i.test(this.filename)
      ? this.filename.replace(/\.json$/i, ".md")
      : this.filename);
    try {
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
      this.filename = file;
      this.modified = false;
      this.statusMessage = `✓ Saved to ${file}`;
      this.statusIsError = false;
    } catch (err) {
      this.statusMessage = `✗ Error saving: ${err instanceof Error ? err.message : String(err)}`;
      this.statusIsError = true;
    }
  }

  private loadFile(file: string): void {
    try {
      if (fs.existsSync(file)) {
        const data = fs.readFileSync(file, "utf8");
        if (/^\s*\{/.test(data)) this.outline.fromJSON(data);
        else this.outline.fromMarkdown(data);
        this.filename = file;
        this.currentIndex = 0;
        this.scrollOffset = 0;
        this.modified = false;
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
      if (file === this.filename) this.modified = false;
      this.statusMessage = `✓ Exported markdown to ${file}`;
      this.statusIsError = false;
    } catch (err) {
      this.statusMessage = `✗ Error exporting: ${err instanceof Error ? err.message : String(err)}`;
      this.statusIsError = true;
    }
  }

  private render(): void {
    if (this.closed) return;

    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const buffer: string[] = [];

    // Header bar
    const modTag = this.modified ? " \x1b[33m[+Modified]\x1b[0m" : "";
    let modeBadge = "\x1b[42;30m OUTLINE \x1b[0m";
    const fieldTag = this.editField === "notes" ? "NOTE" : "DESC";
    if (this.mode === "EDIT_NORMAL") {
      modeBadge = this.editingMultiline ? `\x1b[44;37m ${fieldTag}-NAV \x1b[0m` : "\x1b[44;37m EDIT-NAV \x1b[0m";
    } else if (this.mode === "INSERT") {
      modeBadge = this.editingMultiline ? `\x1b[45;37m ${fieldTag}-INS \x1b[0m` : "\x1b[43;30m INSERT \x1b[0m";
    } else if (this.mode === "COMMAND") {
      modeBadge = "\x1b[46;30m COMMAND \x1b[0m";
    }

    const headerLeftBase = " \x1b[1mOUTLINE EDITOR\x1b[0m  \x1b[36m";
    const headerRight = `${modeBadge} `;
    const rightLen = stringWidth(headerRight);
    const maxFileLen = Math.max(8, cols - 20 - rightLen - (this.modified ? 12 : 0));
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
    const editingField = this.mode === "EDIT_NORMAL" || this.mode === "INSERT" ? this.editField : null;
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
        "(no description — press 'E' to add slide content)"
      );
      const notes = showNotes
        ? this.renderTextBlock(
            selected.notes,
            rightWidth,
            notesHeight,
            editingField === "notes",
            "(no speaker notes — press 'N' to add)"
          )
        : { rows: [], above: 0, below: 0 };

      const divider = `\x1b[2m${"─".repeat(rightWidth)}\x1b[0m`;
      rightLines.push(...metaLines);
      rightLines.push(divider);
      rightLines.push(`\x1b[1mDescription:\x1b[0m${overflowTag(desc)}`);
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
        if (isSelected && (this.mode === "EDIT_NORMAL" || this.mode === "INSERT") && !this.editingMultiline) {
          const cur = Math.max(0, Math.min(this.inputCursor, this.input.length));
          const before = this.input.slice(0, cur);
          const cursorChar = cur < this.input.length ? this.input[cur] : " ";
          const after = cur < this.input.length ? this.input.slice(cur + 1) : "";
          titleStr = `${before}\x1b[7m${cursorChar}\x1b[0m${after}`;
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
    if (this.mode === "EDIT_NORMAL" || this.mode === "INSERT") {
      const fieldName = this.editField === "notes" ? "NOTES" : this.editField === "description" ? "DESC" : "TITLE";
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
      const hint = nav ? "[h/l:Move w/b:Word i/a:Insert Esc/Enter:Done]" : "[Esc: Nav Mode | Enter: Confirm]";
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
    if (this.mode === "EDIT_NORMAL") {
      footerHints = " h/l:Move  w/b/e:Word  0/$:LineEnd  i/a/A:Insert  x:Del  cw/de:Change  r:Replace  u:Undo  Esc/Enter:Done";
    } else if (this.mode === "INSERT") {
      footerHints = ` Type to edit  BS:Delete  Ctrl+W:DelWord  Ctrl+U:DelLine  Esc:NavMode  Enter:${this.editingMultiline ? "Newline" : "Confirm"}`;
    } else if (this.mode === "COMMAND") {
      footerHints = " Enter:Execute  Esc:Cancel  ↑/↓:History  ← →:Move";
    } else {
      footerHints = " j/k:Move  Ctrl+F/B:Page  h/l:Fold  J/K:Reorder  Tab:Indent  o/c:New  e/R:Edit  E:Desc  N:Notes  d:Del  u:Undo  :w:Save  ?:Help  q:Quit";
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
      "║    E / N          Edit description / speaker notes                   ║",
      "║    o / O          New sibling below / above  → INSERT                ║",
      "║    c              New child  → INSERT                                ║",
      "║    d / x          Delete node + descendants                          ║",
      "║    u / Ctrl+R     Undo / Redo   q  Quit   ?  Toggle this help        ║",
      "║                                                                      ║",
      "║  EDIT-NAV MODE  (vim motions on node text)                           ║",
      "║    Standard vim: h/l/w/b/e/0/$ move; d/c/D/C/x/X/r/~/s/S edit        ║",
      "║    i/a/I/A/o/O → INSERT    u / Ctrl+R  undo/redo text                ║",
      "║    Ctrl+W  delete word back    Ctrl+U  delete to line start          ║",
      "║    Esc / Enter  confirm & return to NORMAL                           ║",
      "║    j / k  move logical line (description / notes); long lines wrap   ║",
      "║    Editing a description or notes expands the right-hand pane        ║",
      "║                                                                      ║",
      "║  COMMANDS  (:)   ↑/↓ browse history   ← → move cursor                ║",
      "║    :w  save   :q  quit   :q!  force quit   :wq  save & quit          ║",
      "║    :e <file>  open    :m [file]  export Markdown                     ║",
      "╚══════════════════════════════════════════════════════════════════════╝",
    ];

    buffer.length = 0;
    const modalWidth = Math.min(72, cols);
    const boxLeftPad = Math.max(0, Math.floor((cols - modalWidth) / 2));
    const topPad = Math.max(0, Math.floor((rows - modalLines.length - 1) / 2));
    for (let i = 0; i < topPad; i++) {
      buffer.push(" ".repeat(cols));
    }
    for (const line of modalLines) {
      const truncated = truncateToWidth(line, modalWidth, false);
      const rightPad = Math.max(0, cols - boxLeftPad - stringWidth(truncated));
      buffer.push(`${" ".repeat(boxLeftPad)}\x1b[1;37m${truncated}\x1b[0m${" ".repeat(rightPad)}`);
    }
    const footerText = " Press ? or Escape to return to editor ";
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
   * the way vim does without `gj`/`gk`.
   *
   * Returns the count of rows hidden above and below so the caller can flag
   * the overflow on the section label instead of spending a row on it.
   */
  private renderTextBlock(
    text: string,
    width: number,
    height: number,
    editing: boolean,
    emptyHint: string
  ): { rows: string[]; above: number; below: number } {
    const empty = { rows: [] as string[], above: 0, below: 0 };
    if (height <= 0 || width <= 0) return empty;
    if (!editing && !text) {
      return { rows: [truncateToWidth(`\x1b[2m${emptyHint}\x1b[0m`, width, false)], above: 0, below: 0 };
    }

    const info = editing ? getCursorLineInfo(this.input, this.inputCursor) : null;
    const logical = info ? info.lines : text.split("\n");
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

    const out: string[] = [];
    for (let ri = first; ri < last; ri++) {
      const row = rows[ri];
      const pad = " ".repeat(row.indent);
      if (ri !== cursorRow) {
        out.push(truncateToWidth(pad + row.text, width, false));
        continue;
      }
      const col = Math.max(0, Math.min(cursorCol, row.text.length));
      const before = row.text.slice(0, col);
      const cursorChar = col < row.text.length ? row.text[col] : " ";
      const after = col < row.text.length ? row.text.slice(col + 1) : "";
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
  Existing JSON outline files can still be opened and are migrated to Markdown on
  save. If FILE does not exist, a starter outline is created in memory. Changes remain in memory
  until saved via :w or Ctrl+S.

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
    E              Edit description (→ INSERT if currently empty)
    N              Edit speaker notes (→ INSERT if currently empty)
    o / O          New sibling below / above → INSERT
    c              New child → INSERT
    d / x          Delete node and all descendants
    u / Ctrl+R     Undo / Redo structural changes
    q              Quit (warns if unsaved)    ?  Toggle help overlay

  EDIT-NAV MODE  (vim normal-mode motions on the node text)
    Standard vim motions and operators apply: h/l/w/b/e/0/$  move;
    d/c/D/C/x/X/r/~/s/S  edit;  i/a/I/A/o/O → INSERT.
    j / k          Move cursor to next / previous logical line (description /
                   notes). Long lines are soft-wrapped onto continuation rows,
                   so j / k step over a wrapped line as a whole, as in vim
                   without gj / gk.

  While a description or notes field is being edited, the right-hand pane
  switches to a focus layout: the metadata collapses to the title and the other
  field to a single row, so the text being edited gets nearly the whole pane.
  Arrows on a section label (for example \`Description: ↑3 ↓12\`) count the rows
  scrolled out of view above and below.
    Ctrl+W         Delete word backward (also works in INSERT)
    Ctrl+U         Delete to beginning of line (also works in INSERT)
    Esc / Enter    Confirm and return to NORMAL mode

  COMMANDS  (:)
    ↑ / ↓          Browse command history
    :w / Ctrl+S    Save as Markdown slides
    :q             Quit (warns if unsaved)
    :q!            Force quit without saving
    :wq            Save and quit
    :e <file>      Open another file
    :m [file]      Export outline to Markdown

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
