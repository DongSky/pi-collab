import { endpoint, identity } from "@/lib/collab/http";
import { database } from "@/lib/collab/database";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return endpoint(request, async () => {
    const session = await identity(request);
    const { rows } = await database().query('SELECT coalesce("twoFactorEnabled",false) AS enabled,collab.user_requires_mfa(id) AS required FROM public."user" WHERE id=$1', [session.user.id]);
    // Dev/test escape hatch mirrors the DB-level bypass.
    const mfa = process.env.PI_COLLAB_DISABLE_MFA === "1" ? { ...rows[0], required: false } : rows[0];
    return { user: { id: session.user.id, name: session.user.name, email: session.user.email }, mfa, runtime: process.env.PI_COLLAB_RUNTIME ?? "native" };
  });
}
