import path from "node:path";
import { load, JSON_SCHEMA } from "js-yaml";
import { z } from "zod";
import { DomainError } from "./policy";
import type { Options } from "prettier";
const optionsSchema = z.object({
  printWidth: z.number().int().min(20).max(500).optional(), tabWidth: z.number().int().min(1).max(16).optional(), useTabs: z.boolean().optional(), semi: z.boolean().optional(), singleQuote: z.boolean().optional(), jsxSingleQuote: z.boolean().optional(), trailingComma: z.enum(["none", "es5", "all"]).optional(), bracketSpacing: z.boolean().optional(), bracketSameLine: z.boolean().optional(), arrowParens: z.enum(["always", "avoid"]).optional(), endOfLine: z.enum(["lf", "crlf", "cr", "auto"]).optional(), quoteProps: z.enum(["as-needed", "consistent", "preserve"]).optional(), proseWrap: z.enum(["always", "never", "preserve"]).optional(), htmlWhitespaceSensitivity: z.enum(["css", "strict", "ignore"]).optional(), embeddedLanguageFormatting: z.enum(["auto", "off"]).optional(), singleAttributePerLine: z.boolean().optional(),
});
const globs = z.union([z.string().max(200), z.array(z.string().max(200)).max(50)]);
const configSchema = optionsSchema.extend({ overrides: z.array(z.object({ files: globs, excludeFiles: globs.optional(), options: optionsSchema })).max(50).optional() });
export function projectFormatOptions(files: Map<string, string>, filename: string): { options: Options; config: string } {
  let directory = path.posix.dirname(filename);
  while (true) {
    const prefix = directory === "." ? "" : directory + "/";
    for (const name of [".prettierrc", ".prettierrc.json", ".prettierrc.yaml", ".prettierrc.yml", "package.json"]) {
      const configPath = prefix + name, text = files.get(configPath);
      if (text === undefined) continue;
      let raw: unknown;
      try { raw = name.endsWith(".json") ? JSON.parse(text) : load(text, { schema: JSON_SCHEMA }); }
      catch { throw new DomainError("invalid_formatter_config", `${configPath} 无法解析，请先修正配置。`); }
      if (name === "package.json") { raw = (raw as { prettier?: unknown })?.prettier; if (raw === undefined) continue; }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new DomainError("invalid_formatter_config", `${configPath} 必须是格式选项对象。`);
      if ("plugins" in raw || "parser" in raw) throw new DomainError("unsupported_formatter_config", `${configPath} 指定了插件或自定义解析器，当前在线格式化不执行它们。请使用项目运行环境。`);
      const parsed = configSchema.safeParse(raw);
      if (!parsed.success) throw new DomainError("invalid_formatter_config", `${configPath} 的格式选项无效。`);
      const { overrides, ...options } = parsed.data;
      const relative = path.posix.relative(directory, filename);
      const matches = (patterns: string | string[] | undefined) => (typeof patterns === "string" ? [patterns] : patterns ?? []).some(pattern => path.posix.matchesGlob(relative, pattern) || (!pattern.includes("/") && path.posix.matchesGlob(path.posix.basename(relative), pattern)));
      for (const override of overrides ?? []) if (matches(override.files) && !matches(override.excludeFiles)) Object.assign(options, override.options);
      return { options, config: configPath };
    }
    if ([".prettierrc.js", ".prettierrc.cjs", ".prettierrc.mjs", ".prettierrc.ts", "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs", "prettier.config.ts"].some(n => files.has(prefix + n))) throw new DomainError("unsupported_formatter_config", "该目录使用可执行的 Prettier 配置。请改用 JSON / YAML 数据配置，或在项目运行环境格式化。");
    if (directory === "." || directory === "/") break;
    directory = path.posix.dirname(directory);
  }
  return { options: {}, config: "Prettier 默认配置" };
}
