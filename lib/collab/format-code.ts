import type { Options } from "prettier";
export async function formatCode(
  filename: string,
  text: string,
  options: Options = {},
): Promise<string> {
  const ext = filename.split(".").at(-1)?.toLowerCase();
  const parser =
    ext && /^[cm]?[jt]sx?$/.test(ext)
      ? /^[cm]?tsx?$/.test(ext)
        ? "typescript"
        : "babel"
      : ext === "json"
        ? "json"
        : ext === "css"
          ? "css"
          : ext === "html"
            ? "html"
            : ext === "md"
              ? "markdown"
              : null;
  if (!parser)
    throw new Error(
      "此文件类型暂不支持格式化；可在终端运行项目自己的格式化工具。",
    );
  const [
    { format },
    babel,
    typescript,
    estree,
    postcss,
    htmlPlugin,
    markdownPlugin,
  ] = await Promise.all([
    import("prettier/standalone"),
    import("prettier/plugins/babel"),
    import("prettier/plugins/typescript"),
    import("prettier/plugins/estree"),
    import("prettier/plugins/postcss"),
    import("prettier/plugins/html"),
    import("prettier/plugins/markdown"),
  ]);
  return format(text, {
    ...options,
    parser,
    plugins: [babel, typescript, estree, postcss, htmlPlugin, markdownPlugin],
    endOfLine: options.endOfLine ?? "auto",
  });
}
