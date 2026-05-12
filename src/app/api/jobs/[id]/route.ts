import { NextRequest } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  const supabase = await getSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { data: job, error } = await supabase
    .from("jobs")
    .select("*, scenes(* order by scene_number asc)")
    .eq("id", id)
    .single();

  if (error || !job) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ job });
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  const supabase = await getSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { error } = await supabase
    .from("jobs")
    .update({ status: "cancelled" })
    .eq("id", id);

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true });
}
