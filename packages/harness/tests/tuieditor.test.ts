/**
 * Pure editor suite: grapheme-safe editing and navigation, multiline paste,
 * bounded history and submission actions. No terminal or I/O is involved.
 *
 * Run with: node --test tests/tuieditor.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clearEditor,
  codeUnitOffset,
  createEditor,
  cursorPosition,
  deleteBackward,
  deleteForward,
  deleteToLineEnd,
  deleteToLineStart,
  deleteWordBackward,
  deleteWordForward,
  graphemeCount,
  graphemes,
  handleEditorKey,
  historyNext,
  historyPrevious,
  insertText,
  moveCursor,
  pasteText,
  recordHistory,
  setEditorText,
  takeSubmission,
  type EditorKey,
  type EditorState,
} from "../src/tui/editor.ts";

function key(name: string, raw = name, modifiers: Partial<EditorKey> = {}): EditorKey {
  return { name, raw, ...modifiers };
}

function editor(text: string): EditorState {
  return createEditor(text);
}

function at(state: EditorState, cursor: number): EditorState {
  return { ...state, cursor };
}

test("graphemes and codeUnitOffset keep combining, flags and ZWJ emoji whole", () => {
  const text = "e\u0301🇺🇸👨‍👩‍👧‍👦你";
  assert.deepEqual(graphemes(text), ["e\u0301", "🇺🇸", "👨‍👩‍👧‍👦", "你"]);
  assert.equal(graphemeCount(text), 4);
  assert.equal(codeUnitOffset(text, 0), 0);
  assert.equal(codeUnitOffset(text, 1), 2);
  assert.equal(codeUnitOffset(text, 2), 6);
  assert.equal(codeUnitOffset(text, 4), text.length);
  assert.equal(codeUnitOffset(text, 100), text.length);
});

test("createEditor normalizes newlines and puts the cursor at the end", () => {
  const state = createEditor("one\r\ntwo\rthree");
  assert.equal(state.text, "one\ntwo\nthree");
  assert.equal(state.cursor, graphemeCount(state.text));
  assert.deepEqual(state.history, []);
  assert.equal(state.historyIndex, null);
  assert.deepEqual(cursorPosition(state), { line: 2, column: 5 });
});

test("insertText and deleteBackward/deleteForward are grapheme-safe and immutable", () => {
  const original = editor("A👨‍👩‍👧‍👦B");
  const inserted = insertText(at(original, 1), "e\u0301");
  assert.equal(inserted.text, "Ae\u0301👨‍👩‍👧‍👦B");
  assert.equal(inserted.cursor, 2);
  assert.equal(original.text, "A👨‍👩‍👧‍👦B");
  assert.equal(original.cursor, 3);

  const withoutEmoji = deleteBackward(at(inserted, 3));
  assert.equal(withoutEmoji.text, "Ae\u0301B");
  assert.equal(withoutEmoji.cursor, 2);
  const withoutB = deleteForward(withoutEmoji);
  assert.equal(withoutB.text, "Ae\u0301");
  const empty = editor("");
  assert.equal(deleteBackward(empty), empty);
});

test("setEditorText and insertions clip at UTF-16 caps without splitting graphemes", () => {
  const state = createEditor("abcd", { maxChars: 3 });
  assert.equal(state.text, "abc");
  assert.equal(state.cursor, 3);

  const emoji = createEditor("😀", { maxChars: 1 });
  assert.equal(emoji.text, "", "a surrogate pair is never clipped in half");
  const combined = createEditor("e\u0301x", { maxChars: 1 });
  assert.equal(combined.text, "", "a combining cluster is kept whole");

  const replaced = setEditorText(editor("old"), "new\r\ntext");
  assert.equal(replaced.text, "new\ntext");
  assert.equal(replaced.cursor, 8);
});

test("left/right, word movement and logical/document Home/End", () => {
  const base = editor("one two\nthree");
  assert.equal(moveCursor(base, "left").cursor, base.cursor - 1);
  assert.equal(moveCursor(at(base, 0), "right").cursor, 1);
  assert.equal(moveCursor(base, "wordLeft").cursor, 8);
  assert.equal(moveCursor(at(base, 0), "wordRight").cursor, 3);
  assert.equal(moveCursor(base, "lineStart").cursor, 8);
  assert.equal(moveCursor(at(base, 9), "lineEnd").cursor, 13);
  assert.equal(moveCursor(base, "docStart").cursor, 0);
  assert.equal(moveCursor(at(base, 0), "docEnd").cursor, 13);
});

test("vertical movement preserves the grapheme column and clamps short lines", () => {
  const base = at(editor("abcd\nx\n1234"), 9);
  const up = moveCursor(base, "lineUp");
  assert.deepEqual(cursorPosition(up), { line: 1, column: 1 });
  assert.deepEqual(cursorPosition(moveCursor(up, "lineUp")), { line: 0, column: 1 });
  const down = moveCursor(up, "lineDown");
  assert.deepEqual(cursorPosition(down), { line: 2, column: 1 });
  const singleLine = editor("x");
  assert.equal(moveCursor(singleLine, "lineUp"), singleLine);
});

test("word and line deletion cover both directions", () => {
  assert.equal(deleteWordBackward(editor("one two three")).text, "one two ");
  assert.equal(deleteWordForward(at(editor("one two three"), 0)).text, " two three");
  assert.equal(deleteToLineStart(at(editor("one\ntwo"), 7)).text, "one\n");
  assert.equal(deleteToLineEnd(at(editor("one\ntwo"), 5)).text, "one\nt");
});

test("Enter submits without consuming text; Shift/Alt+Enter and Ctrl+J insert newlines", () => {
  const base = editor("task");
  const submit = handleEditorKey(base, key("return", "\r"));
  assert.equal(submit.action, "submit");
  assert.equal(submit.state, base);

  for (const newlineKey of [
    key("return", "\r", { shift: true }),
    key("enter", "\r", { alt: true }),
    key("j", "\n", { ctrl: true }),
  ]) {
    const result = handleEditorKey(base, newlineKey);
    assert.equal(result.action, "newline");
    assert.equal(result.state.text, "task\n");
  }
});

test("paste is one normalized edit and can never submit", () => {
  const base = at(editor("before after"), 7);
  const result = pasteText(base, "\u001b[200~one\r\ntwo\r\u0000three \u001b[201~");
  assert.equal(result.text, "before one\ntwo\nthree after");
  assert.equal(result.cursor, 21);

  const folded = handleEditorKey(editor(""), key("paste", "a\r\nb"));
  assert.equal(folded.action, "paste");
  assert.equal(folded.state.text, "a\nb");
  assert.equal(handleEditorKey(folded.state, key("return", "\r")).action, "submit");

  const chunk = handleEditorKey(editor(""), key("x", "multi\rline"));
  assert.equal(chunk.action, "paste");
  assert.equal(chunk.state.text, "multi\nline");
});

test("paste strips terminal control bytes, including C1 and escape introduces", () => {
  const state = pasteText(editor(""), "a\u001b[31mb\u009bc\u0007d");
  assert.equal(state.text, "a[31mbcd");
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(state.text));
});

test("history is bounded, deduplicated and restores the live draft", () => {
  let state = createEditor("draft");
  state = recordHistory(state, "one", { maxHistory: 2 });
  state = recordHistory(state, "two", { maxHistory: 2 });
  state = recordHistory(state, "two", { maxHistory: 2 });
  state = recordHistory(state, "three", { maxHistory: 2 });
  assert.deepEqual(state.history, ["two", "three"]);

  state = historyPrevious(state);
  assert.equal(state.text, "three");
  assert.equal(state.draft, "draft");
  state = historyPrevious(state);
  assert.equal(state.text, "two");
  assert.equal(historyPrevious(state), state, "the oldest entry stops");
  state = historyNext(state);
  assert.equal(state.text, "three");
  state = historyNext(state);
  assert.equal(state.text, "draft");
  assert.equal(state.historyIndex, null);
  assert.equal(state.draft, "");
});

test("editing recalled history leaves browsing and returns to a live draft", () => {
  let state = recordHistory(editor("unsent"), "old");
  state = historyPrevious(state);
  state = insertText(state, "!");
  assert.equal(state.text, "old!");
  assert.equal(state.historyIndex, null);
  assert.equal(state.draft, "");
  assert.deepEqual(state.history, ["old"]);
});

test("takeSubmission returns exact text, clears the draft and records non-blank history", () => {
  const original = recordHistory(editor("first\nsecond"), "earlier");
  const submission = takeSubmission(original);
  assert.equal(submission.text, "first\nsecond");
  assert.equal(submission.state.text, "");
  assert.equal(submission.state.cursor, 0);
  assert.deepEqual(submission.state.history, ["earlier", "first\nsecond"]);
  assert.equal(original.text, "first\nsecond");

  const blank = takeSubmission(editor("  \n"));
  assert.deepEqual(blank.state.history, []);
  assert.equal(clearEditor(original).text, "");
});

test("maxHistory zero disables recall and blank entries are ignored", () => {
  const state = recordHistory(editor("draft"), "entry", { maxHistory: 0 });
  assert.deepEqual(state.history, []);
  assert.equal(historyPrevious(state), state);
  assert.equal(recordHistory(state, "\n "), state);
});

test("handleEditorKey maps deletion, navigation, history, scrolling and cancellation", () => {
  const base = editor("one two");
  assert.equal(handleEditorKey(base, key("backspace", "\u007f")).state.text, "one tw");
  assert.equal(
    handleEditorKey(base, key("backspace", "\u007f", { ctrl: true })).state.text,
    "one ",
  );
  assert.equal(handleEditorKey(base, key("delete", "\u001b[3~")).state, base);
  assert.equal(handleEditorKey(base, key("left", "\u001b[D")).state.cursor, 6);
  assert.equal(handleEditorKey(base, key("home", "\u001b[H")).state.cursor, 0);
  assert.equal(handleEditorKey(base, key("pageup", "\u001b[5~")).action, "scroll-prev");
  assert.equal(handleEditorKey(base, key("pagedown", "\u001b[6~")).action, "scroll-next");
  assert.equal(handleEditorKey(base, key("tab", "\t")).action, "complete");
  assert.equal(handleEditorKey(base, key("c", "\u0003", { ctrl: true })).action, "cancel");
  assert.equal(handleEditorKey(base, key("escape", "\u001b")).action, "cancel");
  assert.equal(handleEditorKey(base, key("p", "\u0010", { ctrl: true })).action, "ignore");
});

test("Up/Down move within multiline drafts and use history only at the edges", () => {
  let state = recordHistory(editor("one\ntwo"), "old");
  const firstLine = moveCursor(state, "docStart");
  assert.equal(handleEditorKey(firstLine, key("down", "\u001b[B")).state.cursor, 4);
  const recalled = handleEditorKey(firstLine, key("up", "\u001b[A"));
  assert.equal(recalled.action, "history-prev");
  assert.equal(recalled.state.text, "old");
  const restored = handleEditorKey(recalled.state, key("down", "\u001b[B"));
  assert.equal(restored.action, "history-next");
  assert.equal(restored.state.text, "one\ntwo");
});

test("recall boundary rule: single-line anywhere, multiline only at the very edges", () => {
  // A single-line draft has no vertical movement, so Up recalls from any caret
  // column and Down steps forward/restores exactly.
  let single = recordHistory(editor("live draft"), "older");
  single = recordHistory(single, "newest task");
  const recalledFromMiddle = handleEditorKey(at(single, 4), key("up", "\u001b[A"));
  assert.equal(recalledFromMiddle.action, "history-prev");
  assert.equal(recalledFromMiddle.state.text, "newest task");
  assert.equal(recalledFromMiddle.state.draft, "live draft");
  const forward = handleEditorKey(recalledFromMiddle.state, key("down", "\u001b[B"));
  assert.equal(forward.action, "history-next");
  assert.equal(forward.state.text, "live draft");
  assert.equal(forward.state.historyIndex, null);

  // Multiline: Up at an interior first-line caret is ordinary movement (a
  // no-op at the top), never a recall that replaces the draft being edited.
  const multi = at(recordHistory(editor("first\nsecond"), "old"), 3);
  const interiorUp = handleEditorKey(multi, key("up", "\u001b[A"));
  assert.equal(interiorUp.action, "none");
  assert.deepEqual(interiorUp.state, multi);

  // At the very start of the first line it recalls and stashes the draft bytes.
  const recalled = handleEditorKey(at(multi, 0), key("up", "\u001b[A"));
  assert.equal(recalled.action, "history-prev");
  assert.equal(recalled.state.text, "old");
  assert.equal(recalled.state.draft, "first\nsecond");

  // A recalled multiline entry keeps its interior cursor: Down on the last
  // line before its end is movement (a no-op at the bottom), and only the very
  // end of the draft restores the stashed live draft.
  const multilineHistory = recordHistory(editor("live"), "recalled\nentry");
  const entry = handleEditorKey(at(multilineHistory, 0), key("up", "\u001b[A"));
  assert.equal(entry.state.text, "recalled\nentry");
  const interiorDown = handleEditorKey(at(entry.state, 11), key("down", "\u001b[B"));
  assert.equal(interiorDown.action, "none");
  assert.deepEqual(interiorDown.state, at(entry.state, 11));
  const restored = handleEditorKey(entry.state, key("down", "\u001b[B"));
  assert.equal(restored.action, "history-next");
  assert.equal(restored.state.text, "live");
  assert.equal(restored.state.draft, "");
});
