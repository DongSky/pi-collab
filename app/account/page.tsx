import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/collab/auth";
import { AccountSecurity } from "@/components/collab/AccountSecurity";
import "../collab.css";
export const dynamic = "force-dynamic";
export default async function AccountPage() {
  if (!await auth().api.getSession({ headers: await headers() })) redirect("/sign-in");
  return <AccountSecurity />;
}
