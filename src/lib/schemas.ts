import { z } from "zod";

export const CreateJobSchema = z.object({
  title: z.string().min(1).max(200),
  script: z.string().min(50).max(10000),
  duration_seconds: z
    .number()
    .int()
    .min(8)
    .max(300)
    .refine((n) => n % 8 === 0, { message: "duration_seconds must be a multiple of 8" }),
  aspect_ratio: z.enum(["16:9", "9:16"]),
  resolution: z.enum(["720p", "1080p"]),
  style_guide: z.string().max(1000).optional(),
  auto_mode: z.boolean(),
  veo_model: z.enum(["veo-3-fast", "veo-3"]),
});

export type CreateJobInput = z.infer<typeof CreateJobSchema>;

export const PatchSceneSchema = z.object({
  voiceover_text: z.string().min(1).optional(),
  on_screen_action: z.string().min(1).optional(),
  image_prompt: z.string().min(1).optional(),
});

export type PatchSceneInput = z.infer<typeof PatchSceneSchema>;

export const JobStatusSchema = z.enum([
  "draft",
  "scripting",
  "awaiting_script_approval",
  "prompting",
  "awaiting_prompt_approval",
  "imaging",
  "awaiting_image_approval",
  "videoing",
  "stitching",
  "complete",
  "failed",
  "failed_recoverable",
  "cancelled",
]);

export type JobStatus = z.infer<typeof JobStatusSchema>;

export const SceneStatusSchema = z.enum([
  "pending",
  "imaging",
  "videoing",
  "done",
  "failed",
]);

export type SceneStatus = z.infer<typeof SceneStatusSchema>;
