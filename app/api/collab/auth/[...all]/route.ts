import { oidcAuthHandler } from "@/lib/collab/oidc-auth";

// Signup is always disabled on the public auth instance. Keep reset/recovery and
// account/session/MFA endpoints within the maintained library's security checks.
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return oidcAuthHandler(request); }
export async function POST(request: Request) { return oidcAuthHandler(request); }
