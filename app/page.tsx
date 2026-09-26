import { Suspense } from "react";
import { AppShell } from "@/components/AppShell";
import { I18nProvider } from "@/hooks/useI18n";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { TeamShell } from "@/components/collab/TeamShell";
import { auth } from "@/lib/collab/auth";
import "./collab.css";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (process.env.PI_COLLAB_MODE !== "legacy") {
    const session = await auth().api.getSession({ headers: await headers() });
    if (!session) redirect("/sign-in");
    return <TeamShell user={{ id: session.user.id, name: session.user.name, email: session.user.email }} runtime={process.env.PI_COLLAB_RUNTIME ?? "native"} />;
  }
  return (
    <Suspense>
      <I18nProvider>
        <AppShell />
      </I18nProvider>
    </Suspense>
  );
}
