import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import {
  searchEditorFiles,
  exportEditorFiles,
} from "@/lib/collab/editor-files";
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, { params }: Context) {
  return endpoint(request, async () =>
    searchEditorFiles(
      (await identity(request)).user.id,
      (await params).id,
      await jsonBody(request),
    ),
  );
}
export async function GET(request: Request, { params }: Context) {
  return endpoint(request, async () => {
    const result = await exportEditorFiles(
      (await identity(request)).user.id,
      (await params).id,
    );
    return new Response(Buffer.from(result.bytes), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="pi-collab-draft-v${result.version}.zip"`,
        "Cache-Control": "no-store",
      },
    });
  });
}
