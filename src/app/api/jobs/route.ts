import { NextRequest } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase";
import { CreateJobSchema } from "@/lib/schemas";

export async function GET() {
  const supabase = await getSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("jobs")
    .select("id, title, status, duration_seconds, cost_usd, created_at, completed_at")
    .order("created_at", { ascending: false });

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ jobs: data });
}

export async function POST(request: NextRequest) {
  const supabase = await getSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body) return Response.json({ error: "Invalid JSON" }, { status: 400 });

  const parsed = CreateJobSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .from("jobs")
    .insert({ ...parsed.data, user_id: user.id, status: "draft" })
    .select("id, title, status, created_at")
    .single();

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ job: data }, { status: 201 });
}
