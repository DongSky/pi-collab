import { SignInForm } from "@/components/collab/SignInForm";
import "../collab.css";
import { redirect } from "next/navigation";
import { setupStatus } from "@/lib/collab/onboarding";
export const dynamic = "force-dynamic";
export default async function SignInPage() {
  if ((await setupStatus()).needed) redirect("/setup");
  return <SignInForm />;
}
