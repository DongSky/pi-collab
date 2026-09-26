import Link from "next/link";
import { setupStatus } from "@/lib/collab/onboarding";
import { OnboardingForm } from "@/components/collab/OnboardingForm";
import "../collab.css";
export const dynamic = "force-dynamic";
export default async function SetupPage() {
  if (!(await setupStatus()).needed) return <main className="collab-app collab-settings"><div className="collab-settings-content"><h1>初始化已完成</h1><Link href="/sign-in">前往登录</Link></div></main>;
  return <OnboardingForm mode="setup" />;
}
