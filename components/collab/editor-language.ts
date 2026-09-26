import { autocompletion, completeAnyWord, type CompletionContext } from "@codemirror/autocomplete";
import { hoverTooltip, keymap, Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";
import type { CodeDiagnostic } from "@/lib/collab/language-schema";
import type { LanguageRequest, LanguageResult } from "@/lib/collab/language-schema";
import { collabApi } from "./api";
export const setDiagnosticMarks = StateEffect.define<CodeDiagnostic[]>();
const diagnosticMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (current, transaction) => {
    if (transaction.docChanged) current = Decoration.none;
    for (const effect of transaction.effects) if (effect.is(setDiagnosticMarks)) current = Decoration.set(effect.value.filter(d => d.from < transaction.newDoc.length).map(d => Decoration.mark({ class: `wb-diagnostic-${d.severity}`, attributes: { title: `TS${d.code}: ${d.name}` } }).range(d.from, Math.min(transaction.newDoc.length, Math.max(d.from + 1, d.to)))), true);
    return current;
  },
  provide: field => EditorView.decorations.from(field),
});
export const supportsSemantic = (name: string) => /\.[cm]?[jt]sx?$/i.test(name);
export function semanticExtensions(sessionId: string, path: string, run: (action: LanguageRequest["action"]) => void) {
  const query = (input: Partial<LanguageRequest>) => collabApi<LanguageResult>(`editors/${sessionId}/language`, { path, ...input }, "POST", AbortSignal.timeout(15000));
  return [
    diagnosticMarks,
    autocompletion({ override: [async (context: CompletionContext) => {
      const word = context.matchBefore(/[$\w]*/);
      if (!context.explicit && (!word || word.from === word.to) && context.state.sliceDoc(Math.max(0, context.pos - 1), context.pos) !== ".") return null;
      try {
        const response = await query({ action: "complete", position: context.pos, text: context.state.doc.toString() });
        if (context.aborted) return null;
        return { from: word?.from ?? context.pos, options: response.completions ?? [], validFor: /^[$\w]*$/ };
      } catch { return completeAnyWord(context); }
    }] }),
    hoverTooltip(async (view, position) => {
      const before = view.state.doc;
      try {
        const response = await query({ action: "hover", position, text: before.toString() });
        if (!response.hover || view.state.doc !== before) return null;
        return { pos: position, create: () => { const dom = document.createElement("pre"); dom.className = "wb-type-hover"; dom.textContent = response.hover!; return { dom }; } };
      } catch { return null; }
    }),
    keymap.of([
      { key: "F12", run: () => { run("definition"); return true; } },
      { key: "Shift-F12", run: () => { run("references"); return true; } },
      { key: "Mod-.", run: () => { run("fixes"); return true; } },
      { key: "F2", run: () => { run("rename"); return true; } },
      { key: "Mod-Shift-o", run: () => { run("symbols"); return true; } },
    ]),
  ];
}
