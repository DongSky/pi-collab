import { z } from "zod";
import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { editorFiles } from "@/lib/collab/editor-files";
import { validateEditorPath, validateEditorText } from "@/lib/collab/editor";
import { projectFormatOptions } from "@/lib/collab/project-format";
import { formatCode } from "@/lib/collab/format-code";
import { DomainError } from "@/lib/collab/policy";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => {
    const input = z.object({ path: z.string().max(1024), text: z.string().max(262144) }).strict().parse(await jsonBody(request, 2 * 1024 * 1024));
    validateEditorPath(input.path); validateEditorText(input.text);
    const { files } = await editorFiles((await identity(request)).user.id, (await params).id);
    if (!files.has(input.path)) throw new DomainError("not_found", "格式化文件不存在。", 404);
    const { options, config } = projectFormatOptions(new Map([...files].map(([name, bytes]) => [name, bytes.toString("utf8")])), input.path);
    try { return { text: await formatCode(input.path, input.text, options), config }; }
    catch { throw new DomainError("format_failed", "当前文件无法格式化，请先修正语法或核对文件类型。"); }
  });
}
