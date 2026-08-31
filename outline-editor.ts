import * as fs from "fs";
import * as readline from "readline";

// Core data model
export interface OutlineNode {
  id: string;
  title: string;
  description: string;
  children: OutlineNode[];
  collapsed: boolean;
}

export class Outline {
  root: OutlineNode;
  private nextId: number = 1;

  constructor() {
    this.root = {
      id: "root",
      title: "Article Outline",
      description: "",
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

  updateNode(nodeId: string, title: string, description: string): boolean {
    const node = this.findNode(nodeId);
    if (!node) return false;
    node.title = title;
    node.description = description;
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
    this.updateNextId();
  }

  private isValidTree(value: unknown, ids = new Set<string>()): value is OutlineNode {
    if (typeof value !== "object" || value === null) return false;
    const node = value as Partial<OutlineNode>;
    if (
      typeof node.id !== "string" ||
      typeof node.title !== "string" ||
      typeof node.description !== "string" ||
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
        for (const child of node.children) {
          lines.push("");
          walkNode(child, level + 1);
        }
      };
      walkNode(slide, 1);
      slides.push(lines.join("\n"));
    }

    return slides.length > 0 ? `${slides.join("\n\n---\n\n")}\n` : "";
  }

  /** Load a Markdown slide deck written by toMarkdown. */
  fromMarkdown(markdown: string): void {
    const root: OutlineNode = {
      id: "root",
      title: "Article Outline",
      description: "",
      children: [],
      collapsed: false,
    };
    const stack: Array<{ node: OutlineNode; level: number }> = [];
    let nextId = 1;
    let lastNode: OutlineNode | null = null;

    for (const rawLine of markdown.replace(/\r\n?/g, "\n").split("\n")) {
      const heading = rawLine.match(/^(#{1,6})[ \t]+(.+?)\s*#*\s*$/);
      if (heading) {
        const level = heading[1].length;
        const node: OutlineNode = {
          id: `node-${nextId++}`,
          title: heading[2].trim(),
          description: "",
          children: [],
          collapsed: false,
        };
        while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
        const parent = stack.length ? stack[stack.length - 1].node : root;
        parent.children.push(node);
        stack.push({ node, level });
        lastNode = node;
      } else if (lastNode && rawLine.trim() && rawLine.trim() !== "---") {
        lastNode.description += `${lastNode.description ? "\n" : ""}${rawLine}`;
      }
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

// Direct-manipulation terminal UI using Node.js built-ins.
export class OutlineEditorTUI {
  private outline: Outline = new Outline();
  private filename: string;
  private currentIndex: number = 0;
  private scrollOffset: number = 0;
  private mode: "NORMAL" | "INSERT" | "COMMAND" = "NORMAL";
  private input: string = "";
  private inputCursor: number = 0;
  private editingDescription: boolean = false;
  private command: string = "";
  private commandCursor: number = 0;
  private statusMessage: string = "Ready";
  private statusIsError: boolean = false;
  private modified: boolean = false;
  private closed: boolean = false;
  private showHelpOverlay: boolean = false;
  private pendingSequence: string = "";
  private undoStack: string[] = [];
  private redoStack: string[] = [];

  private readonly onKey = (_: string, key: readline.Key) => this.handleKeypress(key);
  private readonly onResize = () => this.render();
  private readonly onSignal = () => this.quit();

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
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.on("keypress", this.onKey);
    process.stdout.on("resize", this.onResize);

    process.on("SIGINT", this.onSignal);
    process.on("SIGTERM", this.onSignal);

    process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J");
    this.render();

    await new Promise<void>((resolve) => {
      const checkClosed = () => {
        if (this.closed) {
          resolve();
        } else {
          setTimeout(checkClosed, 50);
        }
      };
      checkClosed();
    });
  }

  private get visibleNodes(): OutlineNode[] {
    return this.outline.getVisibleNodes();
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

  private beginEdit(kind: "siblingBelow" | "siblingAbove" | "child" | "title" | "description"): void {
    const current = this.selectedNode;
    this.snapshot();
    this.mode = "INSERT";
    this.editingDescription = kind === "description";

    if (kind === "child") {
      const targetId = current ? current.id : "root";
      const newNode = this.outline.addChild(targetId, "");
      if (current) current.collapsed = false;
      const visible = this.visibleNodes;
      this.currentIndex = visible.findIndex((item) => item.id === newNode.id);
      this.input = "";
      this.inputCursor = 0;
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
    } else {
      if (!current) {
        this.mode = "NORMAL";
        return;
      }
      this.input = this.editingDescription ? current.description : current.title;
      this.inputCursor = this.input.length;
    }
  }

  private finishEdit(): void {
    const node = this.selectedNode;
    if (node) {
      if (this.editingDescription) {
        node.description = this.input;
      } else {
        node.title = this.input.trim() || "Untitled";
      }
      this.modified = true;
    }
    this.mode = "NORMAL";
    this.input = "";
    this.inputCursor = 0;
    this.editingDescription = false;
    this.statusMessage = "Ready";
    this.statusIsError = false;
  }

  private cancelEdit(): void {
    const node = this.selectedNode;
    if (node && !node.title && !this.editingDescription) {
      this.outline.deleteNode(node.id);
      this.clampSelection();
    }
    this.mode = "NORMAL";
    this.input = "";
    this.inputCursor = 0;
    this.editingDescription = false;
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

    if (this.mode === "INSERT") {
      if (key.name === "return") {
        this.finishEdit();
      } else if (key.name === "escape") {
        this.cancelEdit();
      } else if (key.name === "backspace") {
        if (this.inputCursor > 0) {
          this.input = this.input.slice(0, this.inputCursor - 1) + this.input.slice(this.inputCursor);
          this.inputCursor--;
        }
      } else if (key.name === "delete") {
        if (this.inputCursor < this.input.length) {
          this.input = this.input.slice(0, this.inputCursor) + this.input.slice(this.inputCursor + 1);
        }
      } else if (key.name === "left") {
        if (this.inputCursor > 0) this.inputCursor--;
      } else if (key.name === "right") {
        if (this.inputCursor < this.input.length) this.inputCursor++;
      } else if (key.name === "home") {
        this.inputCursor = 0;
      } else if (key.name === "end") {
        this.inputCursor = this.input.length;
      } else if (key.sequence && !key.ctrl && !key.meta) {
        this.input = this.input.slice(0, this.inputCursor) + key.sequence + this.input.slice(this.inputCursor);
        this.inputCursor += key.sequence.length;
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
        this.executeCommand(cmd);
      } else if (key.name === "escape") {
        this.mode = "NORMAL";
        this.command = "";
        this.commandCursor = 0;
      } else if (key.name === "backspace") {
        if (this.commandCursor > 0) {
          this.command = this.command.slice(0, this.commandCursor - 1) + this.command.slice(this.commandCursor);
          this.commandCursor--;
          if (this.command.length === 0) {
            this.mode = "NORMAL";
          }
        }
      } else if (key.name === "left") {
        if (this.commandCursor > 0) this.commandCursor--;
      } else if (key.name === "right") {
        if (this.commandCursor < this.command.length) this.commandCursor++;
      } else if (key.sequence && !key.ctrl && !key.meta) {
        this.command = this.command.slice(0, this.commandCursor) + key.sequence + this.command.slice(this.commandCursor);
        this.commandCursor += key.sequence.length;
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
      switch (key.name || seq) {
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
        case "i":
        case "return":
          this.beginEdit("title");
          break;
        case "E":
          this.beginEdit("description");
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
      const tempPath = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tempPath, this.outline.toMarkdown(), { encoding: "utf8", mode: 0o600 });
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
    const file = targetFile || (/\.json$/i.test(this.filename) ? this.filename.replace(/\.json$/i, ".md") : `${this.filename}.md`);
    try {
      fs.writeFileSync(file, this.outline.toMarkdown(), "utf8");
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

    // Clear and home
    buffer.push("\x1b[H\x1b[2J");

    // Header bar
    const modTag = this.modified ? " \x1b[33m[+Modified]\x1b[0m" : "";
    let modeBadge = "\x1b[42;30m NORMAL \x1b[0m";
    if (this.mode === "INSERT") {
      modeBadge = this.editingDescription ? "\x1b[45;37m EDIT DESC \x1b[0m" : "\x1b[43;30m INSERT \x1b[0m";
    } else if (this.mode === "COMMAND") {
      modeBadge = "\x1b[46;30m COMMAND \x1b[0m";
    }

    const headerLeft = ` \x1b[1mOUTLINE EDITOR\x1b[0m  \x1b[36m${this.filename}\x1b[0m${modTag}`;
    const headerRight = `${modeBadge} `;
    const headerLeftLen = 16 + this.filename.length + (this.modified ? 12 : 0);
    const headerPad = Math.max(1, cols - headerLeftLen - 10);
    buffer.push(`${headerLeft}${" ".repeat(headerPad)}${headerRight}`);
    buffer.push(`\x1b[90m${"─".repeat(cols)}\x1b[0m`);

    // Calculate viewports
    const paneHeight = Math.max(1, rows - 5);
    const leftWidth = Math.max(28, Math.min(Math.floor(cols * 0.55), cols - 24));
    const rightWidth = Math.max(20, cols - leftWidth - 1);

    const visible = this.visibleNodes;
    // Adjust scrollOffset to keep currentIndex within visible viewport
    if (this.currentIndex < this.scrollOffset) {
      this.scrollOffset = this.currentIndex;
    } else if (this.currentIndex >= this.scrollOffset + paneHeight) {
      this.scrollOffset = this.currentIndex - paneHeight + 1;
    }
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, Math.max(0, visible.length - paneHeight)));

    const selected = this.selectedNode;

    // Right pane content lines
    const rightLines: string[] = [];
    if (selected) {
      rightLines.push(`\x1b[1mID:\x1b[0m \x1b[36m${selected.id}\x1b[0m`);
      rightLines.push(`\x1b[1mTitle:\x1b[0m ${selected.title || "(empty)"}`);
      rightLines.push(`\x1b[1mPath:\x1b[0m \x1b[90m${this.getNodePath(selected)}\x1b[0m`);
      rightLines.push(`\x1b[1mChildren:\x1b[0m ${selected.children.length}  \x1b[1mSubtree Depth:\x1b[0m ${this.getSubtreeDepth(selected)}`);
      rightLines.push(`\x1b[90m${"─".repeat(Math.max(2, rightWidth - 2))}\x1b[0m`);
      rightLines.push(`\x1b[1mDescription:\x1b[0m`);
      if (selected.description) {
        const wrapped = this.wrapText(selected.description, rightWidth - 4);
        rightLines.push(...wrapped);
      } else {
        rightLines.push("\x1b[90m(no description - press 'E' to add notes)\x1b[0m");
      }
    } else {
      rightLines.push("\x1b[90m(no node selected)\x1b[0m");
    }

    // Render middle pane rows
    for (let r = 0; r < paneHeight; r++) {
      const nodeIndex = this.scrollOffset + r;
      let leftContent = "";

      if (nodeIndex < visible.length) {
        const node = visible[nodeIndex];
        const isSelected = nodeIndex === this.currentIndex;
        const depth = this.outline.getNodeDepth(node.id);
        const indent = "  ".repeat(Math.max(0, depth - 1));
        const foldIcon = node.children.length > 0 ? (node.collapsed ? "\x1b[33m▶\x1b[0m" : "\x1b[33m▼\x1b[0m") : "\x1b[90m•\x1b[0m";
        const branch = depth > 1 ? "\x1b[90m├─\x1b[0m" : "";

        let displayTitle = node.title || "\x1b[90m(empty)\x1b[0m";
        if (isSelected && this.mode === "INSERT" && !this.editingDescription) {
          displayTitle = `\x1b[4m${this.input}\x1b[0m\x1b[7m \x1b[0m`;
        }

        const maxTitleWidth = leftWidth - (depth * 2) - 6;
        if (node.title.length > maxTitleWidth && maxTitleWidth > 3) {
          displayTitle = `${node.title.slice(0, maxTitleWidth - 3)}...`;
        }

        const rawPrefix = `${isSelected ? "❯ " : "  "}${indent}${depth > 1 ? "├─" : ""}${node.children.length > 0 ? (node.collapsed ? "▶" : "▼") : "•"} `;
        const lineText = `${isSelected ? "\x1b[1;36m❯\x1b[0m " : "  "}${indent}${branch}${foldIcon} ${displayTitle}`;

        const rawLength = rawPrefix.length + (node.title || "(empty)").length;
        const padCount = Math.max(0, leftWidth - rawLength);

        if (isSelected) {
          leftContent = `\x1b[48;5;236m${lineText}${" ".repeat(padCount)}\x1b[0m`;
        } else {
          leftContent = `${lineText}${" ".repeat(padCount)}`;
        }
      } else {
        leftContent = " ".repeat(leftWidth);
      }

      const rightContent = rightLines[r] || "";
      buffer.push(`${leftContent}\x1b[90m│\x1b[0m ${rightContent}`);
    }

    // Divider
    buffer.push(`\x1b[90m${"─".repeat(cols)}\x1b[0m`);

    // Bottom prompt / status
    if (this.mode === "INSERT") {
      const promptLabel = this.editingDescription ? "Edit Description: " : "Edit Title: ";
      buffer.push(`\x1b[33m${promptLabel}\x1b[0m${this.input}\x1b[7m \x1b[0m \x1b[90m[Enter: Confirm | Esc: Cancel]\x1b[0m`);
    } else if (this.mode === "COMMAND") {
      buffer.push(`\x1b[36m${this.command}\x1b[0m\x1b[7m \x1b[0m`);
    } else {
      const statusColor = this.statusIsError ? "\x1b[31m" : "\x1b[32m";
      buffer.push(` ${statusColor}${this.statusMessage}\x1b[0m`);
    }

    // Footer key hints
    buffer.push(
      `\x1b[90m j/k:Move  h/l:Fold  J/K:Reorder  Tab:Indent  Shift+Tab:Promote  o/O/c:New  e:Edit  d:Delete  u:Undo  :w:Save  ?:Help  q:Quit\x1b[0m`
    );

    // Help overlay modal
    if (this.showHelpOverlay) {
      this.renderHelpModal(buffer, cols, rows);
    }

    process.stdout.write(buffer.join("\n"));
  }

  private renderHelpModal(buffer: string[], cols: number, rows: number): void {
    const modalWidth = Math.min(74, cols - 4);
    const modalLines = [
      "╔══════════════════════════════════════════════════════════════════════╗",
      "║                     OUTLINE EDITOR - HELP & KEYMAP                   ║",
      "╠══════════════════════════════════════════════════════════════════════╣",
      "║  NAVIGATION:                                                         ║",
      "║    j / ↓            Move selection down                              ║",
      "║    k / ↑            Move selection up                                ║",
      "║    gg / Home        Jump to top of outline                           ║",
      "║    G / End          Jump to bottom of outline                        ║",
      "║    w / b            Jump to next / previous sibling                  ║",
      "║                                                                      ║",
      "║  FOLDING & STRUCTURE:                                                ║",
      "║    h / l            Collapse / Expand current node                   ║",
      "║    Space            Toggle fold (expand/collapse)                    ║",
      "║    zM / zR          Fold all / Unfold all                            ║",
      "║    J / K            Reorder: swap item down / up among siblings      ║",
      "║    Tab / > / L      Indent: demote node under previous sibling       ║",
      "║    Shift+Tab/< / H  Dedent: promote node to sibling of parent        ║",
      "║                                                                      ║",
      "║  CREATION & EDITING:                                                 ║",
      "║    o / O            Insert sibling below / above (inline edit)       ║",
      "║    c                Insert child under current node (inline edit)    ║",
      "║    e / i / Enter    Edit node title in place                         ║",
      "║    E                Edit node description / notes                    ║",
      "║    d / x / Delete   Delete node and descendants (undo with 'u')      ║",
      "║    u / Ctrl+R       Undo / Redo last structural change or edit       ║",
      "║                                                                      ║",
      "║  FILE & EX COMMANDS:                                                 ║",
      "║    :w / Ctrl+S      Save outline as slide Markdown                  ║",
      "║    :q / q           Quit editor                                      ║",
      "║    :wq              Save and quit                                    ║",
      "║    :e <file>        Load another outline Markdown file              ║",
      "║    :m [file]        Export outline to Markdown format                ║",
      "║    ?                Toggle this help screen                          ║",
      "╚══════════════════════════════════════════════════════════════════════╝",
    ];

    buffer.push("\x1b[H\x1b[2J");
    const topPad = Math.max(0, Math.floor((rows - modalLines.length) / 2));
    for (let i = 0; i < topPad; i++) {
      buffer.push("");
    }
    for (const line of modalLines) {
      const leftPad = Math.max(0, Math.floor((cols - modalWidth) / 2));
      buffer.push(`${" ".repeat(leftPad)}\x1b[1;37m${line}\x1b[0m`);
    }
    buffer.push("");
    const footerText = "Press ? or Escape to return to editor";
    const footerPad = Math.max(0, Math.floor((cols - footerText.length) / 2));
    buffer.push(`${" ".repeat(footerPad)}\x1b[7m ${footerText} \x1b[0m`);
  }

  private wrapText(text: string, maxWidth: number): string[] {
    if (!text || maxWidth <= 0) return [];
    const paragraphs = text.split("\n");
    const result: string[] = [];

    for (const p of paragraphs) {
      if (!p.trim()) {
        result.push("");
        continue;
      }
      const words = p.split(/\s+/);
      let currentLine = "";
      for (const word of words) {
        if ((currentLine.length + word.length + 1) > maxWidth && currentLine) {
          result.push(currentLine);
          currentLine = word;
        } else {
          currentLine += (currentLine ? " " : "") + word;
        }
      }
      if (currentLine) {
        result.push(currentLine);
      }
    }
    return result;
  }

  private getNodePath(node: OutlineNode): string {
    const crumbs: string[] = [];
    let cur: OutlineNode | null = node;
    while (cur && cur.id !== "root") {
      crumbs.unshift(cur.title || "Untitled");
      cur = this.outline.findParent(this.outline.root, cur.id);
    }
    return crumbs.join(" \x1b[90m>\x1b[0m ");
  }

  private getSubtreeDepth(node: OutlineNode): number {
    const walk = (n: OutlineNode): number => {
      if (n.children.length === 0) return 0;
      return 1 + Math.max(...n.children.map(walk));
    };
    return walk(node);
  }

  private quit(): void {
    if (this.closed) return;
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

KEYBOARD SHORTCUTS (Immediate single keystroke, no Enter needed)
  NAVIGATION:
    j / ↓          Move selection down
    k / ↑          Move selection up
    gg / Home      Jump to top of outline
    G / End        Jump to bottom of outline
    w / b          Jump to next / previous sibling

  TREE RESTRUCTURING & REORDERING:
    J / K          Move item down / up (swap positions with sibling)
    Tab / > / L    Indent: demote node under previous sibling
    Shift+Tab/< / H Dedent: promote node to sibling of parent
    h / l          Collapse / expand selected fold
    Space          Toggle fold
    zM / zR        Collapse all / expand all folds

  CREATION & EDITING:
    o / O          Insert sibling below / above with immediate inline editing
    c              Insert child with immediate inline editing
    e / i / Enter  Edit node title in place
    E              Edit node description notes
    d / x / Delete Delete current node and all descendants
    u / Ctrl+R     Undo / Redo last edit or structural change

  FILE & COMMANDS:
    :w / Ctrl+S    Save outline as slide-compatible Markdown
    :q / q         Quit editor
    :wq            Save and quit
    :e <file>      Load another Markdown slide file (JSON is also readable)
    :m [file]      Export outline to Markdown (Ctrl+E)
    ?              Toggle interactive help overlay

FILE FORMAT
  Files are saved as Markdown slides. Top-level outline items become slides and
  are separated by \`---\`; child items become headings within their parent slide:
    # Introduction

    Welcome to the presentation.

    ---

    # Main Content
    ## Section 1

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
