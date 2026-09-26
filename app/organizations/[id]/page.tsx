import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/collab/auth";
import { OrganizationSettings } from "@/components/collab/OrganizationSettings";
import "../../collab.css";
export const dynamic = "force-dynamic";
export default async function OrganizationPage({ params }: { params: Promise<{ id: string }> }) {
  if (!await auth().api.getSession({ headers: await headers() })) redirect("/sign-in");
  return <OrganizationSettings id={(await params).id} />;
}
