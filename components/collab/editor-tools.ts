import { EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  rectangularSelection,
  crosshairCursor,
  drawSelection,
} from "@codemirror/view";
import {
  search,
  searchKeymap,
  highlightSelectionMatches,
} from "@codemirror/search";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
} from "@codemirror/language";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  completeAnyWord,
} from "@codemirror/autocomplete";
import { indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { python } from "@codemirror/lang-python";
import { markdown } from "@codemirror/lang-markdown";
export function editorTools(filename: string, readOnly = false, semantic = false): Extension[] {
  const ext = filename.split(".").at(-1)?.toLowerCase();
  const language =
    ext && /^[cm]?[jt]sx?$/.test(ext)
      ? javascript({
          typescript: /^[cm]?tsx?$/.test(ext),
          jsx: /^[jt]sx$/.test(ext),
        })
      : ext === "json"
        ? json()
        : ext === "css"
          ? css()
          : ext === "html"
            ? html()
            : ext === "py"
              ? python()
              : ext === "md"
                ? markdown()
                : [];
  return [
    EditorState.phrases.of({
      Find: "查找",
      Replace: "替换",
      next: "下一个",
      previous: "上一个",
      all: "全选匹配",
      "match case": "区分大小写",
      regexp: "正则表达式",
      "by word": "全词匹配",
      replace: "替换当前",
      "replace all": "全部替换",
      close: "关闭",
      "Go to line": "跳转行",
      go: "跳转",
      "Control character": "控制字符",
    }),
    language,
    search({ top: true }),
    highlightSelectionMatches(),
    bracketMatching(),
    foldGutter(),
    indentOnInput(),
    EditorState.allowMultipleSelections.of(true),
    rectangularSelection(),
    crosshairCursor(),
    drawSelection(),
    keymap.of([
      ...searchKeymap,
      ...foldKeymap,
      ...(!readOnly
        ? [...closeBracketsKeymap, ...completionKeymap, indentWithTab]
        : []),
    ]),
    ...(!readOnly
      ? [closeBrackets(), ...(semantic ? [] : [autocompletion({ override: [completeAnyWord] })])]
      : []),
    EditorView.contentAttributes.of({ "aria-label": `代码内容：${filename}` }),
  ];
}
export { formatCode } from "@/lib/collab/format-code";
