import path from "node:path";
import ts from "typescript";
import { DomainError } from "./policy";
import type { CodeLocation, FileChange, LanguageRequest, LanguageResult } from "./language-schema";

const root = "/__pi_collab_project__/";
const sourceFile = /\.(?:[cm]?[jt]sx?|json)$/i;
const scriptFile = /\.[cm]?[jt]sx?$/i;
// No project plugins, host node_modules, or arbitrary filesystem access. Only the
// server's bundled TypeScript standard library may be read outside the snapshot.
const libDir = path.dirname(ts.getDefaultLibFilePath({}));
let libraries: Map<string, string> | undefined;
function standardLibraries() {
  if (!libraries) {
    libraries = new Map();
    for (const file of ts.sys.readDirectory(libDir, [".ts"], undefined, ["lib*.d.ts"], 1)) {
      const text = ts.sys.readFile(file);
      if (text !== undefined) libraries.set(`/__pi_typescript_lib__/${path.basename(file)}`, text);
    }
  }
  return libraries;
}
export function analyzeCode(inputFiles: Map<string, string>, version: string, input: LanguageRequest): LanguageResult {
  if (!scriptFile.test(input.path)) throw new DomainError("unsupported_language", "语义服务当前支持 JavaScript / TypeScript。其他语言仍可编辑和搜索。");
  if (!inputFiles.has(input.path)) throw new DomainError("not_found", "语言服务文件不存在。", 404);
  const files = new Map<string, string>(), result: LanguageResult = { version, skipped: 0, notices: [] };
  let bytes = 0;
  for (const [name, text] of inputFiles) {
    if (!sourceFile.test(name)) continue;
    bytes += Buffer.byteLength(text);
    if (files.size >= 300 || bytes > 4 * 1024 * 1024) throw new DomainError("language_limit", "语言分析最多支持 300 个源码 / JSON 文件、4 MiB；请缩小工作文件夹。", 413);
    files.set(root + name, text);
  }
  const filename = root + input.path;
  if (input.text !== undefined) files.set(filename, input.text);
  const text = files.get(filename)!;
  if (input.position > text.length) throw new DomainError("invalid_position", "光标位置已变化，请重试。");
  const libs = standardLibraries(), all = new Map([...libs, ...files]);
  const normalize = (name: string) => path.posix.normalize(name);
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.ReactJSX, allowJs: true, checkJs: true, strict: true, noEmit: true, skipLibCheck: true, resolveJsonModule: true, allowImportingTsExtensions: true };
  const configText = inputFiles.get("tsconfig.json") ?? inputFiles.get("jsconfig.json");
  if (configText) {
    const parsed = ts.parseConfigFileTextToJson("tsconfig.json", configText);
    if (parsed.error) result.notices.push("项目配置无法解析，使用默认语言设置。");
    else {
      const converted = ts.convertCompilerOptionsFromJson(parsed.config.compilerOptions ?? {}, root);
      // Explicitly supported data-only options; never load plugins or execute config.
      for (const key of ["strict", "strictNullChecks", "noImplicitAny", "target", "module", "moduleResolution", "jsx", "checkJs", "allowJs", "baseUrl", "paths", "experimentalDecorators", "esModuleInterop", "allowSyntheticDefaultImports", "noUnusedLocals", "noUnusedParameters"] as const) {
        if (converted.options[key] !== undefined) Object.assign(options, { [key]: converted.options[key] });
      }
      if (parsed.config.extends || parsed.config.references) result.notices.push("当前不展开 tsconfig extends / references；仅使用本文件 compilerOptions。");
      for (const error of converted.errors) result.notices.push(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
    }
  }
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => [...files.keys()].filter(f => scriptFile.test(f)),
    getScriptVersion: () => "1", getCurrentDirectory: () => root,
    getDefaultLibFileName: () => `/__pi_typescript_lib__/${ts.getDefaultLibFileName(options)}`,
    getScriptSnapshot: name => { const value = all.get(normalize(name)); return value === undefined ? undefined : ts.ScriptSnapshot.fromString(value); },
    fileExists: name => all.has(normalize(name)), readFile: name => all.get(normalize(name)),
    directoryExists: name => [...all.keys()].some(f => f.startsWith(normalize(name).replace(/\/$/, "") + "/")),
    readDirectory: name => [...all.keys()].filter(f => f.startsWith(normalize(name).replace(/\/$/, "") + "/")),
  };
  const service = ts.createLanguageService(host);
  const location = (file: string, span: ts.TextSpan, name: string): CodeLocation | null => {
    if (!files.has(file)) return null;
    const before = files.get(file)!.slice(0, span.start), lines = before.split("\n");
    return { path: file.slice(root.length), from: span.start, to: span.start + span.length, line: lines.length, column: lines.at(-1)!.length + 1, name };
  };
  const changes = (edits: readonly ts.FileTextChanges[]): FileChange[] => {
    if (edits.length > 40) throw new DomainError("edit_limit", "一次重构最多修改 40 个文件，请缩小重构范围。", 413);
    return edits.map(edit => {
    const before = files.get(edit.fileName);
    if (before === undefined || edit.isNewFile) throw new DomainError("unsupported_edit", "此重构需要访问当前草稿以外的文件，未应用。");
    let after = before, last = before.length + 1;
    for (const change of [...edit.textChanges].sort((a, b) => b.span.start - a.span.start)) {
      if (change.span.start + change.span.length > last) throw new DomainError("overlapping_edit", "语言服务返回重叠修改，请重新分析。");
      after = after.slice(0, change.span.start) + change.newText + after.slice(change.span.start + change.span.length);
      last = change.span.start;
    }
    return { path: edit.fileName.slice(root.length), before, after };
  }).filter(c => c.before !== c.after);
  };
  try {
    if (input.action === "diagnostics") {
      result.diagnostics = [...service.getSyntacticDiagnostics(filename), ...service.getSemanticDiagnostics(filename)].slice(0, 150).flatMap(d => {
        const loc = location(d.file?.fileName ?? filename, { start: d.start ?? 0, length: d.length ?? 0 }, ts.flattenDiagnosticMessageText(d.messageText, "\n"));
        return loc ? [{ ...loc, severity: d.category === ts.DiagnosticCategory.Error ? "error" as const : "warning" as const, code: d.code }] : [];
      });
    } else if (input.action === "complete") {
      result.completions = service.getCompletionsAtPosition(filename, input.position, { includeCompletionsForModuleExports: false, includeCompletionsWithInsertText: false })?.entries.slice(0, 150).map(e => ({ label: e.name, type: /function|method/.test(e.kind) ? "function" : /class|interface|type/.test(e.kind) ? "type" : e.kind === "keyword" ? "keyword" : "variable", detail: e.kind })) ?? [];
    } else if (input.action === "hover") {
      const info = service.getQuickInfoAtPosition(filename, input.position);
      result.hover = info ? ts.displayPartsToString(info.displayParts) + "\n" + ts.displayPartsToString(info.documentation) : "";
    } else if (input.action === "definition" || input.action === "references") {
      const refs = input.action === "definition" ? service.getDefinitionAtPosition(filename, input.position) : service.getReferencesAtPosition(filename, input.position);
      result.locations = (refs ?? []).slice(0, 200).flatMap(r => { const loc = location(r.fileName, r.textSpan, input.action === "definition" ? "定义" : "引用"); return loc ? [loc] : []; });
    } else if (input.action === "symbols") {
      result.locations = [];
      const visit = (item: ts.NavigationTree) => { if (item.kind !== "module" && result.locations!.length < 200) { const loc = location(filename, item.nameSpan ?? item.spans[0], `${item.text} · ${item.kind}`); if (loc) result.locations!.push(loc); } for (const child of item.childItems ?? []) visit(child); };
      visit(service.getNavigationTree(filename));
    } else if (input.action === "fixes") {
      const diagnostics = [...service.getSyntacticDiagnostics(filename), ...service.getSemanticDiagnostics(filename), ...service.getSuggestionDiagnostics(filename)];
      const relevant = diagnostics.filter(d => d.start !== undefined && input.position >= d.start && input.position <= d.start + (d.length ?? 0));
      const seen = new Set<string>(); result.codeActions = [];
      for (const diagnostic of relevant.slice(0, 8)) {
        const start = diagnostic.start ?? 0;
        for (const fix of service.getCodeFixesAtPosition(filename, start, start + (diagnostic.length ?? 0), [diagnostic.code], {}, {})) {
          if (fix.commands?.length) continue;
          const key = JSON.stringify(fix.changes); if (seen.has(key)) continue; seen.add(key);
          try { const edits = changes(fix.changes); if (edits.length && edits.length <= 40) result.codeActions.push({ description: fix.description, preview: { version, changes: edits, label: fix.description } }); } catch { /* fixes outside this draft are not executable */ }
        }
      }
    } else if (input.action === "organize") {
      result.preview = { version, changes: changes(service.organizeImports({ type: "file", fileName: filename }, {}, {})), label: "整理导入" };
    } else if (input.action === "rename") {
      if (!input.newName || !/^[$_\p{ID_Start}][$_\u200c\u200d\p{ID_Continue}]*$/u.test(input.newName)) throw new DomainError("invalid_name", "请输入合法的符号名称。");
      const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, input.newName);
      if (scanner.scan() !== ts.SyntaxKind.Identifier || scanner.scan() !== ts.SyntaxKind.EndOfFileToken) throw new DomainError("invalid_name", "符号名不能是保留字。");
      const info = service.getRenameInfo(filename, input.position, {});
      if (!info.canRename) throw new DomainError("cannot_rename", info.localizedErrorMessage);
      const grouped = new Map<string, ts.TextChange[]>();
      for (const r of service.findRenameLocations(filename, input.position, false, false, true) ?? []) {
        if (!files.has(r.fileName)) throw new DomainError("unsupported_edit", "重命名超出当前草稿范围。");
        const list = grouped.get(r.fileName) ?? [];
        list.push({ span: r.textSpan, newText: `${r.prefixText ?? ""}${input.newName}${r.suffixText ?? ""}` }); grouped.set(r.fileName, list);
      }
      result.preview = { version, changes: changes([...grouped].map(([fileName, textChanges]) => ({ fileName, textChanges }))), label: `重命名 ${info.displayName} → ${input.newName}` };
    }
    return result;
  } finally { service.dispose(); }
}
