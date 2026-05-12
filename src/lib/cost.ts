import { getSupabaseAdminClient } from "./supabase-admin";

// ─── Unit costs ──────────────────────────────────────────────────────────────

export const MODEL_COSTS = {
  "gpt-5.4-mini": { input_per_1m: 0.15, output_per_1m: 0.60 },
  "gpt-image-2":  { per_image: 0.17 },
  "veo-3-fast":   { per_second: 0.15 },
  "veo-3":        { per_second: 0.40 },
} as const;

export function computeTextCost(
  inputTokens: number,
  outputTokens: number
): number {
  const { input_per_1m, output_per_1m } = MODEL_COSTS["gpt-5.4-mini"];
  return (
    (inputTokens  / 1_000_000) * input_per_1m +
    (outputTokens / 1_000_000) * output_per_1m
  );
}

export function computeVideoCost(
  veoModel: "veo-3-fast" | "veo-3",
  durationSeconds: number
): number {
  return MODEL_COSTS[veoModel].per_second * durationSeconds;
}

export function estimateJobCost(params: {
  durationSeconds: number;
  veoModel: "veo-3-fast" | "veo-3";
}): number {
  const scenes = params.durationSeconds / 8;
  const veoCost = MODEL_COSTS[params.veoModel].per_second * params.durationSeconds;
  const imageCost = scenes * MODEL_COSTS["gpt-image-2"].per_image;
  const textCost = 0.05; // rough fixed estimate for script + prompts GPT calls
  return veoCost + imageCost + textCost;
}

// ─── API call logging ────────────────────────────────────────────────────────

type LogApiCallParams = {
  jobId: string;
  sceneId?: string;
  provider: "openai" | "google";
  model: string;
  operation: "script" | "prompts" | "image" | "video" | "stitch";
  costUsd: number;
  durationMs: number;
  requestPayload?: unknown;
  responsePayload?: unknown;
  status: "success" | "error";
  errorCode?: string;
};

export async function logApiCall(params: LogApiCallParams): Promise<void> {
  const sb = getSupabaseAdminClient();

  await sb.from("api_calls").insert({
    job_id:           params.jobId,
    scene_id:         params.sceneId ?? null,
    provider:         params.provider,
    model:            params.model,
    operation:        params.operation,
    cost_usd:         params.costUsd,
    duration_ms:      params.durationMs,
    request_payload:  params.requestPayload  ?? null,
    response_payload: params.responsePayload ?? null,
    status:           params.status,
    error_code:       params.errorCode ?? null,
  });

  // Recompute total from api_calls — race-condition-safe for concurrent scene calls.
  const { data } = await sb
    .from("api_calls")
    .select("cost_usd")
    .eq("job_id", params.jobId);

  const total = (data ?? []).reduce((sum, r) => sum + Number(r.cost_usd), 0);
  await sb.from("jobs").update({ cost_usd: total }).eq("id", params.jobId);
}
