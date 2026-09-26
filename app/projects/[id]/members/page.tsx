import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/collab/auth";
import { ProjectMembers } from "@/components/collab/ProjectMembers";
import "../../../collab.css";
export const dynamic = "force-dynamic";
export default async function ProjectMembersPage({ params }: { params: Promise<{ id: string }> }) {
  if (!await auth().api.getSession({ headers: await headers() })) redirect("/sign-in");
  return <ProjectMembers id={(await params).id} />;
}
