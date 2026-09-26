import Link from "next/link";
import { PasswordResetForm } from "@/components/collab/PasswordResetForm";
import "../collab.css";
export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  if (!token) return <main className="collab-app collab-settings"><div className="collab-settings-content"><h1>重置链接无效</h1><Link href="/forgot-password">重新申请</Link></div></main>;
  return <PasswordResetForm token={token} />;
}
