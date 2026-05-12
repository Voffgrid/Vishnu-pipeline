import { redirect } from "next/navigation";
import { getSupabaseServerClient } from "@/lib/supabase";
import DashboardShell from "@/components/dashboard-shell";
import type { DashJob } from "@/components/dashboard-shell";

export default async function HomePage() {
  const supabase = await getSupabaseServerClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: jobs } = await supabase
    .from("jobs")
    .select("id, title, status, duration_seconds, cost_usd, created_at")
    .order("created_at", { ascending: false });

  return (
    <DashboardShell
      jobs={(jobs ?? []) as DashJob[]}
      userEmail={user.email ?? ""}
    />
  );
}
