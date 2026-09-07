import * as fs from "fs";
import * as path from "path";
import * as assert from "assert";
import {
  OutlineEditorTUI,
  Outline,
  validateFrontmatterYaml,
  computeMarkdownStyles,
  MD_CAUTION,
  MD_STRUCTURE,
  MD_CODE,
  MD_BOLD,
  MD_DIM,
} from "./outline-editor";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTests() {
  console.log("Starting test suite for Outline Editor...");
  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => void | Promise<void>) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(err);
      failed++;
    }
  }

  const testFile = path.resolve("./test-tmp.md");
  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);

  try {
    // ----------------------------------------------------
    // Test 1: Single-slot clipboard storage
    // ----------------------------------------------------
    await test("Single-slot clipboard stores and overwrites content", () => {
      const editor = new OutlineEditorTUI(testFile);
      assert.strictEqual(editor.getClipboard(), null);

      editor.setClipboard({ text: "first text", isLinewise: false });
      assert.deepStrictEqual(editor.getClipboard(), { text: "first text", isLinewise: false });

      // Overwrite slot
      editor.setClipboard({ text: "second text\n", isLinewise: true });
      assert.deepStrictEqual(editor.getClipboard(), { text: "second text\n", isLinewise: true });
      (editor as any).quit(true);
    });

    // ----------------------------------------------------
    // Test 2: Characterwise Visual Mode (v) and Yank (y)
    // ----------------------------------------------------
    await test("Characterwise visual mode selection and yank in EDIT_NORMAL", () => {
      const editor = new OutlineEditorTUI(testFile);
      // Start editing title on Introduction (index 0)
      editor.dispatchKey({ name: "e" });
      assert.strictEqual(editor.getMode(), "EDIT_NORMAL");
      assert.strictEqual(editor.getEditField(), "title");
      assert.strictEqual(editor.getInput(), "Introduction");

      // Move cursor to index 2 ("t")
      editor.dispatchKey({ name: "0" });
      editor.dispatchKey({ sequence: "l" });
      editor.dispatchKey({ sequence: "l" });
      assert.strictEqual(editor.getInputCursor(), 2);

      // Enter characterwise visual mode
      editor.dispatchKey({ sequence: "v" });
      assert.strictEqual(editor.getMode(), "VISUAL");
      assert.strictEqual(editor.getVisualType(), "char");
      assert.strictEqual(editor.getVisualAnchor(), 2);

      // Move cursor forward with 'e' (to end of word)
      editor.dispatchKey({ sequence: "e" });
      const cur = editor.getInputCursor();
      assert.strictEqual(cur, 11); // end of "Introduction"

      // Yank selection
      editor.dispatchKey({ sequence: "y" });
      assert.strictEqual(editor.getMode(), "EDIT_NORMAL");
      const clip = editor.getClipboard();
      assert.ok(clip);
      assert.strictEqual(clip!.text, "troduction");
      assert.strictEqual(clip!.isLinewise, false);
      (editor as any).quit(true);
    });

    // ----------------------------------------------------
    // Test 3: Visual mode Swap Anchor and Cursor (o)
    // ----------------------------------------------------
    await test("Visual mode swap ends with 'o'", () => {
      const editor = new OutlineEditorTUI(testFile);
      editor.dispatchKey({ name: "e" });
      editor.dispatchKey({ name: "0" }); // cursor at 0
      editor.dispatchKey({ sequence: "v" }); // anchor at 0
      editor.dispatchKey({ sequence: "l" });
      editor.dispatchKey({ sequence: "l" }); // cursor at 2
      assert.strictEqual(editor.getVisualAnchor(), 0);
      assert.strictEqual(editor.getInputCursor(), 2);

      editor.dispatchKey({ sequence: "o" });
      assert.strictEqual(editor.getVisualAnchor(), 2);
      assert.strictEqual(editor.getInputCursor(), 0);
      (editor as any).quit(true);
    });

    // ----------------------------------------------------
    // Test 4: Visual Mode Cut (d/x) and Paste (p) in Title
    // ----------------------------------------------------
    await test("Visual mode cut (d) and paste (p)", () => {
      const editor = new OutlineEditorTUI(testFile);
      editor.dispatchKey({ name: "e" });
      editor.dispatchKey({ name: "0" });
      // Select first 5 chars: "Intro"
      editor.dispatchKey({ sequence: "v" });
      for (let i = 0; i < 4; i++) editor.dispatchKey({ sequence: "l" });
      assert.strictEqual(editor.getInputCursor(), 4);

      // Cut selection
      editor.dispatchKey({ sequence: "d" });
      assert.strictEqual(editor.getMode(), "EDIT_NORMAL");
      assert.strictEqual(editor.getInput(), "duction");
      assert.strictEqual(editor.getClipboard()?.text, "Intro");

      // Paste it back
      editor.dispatchKey({ sequence: "p" });
      assert.strictEqual(editor.getInput(), "dIntrouction");

      // Undo paste
      editor.dispatchKey({ sequence: "u" });
      assert.strictEqual(editor.getInput(), "duction");

      // Undo cut
      editor.dispatchKey({ sequence: "u" });
      assert.strictEqual(editor.getInput(), "Introduction");
      (editor as any).quit(true);
    });

    // ----------------------------------------------------
    // Test 5: Operator yank (yw, yy) in EDIT_NORMAL
    // ----------------------------------------------------
    await test("Operator yanks (yw, yy, Y) in EDIT_NORMAL", () => {
      const editor = new OutlineEditorTUI(testFile);
      editor.dispatchKey({ name: "e" });
      editor.dispatchKey({ name: "0" });

      // yy yanks current line
      editor.dispatchKey({ sequence: "y" });
      editor.dispatchKey({ sequence: "y" });
      assert.deepStrictEqual(editor.getClipboard(), { text: "Introduction\n", isLinewise: true });

      // Y also yanks line
      editor.dispatchKey({ sequence: "Y" });
      assert.deepStrictEqual(editor.getClipboard(), { text: "Introduction\n", isLinewise: true });

      // yw yanks word
      editor.dispatchKey({ sequence: "y" });
      editor.dispatchKey({ sequence: "w" });
      assert.strictEqual(editor.getClipboard()?.text, "Introduction");
      assert.strictEqual(editor.getClipboard()?.isLinewise, false);
      (editor as any).quit(true);
    });

    // ----------------------------------------------------
    // Test 6: Cross-pane copy/paste (Description -> Title -> Notes -> Outline Node)
    // ----------------------------------------------------
    await test("Cross-pane copy/paste across every pane", () => {
      const editor = new OutlineEditorTUI(testFile);
      // 1. Enter Description pane on node 0
      editor.dispatchKey({ sequence: "E" });
      // Type some description:
      editor.dispatchKey({ sequence: "F" });
      editor.dispatchKey({ sequence: "i" });
      editor.dispatchKey({ sequence: "r" });
      editor.dispatchKey({ sequence: "s" });
      editor.dispatchKey({ sequence: "t" });
      editor.dispatchKey({ name: "escape" }); // to EDIT_NORMAL
      assert.strictEqual(editor.getMode(), "EDIT_NORMAL");
      assert.strictEqual(editor.getEditField(), "description");
      assert.strictEqual(editor.getInput(), "First");

      // Select "First" and yank it
      editor.dispatchKey({ name: "0" });
      editor.dispatchKey({ sequence: "v" });
      editor.dispatchKey({ sequence: "e" });
      editor.dispatchKey({ sequence: "y" });
      assert.strictEqual(editor.getClipboard()?.text, "First");

      // 2. Switch to Notes pane with Tab
      editor.dispatchKey({ name: "tab" });
      assert.strictEqual(editor.getEditField(), "notes");
      // Paste clipboard into Notes
      editor.dispatchKey({ sequence: "p" });
      assert.strictEqual(editor.getInput(), "First");

      // 3. Switch to Title pane with Tab
      editor.dispatchKey({ name: "tab" });
      assert.strictEqual(editor.getEditField(), "title");
      // Append paste into title
      editor.dispatchKey({ name: "end" });
      editor.dispatchKey({ sequence: "p" });
      assert.strictEqual(editor.getInput(), "IntroductionFirst");

      // 4. Return to NORMAL mode and paste as new Outline Node
      editor.dispatchKey({ name: "escape" });
      assert.strictEqual(editor.getMode(), "NORMAL");
      editor.dispatchKey({ sequence: "p" }); // paste as sibling below
      const sel = (editor as any).selectedNode;
      assert.strictEqual(sel.title, "First");
      (editor as any).quit(true);
    });

    // ----------------------------------------------------
    // Test 7: NORMAL mode visual selection and yank/paste
    // ----------------------------------------------------
    await test("NORMAL mode v opens title visual selection, yy yanks node title", () => {
      const editor = new OutlineEditorTUI(testFile);
      // On node 0 ("Introduction"), press 'v'
      editor.dispatchKey({ sequence: "v" });
      assert.strictEqual(editor.getMode(), "VISUAL");
      assert.strictEqual(editor.getEditField(), "title");

      // Cancel visual
      editor.dispatchKey({ name: "escape" });
      assert.strictEqual(editor.getMode(), "EDIT_NORMAL");
      editor.dispatchKey({ name: "escape" });
      assert.strictEqual(editor.getMode(), "NORMAL");

      // Test yy in NORMAL mode
      editor.dispatchKey({ sequence: "y" });
      editor.dispatchKey({ sequence: "y" });
      assert.strictEqual(editor.getClipboard()?.text, "Introduction");
      assert.strictEqual(editor.getClipboard()?.isLinewise, true);
      (editor as any).quit(true);
    });

    // ----------------------------------------------------
    // Test 8: Linewise Visual Mode (V) in multiline field
    // ----------------------------------------------------
    await test("Linewise visual mode (V) selects and cuts full lines", () => {
      const editor = new OutlineEditorTUI(testFile);
      (editor as any).selectedNode.description = "Line 1\nLine 2\nLine 3";
      editor.dispatchKey({ sequence: "E" });
      assert.strictEqual(editor.getMode(), "EDIT_NORMAL");
      assert.strictEqual(editor.getEditField(), "description");

      // Move down to Line 2
      editor.dispatchKey({ sequence: "j" });
      editor.dispatchKey({ sequence: "V" });
      assert.strictEqual(editor.getMode(), "VISUAL");
      assert.strictEqual(editor.getVisualType(), "line");

      // Yank line 2
      editor.dispatchKey({ sequence: "y" });
      assert.strictEqual(editor.getMode(), "EDIT_NORMAL");
      assert.strictEqual(editor.getClipboard()?.text, "Line 2\n");
      assert.strictEqual(editor.getClipboard()?.isLinewise, true);
      (editor as any).quit(true);
    });

    // ----------------------------------------------------
    // Test 9: Filesystem Auto-Reload when not modified
    // ----------------------------------------------------
    await test("Auto-reload from disk when !this.modified", async () => {
      const testMd = path.resolve("./auto-reload-test.md");
      fs.writeFileSync(testMd, "# Slide One\n\nContent one\n\n---\n\n# Slide Two\n", "utf8");

      const editor = new OutlineEditorTUI(testMd);
      assert.strictEqual(editor.isModified(), false);
      const initialCount = editor.getOutline().getVisibleNodes().length;
      assert.strictEqual(initialCount, 2);

      // Externally modify file
      await sleep(100);
      fs.writeFileSync(testMd, "# Slide One\n\nContent one\n\n---\n\n# Slide Two\n\n---\n\n# Slide Three\n", "utf8");

      // Wait for debounce and reload
      await sleep(250);

      const newCount = editor.getOutline().getVisibleNodes().length;
      assert.strictEqual(newCount, 3);
      assert.strictEqual(editor.getOutline().getVisibleNodes()[2].title, "Slide Three");

      (editor as any).quit(true);
      if (fs.existsSync(testMd)) fs.unlinkSync(testMd);
    });

    // ----------------------------------------------------
    // Test 10: Save conflict warning when modified on disk
    // ----------------------------------------------------
    await test("Save conflict guard prevents overwrite and force save works", async () => {
      const testMd = path.resolve("./conflict-test.md");
      fs.writeFileSync(testMd, "# Initial Slide\n", "utf8");

      const editor = new OutlineEditorTUI(testMd);
      // Make local modification in editor
      editor.dispatchKey({ name: "e" });
      (editor as any).input = "Locally Modified";
      editor.dispatchKey({ name: "return" });
      assert.strictEqual(editor.isModified(), true);
      assert.strictEqual(editor.getMode(), "NORMAL");

      // Externally modify file on disk
      await sleep(100);
      fs.writeFileSync(testMd, "# External Modification\n", "utf8");
      await sleep(250);

      // Check conflict detected
      assert.strictEqual(editor.isDiskFileModified(), true);

      // Attempt regular save via :w
      editor.dispatchKey({ sequence: ":" });
      for (const ch of "w") editor.dispatchKey({ sequence: ch });
      editor.dispatchKey({ name: "return" });

      // Save should be blocked with conflict message!
      assert.ok(editor.getStatusMessage().includes("Conflict"));
      assert.strictEqual(editor.isModified(), true);
      // File on disk must NOT have been overwritten
      assert.strictEqual(fs.readFileSync(testMd, "utf8"), "# External Modification\n");

      // Force save with :w!
      editor.dispatchKey({ sequence: ":" });
      for (const ch of "w!") editor.dispatchKey({ sequence: ch });
      editor.dispatchKey({ name: "return" });

      // Force save should succeed
      assert.strictEqual(editor.isModified(), false);
      assert.strictEqual(editor.isDiskFileModified(), false);
      assert.ok(editor.getStatusMessage().includes("Saved"));
      assert.ok(fs.readFileSync(testMd, "utf8").includes("Locally Modified"));

      (editor as any).quit(true);
      if (fs.existsSync(testMd)) fs.unlinkSync(testMd);
    });

    // ----------------------------------------------------
    // Test 11: Force reload with :e!
    // ----------------------------------------------------
    await test("Force reload with :e! discards local changes", async () => {
      const testMd = path.resolve("./reload-force-test.md");
      fs.writeFileSync(testMd, "# Disk Version\n", "utf8");

      const editor = new OutlineEditorTUI(testMd);
      editor.dispatchKey({ name: "e" });
      (editor as any).input = "Unsaved Local Version";
      editor.dispatchKey({ name: "return" });
      assert.strictEqual(editor.isModified(), true);
      assert.strictEqual(editor.getMode(), "NORMAL");

      // Regular :e without ! should fail
      editor.dispatchKey({ sequence: ":" });
      for (const ch of "e") editor.dispatchKey({ sequence: ch });
      editor.dispatchKey({ name: "return" });
      assert.ok(editor.getStatusMessage().includes("Unsaved changes"));

      // Force :e! should succeed and reload disk version
      editor.dispatchKey({ sequence: ":" });
      for (const ch of "e!") editor.dispatchKey({ sequence: ch });
      editor.dispatchKey({ name: "return" });
      assert.strictEqual(editor.isModified(), false);
      assert.strictEqual(editor.getOutline().getVisibleNodes()[0].title, "Disk Version");

      (editor as any).quit(true);
      if (fs.existsSync(testMd)) fs.unlinkSync(testMd);
    });

    // ----------------------------------------------------
    // Keys are asserted with the sequences a terminal really sends:
    // readline delivers Tab as "\t" and Right as "\x1b[C", never as the
    // key name, so a dispatcher matched on `sequence || name` looks fine
    // under name-only input and is unreachable from a keyboard.
    // ----------------------------------------------------
    const TAB = { name: "tab", sequence: "\t" };
    const STAB = { name: "tab", sequence: "\x1b[Z", shift: true };
    const RIGHT = { name: "right", sequence: "\x1b[C" };
    const ESC = { name: "escape", sequence: "\x1b" };

    await test("Tab and Shift+Tab cycle panes from real terminal sequences", () => {
      const editor = new OutlineEditorTUI(testFile);
      editor.dispatchKey({ name: "e" });
      assert.strictEqual(editor.getEditField(), "title");

      editor.dispatchKey(TAB);
      assert.strictEqual(editor.getEditField(), "description");
      editor.dispatchKey(TAB);
      assert.strictEqual(editor.getEditField(), "notes");
      editor.dispatchKey(TAB);
      assert.strictEqual(editor.getEditField(), "title");

      editor.dispatchKey(STAB);
      assert.strictEqual(editor.getEditField(), "notes");

      // Tab must reach the pane switch from VISUAL too.
      editor.dispatchKey({ sequence: "v" });
      assert.strictEqual(editor.getMode(), "VISUAL");
      editor.dispatchKey(TAB);
      assert.strictEqual(editor.getEditField(), "title");
      assert.strictEqual(editor.getMode(), "EDIT_NORMAL");
      (editor as any).quit(true);
    });

    await test("Arrow keys move the cursor in EDIT-NAV", () => {
      const editor = new OutlineEditorTUI(testFile);
      editor.dispatchKey({ name: "e" });
      editor.dispatchKey({ sequence: "0" });
      assert.strictEqual(editor.getInputCursor(), 0);
      editor.dispatchKey(RIGHT);
      assert.strictEqual(editor.getInputCursor(), 1);
      (editor as any).quit(true);
    });

    await test("gg extends a visual selection to the start of the field", () => {
      const editor = new OutlineEditorTUI(testFile);
      editor.dispatchKey({ sequence: "E" });
      editor.dispatchKey({ name: "i" });
      for (const ch of "one") editor.dispatchKey({ sequence: ch });
      editor.dispatchKey({ name: "return" });
      for (const ch of "two") editor.dispatchKey({ sequence: ch });
      editor.dispatchKey(ESC);
      assert.strictEqual(editor.getMode(), "EDIT_NORMAL");

      editor.dispatchKey({ sequence: "v" });
      assert.ok(editor.getInputCursor() > 0);
      editor.dispatchKey({ sequence: "g" });
      editor.dispatchKey({ sequence: "g" });
      assert.strictEqual(editor.getInputCursor(), 0);

      // A lone g followed by something else is dropped, not treated as gg.
      editor.dispatchKey({ sequence: "G" });
      const atEnd = editor.getInputCursor();
      editor.dispatchKey({ sequence: "g" });
      editor.dispatchKey({ sequence: "l" });
      assert.strictEqual(editor.getInputCursor(), atEnd);
      (editor as any).quit(true);
    });

    await test("Opening a node for editing without changing it stays clean", () => {
      const editor = new OutlineEditorTUI(testFile);
      assert.strictEqual(editor.isModified(), false);

      editor.dispatchKey({ name: "e" });
      assert.strictEqual(editor.isModified(), false, "opening a title is not an edit");
      editor.dispatchKey(ESC);
      assert.strictEqual(editor.isModified(), false, "e then Esc changed nothing");

      // Folding only touches `collapsed`, which is not persisted.
      editor.dispatchKey({ name: "h" });
      assert.strictEqual(editor.isModified(), false, "folding is not an edit");

      // Actually typing does mark it dirty, and so does an uncommitted buffer.
      editor.dispatchKey({ name: "e" });
      editor.dispatchKey({ name: "i" });
      editor.dispatchKey({ sequence: "X" });
      assert.strictEqual(editor.isModified(), true);
      (editor as any).quit(true);
    });

    await test("Auto-reload keeps the selection on the same node, not the same slot", async () => {
      const md = path.resolve("./test-anchor.md");
      fs.writeFileSync(md, "# Alpha\n\n# Beta\n\n# Gamma\n");
      const editor = new OutlineEditorTUI(md);
      editor.dispatchKey({ name: "j" });
      editor.dispatchKey({ name: "j" });
      assert.strictEqual(editor.getOutline().getVisibleNodes()[editor.getCurrentIndex()].title, "Gamma");

      // A heading inserted above shifts every positional id down by one.
      fs.writeFileSync(md, "# NEW\n\n# Alpha\n\n# Beta\n\n# Gamma\n");
      await sleep(300);

      assert.ok(editor.getStatusMessage().includes("Auto-reloaded"));
      assert.strictEqual(
        editor.getOutline().getVisibleNodes()[editor.getCurrentIndex()].title,
        "Gamma",
        "selection followed the node, not the id"
      );
      (editor as any).quit(true);
      if (fs.existsSync(md)) fs.unlinkSync(md);
    });

    await test("Undo after an auto-reload cannot discard the external change", async () => {
      const md = path.resolve("./test-undo-reload.md");
      fs.writeFileSync(md, "# Alpha\n");
      const editor = new OutlineEditorTUI(md);

      editor.dispatchKey({ sequence: "o" });
      for (const ch of "Mine") editor.dispatchKey({ sequence: ch });
      editor.dispatchKey({ name: "return" });
      (editor as any).saveFile();
      assert.strictEqual(editor.isModified(), false);
      await sleep(120);

      fs.writeFileSync(md, "# Alpha\n\n# Mine\n\n# From Colleague\n");
      await sleep(300);
      const afterReload = editor.getOutline().root.children.map((n: any) => n.title);
      assert.deepStrictEqual(afterReload, ["Alpha", "Mine", "From Colleague"]);

      // The pre-reload snapshots are gone, so u cannot jump the boundary.
      editor.dispatchKey({ sequence: "u" });
      assert.deepStrictEqual(
        editor.getOutline().root.children.map((n: any) => n.title),
        ["Alpha", "Mine", "From Colleague"]
      );
      assert.strictEqual(editor.isModified(), false);
      (editor as any).quit(true);
      if (fs.existsSync(md)) fs.unlinkSync(md);
    });

    await test("A reload arriving mid-edit is deferred, then applied on return to NORMAL", async () => {
      const md = path.resolve("./test-deferred.md");
      fs.writeFileSync(md, "# Alpha\n\n# Beta\n");
      const editor = new OutlineEditorTUI(md);

      editor.dispatchKey({ name: "e" });
      assert.strictEqual(editor.getMode(), "EDIT_NORMAL");

      fs.writeFileSync(md, "# Alpha CHANGED\n\n# Beta\n");
      await sleep(300);

      assert.ok(editor.getStatusMessage().includes("when you leave edit mode"));
      assert.strictEqual(
        editor.getOutline().root.children[0].title,
        "Alpha",
        "the buffer must not be swapped out mid-edit"
      );

      editor.dispatchKey(ESC);
      assert.strictEqual(editor.getMode(), "NORMAL");
      assert.strictEqual(editor.getOutline().root.children[0].title, "Alpha CHANGED");
      assert.strictEqual(editor.isModified(), false);
      (editor as any).quit(true);
      if (fs.existsSync(md)) fs.unlinkSync(md);
    });

    await test("A deferred reload degrades into the conflict guard when the buffer is dirtied", async () => {
      const md = path.resolve("./test-deferred-dirty.md");
      fs.writeFileSync(md, "# Alpha\n");
      const editor = new OutlineEditorTUI(md);

      editor.dispatchKey({ name: "e" });
      fs.writeFileSync(md, "# Disk Version\n");
      await sleep(300);

      // Typing after the deferral means the reload can no longer be applied.
      editor.dispatchKey({ name: "i" });
      for (const ch of "XY") editor.dispatchKey({ sequence: ch });
      editor.dispatchKey(ESC);
      editor.dispatchKey(ESC);

      assert.strictEqual(editor.isDiskFileModified(), true, "must not drop the conflict silently");
      (editor as any).executeCommand(":w");
      assert.ok(editor.getStatusMessage().includes("Conflict"));
      assert.strictEqual(fs.readFileSync(md, "utf8"), "# Disk Version\n", "disk left untouched");
      (editor as any).quit(true);
      if (fs.existsSync(md)) fs.unlinkSync(md);
    });

    await test("Linewise paste into a single-line field appends whole, without a stray space", () => {
      const md = path.resolve("./test-linewise-paste.md");
      fs.writeFileSync(md, "# Hello brave world\n");
      const editor = new OutlineEditorTUI(md);

      editor.dispatchKey({ name: "e" });
      editor.dispatchKey({ sequence: "0" });
      editor.dispatchKey({ sequence: "y" });
      editor.dispatchKey({ sequence: "y" });
      assert.deepStrictEqual(editor.getClipboard(), { text: "Hello brave world\n", isLinewise: true });

      // The cursor sits mid-field, but a linewise register goes to the end.
      editor.dispatchKey({ sequence: "l" });
      editor.dispatchKey({ sequence: "p" });
      assert.strictEqual(editor.getInput(), "Hello brave world Hello brave world");

      // P puts it at the head instead.
      const editor2 = new OutlineEditorTUI(md);
      editor2.dispatchKey({ name: "e" });
      editor2.setClipboard({ text: "Prefix\n", isLinewise: true });
      editor2.dispatchKey({ sequence: "P" });
      assert.strictEqual(editor2.getInput(), "Prefix Hello brave world");
      (editor as any).quit(true);
      (editor2 as any).quit(true);
      if (fs.existsSync(md)) fs.unlinkSync(md);
    });

    await test("v on an empty outline does not enter VISUAL", () => {
      const md = path.resolve("./test-empty.md");
      fs.writeFileSync(md, "# Only\n");
      const editor = new OutlineEditorTUI(md);

      editor.dispatchKey({ sequence: "d" });
      assert.strictEqual(editor.getOutline().getVisibleNodes().length, 0);

      editor.dispatchKey({ sequence: "v" });
      assert.strictEqual(editor.getMode(), "NORMAL");
      editor.dispatchKey({ sequence: "V" });
      assert.strictEqual(editor.getMode(), "NORMAL");
      (editor as any).quit(true);
      if (fs.existsSync(md)) fs.unlinkSync(md);
    });

    await test("Help overlay scrolls and closes on ?", () => {
      const editor = new OutlineEditorTUI(testFile);
      const anyEd = editor as any;

      editor.dispatchKey({ sequence: "?" });
      assert.strictEqual(anyEd.showHelpOverlay, true);
      assert.strictEqual(anyEd.helpScroll, 0);

      editor.dispatchKey({ sequence: "j" });
      editor.dispatchKey({ sequence: "j" });
      assert.strictEqual(anyEd.helpScroll, 2, "j scrolls the overlay, not the outline");
      assert.strictEqual(editor.getCurrentIndex(), 0, "keys must not leak to the tree");

      editor.dispatchKey({ sequence: "k" });
      assert.strictEqual(anyEd.helpScroll, 1);

      // Scrolling is clamped to the content, not left unbounded.
      editor.dispatchKey({ sequence: "G" });
      const bottom = anyEd.helpScroll;
      assert.ok(bottom > 0 && bottom < 1000);
      editor.dispatchKey({ sequence: "j" });
      assert.strictEqual(anyEd.helpScroll, bottom, "cannot scroll past the end");

      // `?` arrives as a sequence with no key name, so it has to match on that.
      editor.dispatchKey({ sequence: "?" });
      assert.strictEqual(anyEd.showHelpOverlay, false);
      assert.strictEqual(anyEd.helpScroll, 0);
      (editor as any).quit(true);
    });

    await test("External deletion is reported even over a clean buffer", async () => {
      const md = path.resolve("./test-deleted.md");
      fs.writeFileSync(md, "# Alpha\n");
      const editor = new OutlineEditorTUI(md);
      assert.strictEqual(editor.isModified(), false);

      fs.unlinkSync(md);
      await sleep(300);
      assert.ok(editor.getStatusMessage().includes("deleted externally"));
      (editor as any).quit(true);
      if (fs.existsSync(md)) fs.unlinkSync(md);
    });

    await test("cloneTree and restoreTree maintain tree integrity and undo/redo works", () => {
      const outline = new Outline();
      const child1 = outline.addChild("root", "Item 1");
      outline.addChild(child1.id, "Subitem 1");
      const clone = outline.cloneTree();

      // Mutate original
      outline.addChild("root", "Item 2");
      assert.strictEqual(outline.root.children.length, 2);
      assert.strictEqual(clone.children.length, 1);

      // Restore
      outline.restoreTree(clone);
      assert.strictEqual(outline.root.children.length, 1);
      assert.strictEqual(outline.root.children[0].title, "Item 1");
      assert.strictEqual(outline.root.children[0].children[0].title, "Subitem 1");

      // Verify ID generation after restore doesn't collide
      const added = outline.addChild("root", "Item New");
      assert.strictEqual(added.id, "node-3");

      // Test structural undo/redo in editor
      const editor = new OutlineEditorTUI(testFile);
      const initialTitles = editor.getOutline().root.children.map((n: any) => n.title);
      editor.dispatchKey({ sequence: "o" });
      for (const ch of "Created") editor.dispatchKey({ sequence: ch });
      editor.dispatchKey({ name: "return" });
      assert.strictEqual(editor.getOutline().root.children.length, initialTitles.length + 1);

      editor.dispatchKey({ sequence: "u" });
      assert.deepStrictEqual(editor.getOutline().root.children.map((n: any) => n.title), initialTitles);

      editor.dispatchKey({ name: "r", ctrl: true });
      assert.strictEqual(editor.getOutline().root.children.length, initialTitles.length + 1);
      (editor as any).quit(true);
    });

    // ----------------------------------------------------
    // Fence-aware fromMarkdown parsing
    // ----------------------------------------------------
    await test("fromMarkdown treats fenced code block content as inert", () => {
      const md = [
        "# Slide One",
        "",
        "Intro text.",
        "",
        "```yaml",
        "# a YAML comment, not a heading",
        "---",
        "::: notes",
        "still just code",
        ":::",
        "```",
        "",
        "After the fence.",
      ].join("\n");

      const outline = new Outline();
      outline.fromMarkdown(md);

      assert.strictEqual(outline.root.children.length, 1);
      const slide = outline.root.children[0];
      assert.strictEqual(slide.title, "Slide One");
      assert.strictEqual(slide.children.length, 0);
      assert.strictEqual(slide.notes, "");
      assert.ok(slide.description.includes("# a YAML comment, not a heading"));
      assert.ok(slide.description.includes("---"));
      assert.ok(slide.description.includes("::: notes"));
      assert.ok(slide.description.includes("still just code"));
      assert.ok(slide.description.includes(":::"));
      assert.ok(slide.description.includes("After the fence."));
    });

    await test("fromMarkdown(toMarkdown()) round-trips fenced content verbatim", () => {
      const outline = new Outline();
      const slide = outline.addChild("root", "Fenced");
      slide.description = [
        "```js",
        "# not a heading",
        "---",
        "```",
        "",
        "Trailing paragraph.",
      ].join("\n");

      const reloaded = new Outline();
      reloaded.fromMarkdown(outline.toMarkdown());
      assert.strictEqual(reloaded.root.children.length, 1);
      assert.strictEqual(reloaded.root.children[0].description, slide.description);
    });

    // ----------------------------------------------------
    // Markdown syntax highlighting (computeMarkdownStyles)
    // ----------------------------------------------------
    await test("computeMarkdownStyles flags structural risk lines in description only", () => {
      const lines = ["# Looks like a heading", "---", "Plain text"];
      const descStyles = computeMarkdownStyles(lines, true);
      assert.ok(descStyles[0].every((s) => s === MD_CAUTION));
      assert.ok(descStyles[1].every((s) => s === MD_CAUTION));
      assert.ok(descStyles[2].every((s) => s === ""));

      const notesStyles = computeMarkdownStyles(lines, false);
      assert.ok(notesStyles[0].every((s) => s === ""));
      assert.ok(notesStyles[1].every((s) => s === ""));
    });

    await test("computeMarkdownStyles leaves fenced content unstyled but flags its delimiters", () => {
      const lines = ["```js", "# not a heading in here", "---", "```"];
      const styles = computeMarkdownStyles(lines, true);
      assert.ok(styles[0].every((s) => s === MD_STRUCTURE));
      assert.ok(styles[1].every((s) => s === ""));
      assert.ok(styles[2].every((s) => s === ""));
      assert.ok(styles[3].every((s) => s === MD_STRUCTURE));
    });

    await test("computeMarkdownStyles highlights inline code and bold spans", () => {
      const line = "Some `code` and **bold** text.";
      const [styles] = computeMarkdownStyles([line], true);
      const codeStart = line.indexOf("code");
      const boldStart = line.indexOf("bold");
      assert.strictEqual(styles[codeStart], MD_CODE);
      assert.strictEqual(styles[boldStart], MD_BOLD);
      assert.strictEqual(styles[line.indexOf("`")], MD_DIM);
      assert.strictEqual(styles[line.indexOf("Some")], "");
    });

    await test("computeMarkdownStyles never changes the character count of a line", () => {
      const lines = [
        "# heading",
        "```",
        "fenced",
        "```",
        "**bold** `code` [link](url) | a | table |",
      ];
      for (const track of [true, false]) {
        const styles = computeMarkdownStyles(lines, track);
        for (let i = 0; i < lines.length; i++) {
          assert.strictEqual(styles[i].length, lines[i].length);
        }
      }
    });

    // ----------------------------------------------------
    // :!cmd shell escape
    // ----------------------------------------------------
    await test(":!cmd suspends into SHELL mode and resumes with the exit status", () => {
      const editor = new OutlineEditorTUI(testFile);

      editor.dispatchKey({ sequence: ":" });
      for (const ch of "!true") editor.dispatchKey({ sequence: ch });
      editor.dispatchKey({ name: "return" });
      assert.strictEqual(editor.getMode(), "SHELL");

      editor.dispatchKey({ name: "return" });
      assert.strictEqual(editor.getMode(), "NORMAL");
      assert.strictEqual(editor.getStatusMessage(), "Ran: true (exit 0)");

      editor.dispatchKey({ sequence: ":" });
      for (const ch of "!false") editor.dispatchKey({ sequence: ch });
      editor.dispatchKey({ name: "return" });
      assert.strictEqual(editor.getMode(), "SHELL");

      editor.dispatchKey({ sequence: "x" });
      assert.strictEqual(editor.getMode(), "NORMAL");
      assert.ok(editor.getStatusMessage().includes("exit 1"));

      (editor as any).quit(true);
    });

    // ----------------------------------------------------
    // Frontmatter Metadata
    // ----------------------------------------------------
    await test("Frontmatter parses supported fields and preserves unknown lines", () => {
      const markdown = [
        "---",
        "title: 'Scalable Systems'",
        'subtitle: "Architecture and Design"',
        "author: Jane Doe",
        "organization: Acme Corp",
        "event: TechConf 2026",
        "date: 2026-09-07",
        "theme: solarized",
        "aspectratio: 169",
        "---",
        "",
        "# First Slide",
        "Slide content",
      ].join("\n");

      const outline = new Outline();
      outline.fromMarkdown(markdown);
      assert.strictEqual(outline.metadata.title, "Scalable Systems");
      assert.strictEqual(outline.metadata.subtitle, "Architecture and Design");
      assert.strictEqual(outline.metadata.author, "Jane Doe");
      assert.strictEqual(outline.metadata.institute, "Acme Corp"); // parsed from organization
      assert.strictEqual(outline.metadata.date, "2026-09-07");
      assert.deepStrictEqual(outline.metadata.extraLines, ["event: TechConf 2026", "theme: solarized", "aspectratio: 169"]);

      const serialized = outline.toMarkdown();
      assert.ok(serialized.includes("title: Scalable Systems"));
      assert.ok(serialized.includes("subtitle: Architecture and Design"));
      assert.ok(serialized.includes("author: Jane Doe"));
      assert.ok(serialized.includes("institute: Acme Corp"));
      assert.ok(serialized.includes("event: TechConf 2026"));
      assert.ok(serialized.includes("theme: solarized"));
      assert.ok(serialized.includes("aspectratio: 169"));
      assert.ok(serialized.includes("# First Slide"));
    });

    await test("Navigation: k from top slide selects Frontmatter, j returns to top slide", () => {
      const editor = new OutlineEditorTUI(testFile);
      assert.strictEqual(editor.isOnFrontmatter(), false);
      assert.strictEqual(editor.isOnTitleSlide(), false);
      assert.strictEqual(editor.getCurrentIndex(), 0);

      // k from index 0 moves up to Frontmatter
      editor.dispatchKey({ sequence: "k" });
      assert.strictEqual(editor.isOnFrontmatter(), true);
      assert.strictEqual(editor.isOnTitleSlide(), true);

      // j moves back down to index 0
      editor.dispatchKey({ sequence: "j" });
      assert.strictEqual(editor.isOnFrontmatter(), false);
      assert.strictEqual(editor.isOnTitleSlide(), false);
      assert.strictEqual(editor.getCurrentIndex(), 0);

      // gg jumps directly to Frontmatter
      editor.dispatchKey({ sequence: "g" });
      editor.dispatchKey({ sequence: "g" });
      assert.strictEqual(editor.isOnFrontmatter(), true);
      assert.strictEqual(editor.isOnTitleSlide(), true);

      // G jumps to bottom slide
      editor.dispatchKey({ sequence: "G" });
      assert.strictEqual(editor.isOnFrontmatter(), false);
      assert.strictEqual(editor.isOnTitleSlide(), false);
      assert.strictEqual(editor.getCurrentIndex(), editor.getOutline().getVisibleNodes().length - 1);

      (editor as any).quit(true);
    });

    await test("Initial load with frontmatter selects Frontmatter", () => {
      const fmFile = path.resolve("./test-frontmatter.md");
      fs.writeFileSync(fmFile, "---\ntitle: Deck Title\nauthor: Alice\n---\n\n# Slide 1\n");
      const editor = new OutlineEditorTUI(fmFile);
      assert.strictEqual(editor.isOnFrontmatter(), true);
      assert.strictEqual(editor.isOnTitleSlide(), true);
      assert.strictEqual(editor.getMetadata().title, "Deck Title");
      assert.strictEqual(editor.getMetadata().author, "Alice");
      (editor as any).quit(true);
    });

    await test("Editing frontmatter fields and cycling with Tab / Shift+Tab", () => {
      const editor = new OutlineEditorTUI(testFile);
      // Jump to Frontmatter
      editor.dispatchKey({ sequence: "g" });
      editor.dispatchKey({ sequence: "g" });
      assert.strictEqual(editor.isOnFrontmatter(), true);

      // Begin edit on title with 'e'
      editor.dispatchKey({ sequence: "e" });
      assert.strictEqual(editor.getMode(), "EDIT_NORMAL");
      assert.strictEqual(editor.getEditField(), "title");

      // Enter insert mode and type title
      editor.dispatchKey({ sequence: "i" });
      assert.strictEqual(editor.getMode(), "INSERT");
      for (const ch of "Keynote Talk") editor.dispatchKey({ sequence: ch });
      editor.dispatchKey({ name: "escape" });
      assert.strictEqual(editor.getMode(), "EDIT_NORMAL");

      // Press Tab to cycle to subtitle
      editor.dispatchKey({ name: "tab" });
      assert.strictEqual(editor.getEditField(), "subtitle");
      editor.dispatchKey({ sequence: "i" });
      for (const ch of "Future of Systems") editor.dispatchKey({ sequence: ch });
      editor.dispatchKey({ name: "escape" });

      // Press Tab to cycle to author
      editor.dispatchKey({ name: "tab" });
      assert.strictEqual(editor.getEditField(), "author");
      editor.dispatchKey({ sequence: "i" });
      for (const ch of "Bob Smith") editor.dispatchKey({ sequence: ch });
      editor.dispatchKey({ name: "escape" });

      // Press Tab to cycle to institute
      editor.dispatchKey({ name: "tab" });
      assert.strictEqual(editor.getEditField(), "institute");

      // Press Tab to cycle to date
      editor.dispatchKey({ name: "tab" });
      assert.strictEqual(editor.getEditField(), "date");

      // Press Tab to cycle back to title
      editor.dispatchKey({ name: "tab" });
      assert.strictEqual(editor.getEditField(), "title");
      assert.strictEqual(editor.getInput(), "Keynote Talk");

      // Press Shift+Tab to cycle backward to date
      editor.dispatchKey({ name: "tab", shift: true });
      assert.strictEqual(editor.getEditField(), "date");

      // Press Enter to confirm and return to NORMAL
      editor.dispatchKey({ name: "return" });
      assert.strictEqual(editor.getMode(), "NORMAL");
      assert.strictEqual(editor.getMetadata().title, "Keynote Talk");
      assert.strictEqual(editor.getMetadata().subtitle, "Future of Systems");
      assert.strictEqual(editor.getMetadata().author, "Bob Smith");
      assert.strictEqual(editor.isModified(), true);

      (editor as any).quit(true);
    });

    await test("Vim j/k and down/up navigation between frontmatter fields", () => {
      const editor = new OutlineEditorTUI(testFile);
      editor.dispatchKey({ sequence: "g" });
      editor.dispatchKey({ sequence: "g" });
      assert.strictEqual(editor.isOnFrontmatter(), true);

      // Begin edit on title with 'e'
      editor.dispatchKey({ sequence: "e" });
      assert.strictEqual(editor.getMode(), "EDIT_NORMAL");
      assert.strictEqual(editor.getEditField(), "title");

      // j moves to subtitle
      editor.dispatchKey({ sequence: "j" });
      assert.strictEqual(editor.getEditField(), "subtitle");

      // j moves to author
      editor.dispatchKey({ sequence: "j" });
      assert.strictEqual(editor.getEditField(), "author");

      // down moves to institute
      editor.dispatchKey({ name: "down" });
      assert.strictEqual(editor.getEditField(), "institute");

      // down moves to date
      editor.dispatchKey({ name: "down" });
      assert.strictEqual(editor.getEditField(), "date");

      // j at bottom field stays on date
      editor.dispatchKey({ sequence: "j" });
      assert.strictEqual(editor.getEditField(), "date");

      // k moves up to date
      editor.dispatchKey({ sequence: "k" });
      assert.strictEqual(editor.getEditField(), "date");

      // up moves up to institute
      editor.dispatchKey({ name: "up" });
      assert.strictEqual(editor.getEditField(), "institute");

      // k moves up to author
      editor.dispatchKey({ sequence: "k" });
      assert.strictEqual(editor.getEditField(), "author");

      // k moves up to subtitle
      editor.dispatchKey({ sequence: "k" });
      assert.strictEqual(editor.getEditField(), "subtitle");

      // k moves up to title
      editor.dispatchKey({ sequence: "k" });
      assert.strictEqual(editor.getEditField(), "title");

      // k at top field stays on title
      editor.dispatchKey({ sequence: "k" });
      assert.strictEqual(editor.getEditField(), "title");

      // G jumps to date
      editor.dispatchKey({ sequence: "G" });
      assert.strictEqual(editor.getEditField(), "date");

      // gg jumps to title
      editor.dispatchKey({ sequence: "g" });
      editor.dispatchKey({ sequence: "g" });
      assert.strictEqual(editor.getEditField(), "title");

      (editor as any).quit(true);
    });

    await test("Enter on frontmatter item moves to following item and enters edit mode", () => {
      const editor = new OutlineEditorTUI(testFile);
      editor.dispatchKey({ sequence: "g" });
      editor.dispatchKey({ sequence: "g" });
      assert.strictEqual(editor.isOnFrontmatter(), true);

      // Start editing title in INSERT mode with 'i'
      editor.dispatchKey({ sequence: "i" });
      assert.strictEqual(editor.getMode(), "INSERT");
      assert.strictEqual(editor.getEditField(), "title");
      for (const ch of "Slide Deck Title") editor.dispatchKey({ sequence: ch });

      // Enter moves to subtitle and enters INSERT mode
      editor.dispatchKey({ name: "return" });
      assert.strictEqual(editor.getMode(), "INSERT");
      assert.strictEqual(editor.getEditField(), "subtitle");
      assert.strictEqual(editor.getMetadata().title, "Slide Deck Title");
      for (const ch of "Architecture Overview") editor.dispatchKey({ sequence: ch });

      // Enter moves to author and enters INSERT mode
      editor.dispatchKey({ name: "return" });
      assert.strictEqual(editor.getMode(), "INSERT");
      assert.strictEqual(editor.getEditField(), "author");
      assert.strictEqual(editor.getMetadata().subtitle, "Architecture Overview");
      for (const ch of "Alice Engineer") editor.dispatchKey({ sequence: ch });

      // Enter moves to institute and enters INSERT mode
      editor.dispatchKey({ name: "return" });
      assert.strictEqual(editor.getMode(), "INSERT");
      assert.strictEqual(editor.getEditField(), "institute");
      assert.strictEqual(editor.getMetadata().author, "Alice Engineer");
      for (const ch of "Tech Org") editor.dispatchKey({ sequence: ch });

      // Enter moves to date and enters INSERT mode
      editor.dispatchKey({ name: "return" });
      assert.strictEqual(editor.getMode(), "INSERT");
      assert.strictEqual(editor.getEditField(), "date");
      assert.strictEqual(editor.getMetadata().institute, "Tech Org");
      for (const ch of "2026-09-07") editor.dispatchKey({ sequence: ch });

      // Enter on final field (date) confirms and returns to NORMAL mode
      editor.dispatchKey({ name: "return" });
      assert.strictEqual(editor.getMode(), "NORMAL");
      assert.strictEqual(editor.isModified(), true);

      // Verify Enter from EDIT_NORMAL mode also moves to following item in edit mode
      editor.dispatchKey({ sequence: "e" });
      assert.strictEqual(editor.getMode(), "EDIT_NORMAL");
      assert.strictEqual(editor.getEditField(), "title");

      editor.dispatchKey({ name: "return" });
      assert.strictEqual(editor.getMode(), "INSERT");
      assert.strictEqual(editor.getEditField(), "subtitle");

      editor.dispatchKey({ name: "escape" });
      assert.strictEqual(editor.getMode(), "EDIT_NORMAL");
      assert.strictEqual(editor.getEditField(), "subtitle");

      editor.dispatchKey({ name: "return" });
      assert.strictEqual(editor.getMode(), "INSERT");
      assert.strictEqual(editor.getEditField(), "author");

      (editor as any).quit(true);
    });

    await test("Frontmatter: Ctrl+W pane navigation between title and subtitle", () => {
      const editor = new OutlineEditorTUI(testFile);
      editor.dispatchKey({ sequence: "g" });
      editor.dispatchKey({ sequence: "g" });
      editor.dispatchKey({ sequence: "e" });
      assert.strictEqual(editor.getEditField(), "title");

      // Ctrl+W then l moves to subtitle
      editor.dispatchKey({ ctrl: true, name: "w" });
      editor.dispatchKey({ sequence: "l" });
      assert.strictEqual(editor.getEditField(), "subtitle");

      // Ctrl+W then h moves back to title
      editor.dispatchKey({ ctrl: true, name: "w" });
      editor.dispatchKey({ sequence: "h" });
      assert.strictEqual(editor.getEditField(), "title");

      // Ctrl+W then j moves to next field (subtitle)
      editor.dispatchKey({ ctrl: true, name: "w" });
      editor.dispatchKey({ sequence: "j" });
      assert.strictEqual(editor.getEditField(), "subtitle");

      // Ctrl+W then k moves back to previous field (title)
      editor.dispatchKey({ ctrl: true, name: "w" });
      editor.dispatchKey({ sequence: "k" });
      assert.strictEqual(editor.getEditField(), "title");

      (editor as any).quit(true);
    });

    await test("Frontmatter: 'd' clears metadata and 'u' restores it via undo", () => {
      const fmFile = path.resolve("./test-title-slide.md");
      fs.writeFileSync(fmFile, "---\ntitle: Deck Title\nauthor: Alice\nconference: Conf 2026\n---\n\n# Slide 1\n");
      const editor = new OutlineEditorTUI(fmFile);
      assert.strictEqual(editor.isOnFrontmatter(), true);
      assert.strictEqual(editor.getMetadata().title, "Deck Title");
      assert.strictEqual(editor.getMetadata().author, "Alice");

      // 'd' on Frontmatter clears metadata
      editor.dispatchKey({ sequence: "d" });
      assert.strictEqual(editor.getMetadata().title, "");
      assert.strictEqual(editor.getMetadata().author, "");
      assert.strictEqual(editor.getOutline().hasMetadata(), false);

      // 'u' restores it
      editor.dispatchKey({ sequence: "u" });
      assert.strictEqual(editor.getMetadata().title, "Deck Title");
      assert.strictEqual(editor.getMetadata().author, "Alice");
      assert.deepStrictEqual(editor.getMetadata().extraLines, ["conference: Conf 2026"]);
      assert.strictEqual(editor.getOutline().hasMetadata(), true);

      (editor as any).quit(true);
    });

    await test("Frontmatter: 'yy' yanks title, 'p' pastes new slide directly below Frontmatter", () => {
      const fmFile = path.resolve("./test-title-slide.md");
      fs.writeFileSync(fmFile, "---\ntitle: Presentation Title\n---\n\n# Slide 1\n\n# Slide 2\n");
      const editor = new OutlineEditorTUI(fmFile);
      assert.strictEqual(editor.isOnFrontmatter(), true);

      // Yank title
      editor.dispatchKey({ sequence: "y" });
      editor.dispatchKey({ sequence: "y" });
      const clip = editor.getClipboard();
      assert.ok(clip);
      assert.strictEqual(clip!.text, "Presentation Title");
      assert.strictEqual(clip!.isLinewise, true);

      // Paste below frontmatter: creates new slide at index 0
      editor.dispatchKey({ sequence: "p" });
      assert.strictEqual(editor.isOnFrontmatter(), false);
      assert.strictEqual(editor.getCurrentIndex(), 0);
      assert.strictEqual(editor.getOutline().getVisibleNodes()[0].title, "Presentation Title");
      assert.strictEqual(editor.getOutline().getVisibleNodes()[1].title, "Slide 1");

      (editor as any).quit(true);
    });

    await test("External reload preserves Frontmatter selection", async () => {
      const reloadFile = path.resolve("./test-title-slide.md");
      fs.writeFileSync(reloadFile, "---\ntitle: Deck Title\n---\n\n# Slide 1\n");
      const editor = new OutlineEditorTUI(reloadFile);
      assert.strictEqual(editor.isOnFrontmatter(), true);

      // Trigger external modification
      fs.writeFileSync(reloadFile, "---\ntitle: Deck Title Updated\nauthor: Bob\n---\n\n# Slide 1\n# Slide 2\n");
      await sleep(150);

      assert.strictEqual(editor.isOnFrontmatter(), true);
      assert.strictEqual(editor.getMetadata().title, "Deck Title Updated");
      assert.strictEqual(editor.getMetadata().author, "Bob");

      (editor as any).quit(true);
    });

    await test("Frontmatter fallback title in UI is '(Frontmatter)'", () => {
      const editor = new OutlineEditorTUI(testFile);
      editor.dispatchKey({ sequence: "g" });
      editor.dispatchKey({ sequence: "g" });
      assert.strictEqual(editor.isOnFrontmatter(), true);
      assert.strictEqual((editor as any).titleSlideNode.title, "Frontmatter");
      (editor as any).quit(true);
    });

    await test("validateFrontmatterYaml comprehensive syntax rules", () => {
      // Valid YAML cases
      assert.strictEqual(validateFrontmatterYaml("").valid, true);
      assert.strictEqual(validateFrontmatterYaml("title: Hello World\nauthor: Alice").valid, true);
      assert.strictEqual(validateFrontmatterYaml('title: "Double \\"Quote\\""').valid, true);
      assert.strictEqual(validateFrontmatterYaml("title: 'Single ''Quote'''").valid, true);
      assert.strictEqual(validateFrontmatterYaml("items:\n  - one\n  - two").valid, true);
      assert.strictEqual(validateFrontmatterYaml("flow: [a, b, c]").valid, true);
      assert.strictEqual(validateFrontmatterYaml("desc: |\n  Line 1\n  Line 2").valid, true);
      assert.strictEqual(validateFrontmatterYaml("# comment\ntitle: test # inline comment").valid, true);

      // Invalid: Unterminated double quote
      const r1 = validateFrontmatterYaml('title: "unterminated');
      assert.strictEqual(r1.valid, false);
      assert.ok(r1.error?.includes("unterminated double quote"));

      // Invalid: Unterminated single quote
      const r2 = validateFrontmatterYaml("title: 'unterminated");
      assert.strictEqual(r2.valid, false);
      assert.ok(r2.error?.includes("unterminated single quote"));

      // Invalid: Tabs in indentation
      const r3 = validateFrontmatterYaml("\ttitle: test");
      assert.strictEqual(r3.valid, false);
      assert.ok(r3.error?.includes("tabs are not allowed for indentation"));

      // Invalid: Missing colon in mapping
      const r4 = validateFrontmatterYaml("invalid mapping line without colon");
      assert.strictEqual(r4.valid, false);
      assert.ok(r4.error?.includes("missing ':' in mapping"));

      // Invalid: Unquoted value containing ': '
      const r5 = validateFrontmatterYaml("title: unquoted: bad");
      assert.strictEqual(r5.valid, false);
      assert.ok(r5.error?.includes("unquoted value containing ': '"));

      // Invalid: Unclosed flow bracket
      const r6 = validateFrontmatterYaml("tags: [a, b, c");
      assert.strictEqual(r6.valid, false);
      assert.ok(r6.error?.includes("unclosed '['"));
    });

    await test("Frontmatter fields render with soft-wrapping and vertical navigation across wrapped rows", () => {
      const longTitle = "A Very Long Presentation Title That Exceeds The Width Of The Terminal Pane And Should Wrap Gracefully";
      const longSubtitle = "Subtitle describing advanced systems architecture with multiple lines of important technical details";
      const fmContent = `---\ntitle: ${longTitle}\nsubtitle: ${longSubtitle}\nauthor: Dr. Researcher\n---\n\n# Slide 1\n`;
      const fmFile = path.resolve("./test-frontmatter-wrap.md");
      fs.writeFileSync(fmFile, fmContent);

      try {
        const editor = new OutlineEditorTUI(fmFile);
        assert.strictEqual(editor.isOnFrontmatter(), true);
        assert.strictEqual(editor.getMetadata().title, longTitle);
        assert.strictEqual(editor.getMetadata().subtitle, longSubtitle);

        // Render frontmatter fields: verify rendered lines wrap with continuation indent
        const rendered = (editor as any).renderFrontmatterFields(40, 25);
        assert.ok(rendered.length > 8, "Rendered output should have wrapped lines");
        // Check that title wraps and continuation lines start with "    "
        const titleContLines = rendered.filter((line: string) => line.startsWith("    "));
        assert.ok(titleContLines.length >= 2, "Should have continuation lines with 4-space indent");

        // Begin edit on title with 'e'
        editor.dispatchKey({ sequence: "e" });
        assert.strictEqual(editor.getMode(), "EDIT_NORMAL");
        assert.strictEqual(editor.getEditField(), "title");
        // Single line titles open at end of line; press '0' to move to start of title
        editor.dispatchKey({ sequence: "0" });
        assert.strictEqual(editor.getInputCursor(), 0);

        // Long title wraps across multiple visual rows. Moving 'j' moves to next wrapped row in title
        editor.dispatchKey({ sequence: "j" });
        assert.strictEqual(editor.getEditField(), "title");
        assert.ok(editor.getInputCursor() > 0, "j should advance cursor within long wrapped title");

        const curRow2 = editor.getInputCursor();
        editor.dispatchKey({ sequence: "j" });
        assert.strictEqual(editor.getEditField(), "title");
        assert.ok(editor.getInputCursor() > curRow2, "j should advance cursor further within long wrapped title");

        // Move up with 'k'
        editor.dispatchKey({ sequence: "k" });
        assert.strictEqual(editor.getEditField(), "title");
        assert.strictEqual(editor.getInputCursor(), curRow2, "k should move cursor back to previous wrapped row");

        // Move back to row 0
        editor.dispatchKey({ sequence: "k" });
        assert.strictEqual(editor.getInputCursor(), 0);

        // Move down all the way through title wrapped rows until subtitle
        while (editor.getEditField() === "title") {
          editor.dispatchKey({ sequence: "j" });
        }
        assert.strictEqual(editor.getEditField(), "subtitle");

        (editor as any).quit(true);
      } finally {
        if (fs.existsSync(fmFile)) fs.unlinkSync(fmFile);
      }
    });

  } finally {
    // A test that throws skips its own unlink, so sweep them all here rather
    // than leaving scratch files behind in the working directory.
    for (const name of [
      testFile,
      "./test-title-slide.md",
      "./test-frontmatter.md",
      "./test-anchor.md",
      "./test-undo-reload.md",
      "./test-deferred.md",
      "./test-deferred-dirty.md",
      "./test-linewise-paste.md",
      "./test-empty.md",
      "./test-deleted.md",
    ]) {
      const resolved = path.resolve(name);
      if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
    }
  }

  console.log(`\nTest results: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
