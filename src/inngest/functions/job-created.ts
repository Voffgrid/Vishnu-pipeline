import { inngest } from "@/inngest/client";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";

// Listens for "job/created" → sets status to "scripting" → kicks off Stage 1.
export const onJobCreated = inngest.createFunction(
  {
    id: "job-created",
    triggers: [{ event: "job/created" }],
    retries: 3,
  },
  async ({ event, step }) => {
    const { jobId } = event.data as { jobId: string };

    await step.run("set-status-scripting", async () => {
      const sb = getSupabaseAdminClient();
      const { error } = await sb
        .from("jobs")
        .update({ status: "scripting", updated_at: new Date().toISOString() })
        .eq("id", jobId);
      if (error) throw new Error(`Failed to set status: ${error.message}`);
    });

    await step.sendEvent("trigger-stage-1", {
      name: "job/stage-1-start",
      data: { jobId },
    });
  }
);
