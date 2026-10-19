/** Code view: CodeMirror 6 with HTML/CSS/JS/PHP/XML modes, folding, completion, search and toggles. */
import { EditorState, Compartment, type Extension, EditorSelection } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, highlightSpecialChars, rectangularSelection, crosshairCursor, dropCursor } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo, toggleComment, indentMore, indentLess } from '@codemirror/commands';
import { foldGutter, foldKeymap, indentOnInput, bracketMatching, syntaxHighlighting, defaultHighlightStyle, foldAll, unfoldAll, foldCode, unfoldCode, indentUnit } from '@codemirror/language';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches, openSearchPanel, gotoLine } from '@codemirror/search';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { javascript } from '@codemirror/lang-javascript';
import { php } from '@codemirror/lang-php';
import { xml } from '@codemirror/lang-xml';
import { extOf } from '../model/paths';

export interface CodeOptions { lineNumbers: boolean; wrap: boolean; fold: boolean; autoClose: boolean; complete: boolean; tabSize: number; highlightLine: boolean }

export function languageFor(path: string): Extension {
  switch (extOf(path)) {
    case 'css': case 'scss': case 'less': return css();
    case 'js': case 'mjs': case 'json': case 'map': case 'webmanifest': return javascript();
    case 'ts': return javascript({ typescript: true });
    case 'jsx': return javascript({ jsx: true });
    case 'tsx': return javascript({ jsx: true, typescript: true });
    case 'php': return php();
    case 'xml': case 'rss': case 'atom': case 'svg': case 'xsl': return xml();
    case 'txt': case 'md': case 'csv': case 'htaccess': case 'ini': case 'yml': case 'yaml': return [];
    default: return html({ autoCloseTags: true, matchClosingTags: true });
  }
}

export class CodeView {
  view: EditorView;
  private lang = new Compartment();
  private opts = new Compartment();
  onChange: ((text: string) => void) | null = null;
  onFocus: (() => void) | null = null;
  private silent = false;

  constructor(public el: HTMLElement, path: string, text: string, o: CodeOptions) {
    this.view = new EditorView({
      parent: el,
      state: EditorState.create({
        doc: text,
        extensions: [
          highlightSpecialChars(), history(), drawSelection(), dropCursor(), EditorState.allowMultipleSelections.of(true),
          indentOnInput(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }), bracketMatching(),
          rectangularSelection(), crosshairCursor(), highlightSelectionMatches(),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
          this.lang.of(languageFor(path)),
          this.opts.of(this.optionExt(o)),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !this.silent) this.onChange?.(u.state.doc.toString());
            if (u.focusChanged && u.view.hasFocus) this.onFocus?.();
          }),
          EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { fontFamily: 'ui-monospace, "Cascadia Code", Consolas, "Courier New", monospace', fontSize: 'var(--ql-code-size, 13px)' } }),
        ],
      }),
    });
  }

  private optionExt(o: CodeOptions): Extension {
    return [
      o.lineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : [],
      o.fold ? foldGutter() : [],
      o.wrap ? EditorView.lineWrapping : [],
      o.autoClose ? closeBrackets() : [],
      o.complete ? autocompletion() : [],
      o.highlightLine ? highlightActiveLine() : [],
      EditorState.tabSize.of(o.tabSize),
      indentUnit.of(' '.repeat(o.tabSize)),
    ];
  }

  setOptions(o: CodeOptions): void { this.view.dispatch({ effects: this.opts.reconfigure(this.optionExt(o)) }); }
  setLanguage(path: string): void { this.view.dispatch({ effects: this.lang.reconfigure(languageFor(path)) }); }

  get text(): string { return this.view.state.doc.toString(); }

  /** Replaces the text without reporting a change (the change came from elsewhere). Keeps the cursor near where it was. */
  setText(text: string): void {
    if (text === this.text) return;
    const sel = this.view.state.selection.main;
    this.silent = true;
    try {
      this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text }, selection: EditorSelection.cursor(Math.min(sel.head, text.length)) });
    } finally { this.silent = false; }
  }

  get selection(): { from: number; to: number; text: string } {
    const s = this.view.state.selection.main;
    return { from: s.from, to: s.to, text: this.view.state.sliceDoc(s.from, s.to) };
  }

  replaceSelection(text: string, selectInserted = false): void {
    const s = this.view.state.selection.main;
    this.view.dispatch({ changes: { from: s.from, to: s.to, insert: text }, selection: selectInserted ? EditorSelection.range(s.from, s.from + text.length) : EditorSelection.cursor(s.from + text.length), scrollIntoView: true });
    this.view.focus();
  }

  select(from: number, to: number): void {
    this.view.dispatch({ selection: EditorSelection.range(from, to), scrollIntoView: true });
    this.view.focus();
  }

  focus(): void { this.view.focus(); }
  get hasFocus(): boolean { return this.view.hasFocus; }

  cmd(name: 'undo' | 'redo' | 'comment' | 'indent' | 'outdent' | 'foldAll' | 'unfoldAll' | 'fold' | 'unfold' | 'search' | 'gotoLine'): boolean {
    const v = this.view;
    const f = { undo, redo, comment: toggleComment, indent: indentMore, outdent: indentLess, foldAll, unfoldAll, fold: foldCode, unfold: unfoldCode, search: openSearchPanel, gotoLine }[name];
    return f(v);
  }

  /** Line and column of the cursor (1-based). */
  cursor(): { line: number; col: number } {
    const pos = this.view.state.selection.main.head;
    const l = this.view.state.doc.lineAt(pos);
    return { line: l.number, col: pos - l.from + 1 };
  }

  goToLine(n: number): void {
    const doc = this.view.state.doc;
    const l = doc.line(Math.max(1, Math.min(doc.lines, n)));
    this.select(l.from, l.from);
  }

  destroy(): void { this.view.destroy(); }
}
