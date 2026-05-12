import { describe, it, expect } from "vitest";
import { CreateJobSchema } from "@/lib/schemas";

const validJob = {
  title: "Test Job",
  script: "A".repeat(50),
  duration_seconds: 24,
  aspect_ratio: "16:9" as const,
  resolution: "720p" as const,
  auto_mode: false,
  veo_model: "veo-3-fast" as const,
};

describe("CreateJobSchema", () => {
  it("accepts a valid job", () => {
    expect(CreateJobSchema.safeParse(validJob).success).toBe(true);
  });

  it("rejects duration_seconds not a multiple of 8", () => {
    const result = CreateJobSchema.safeParse({ ...validJob, duration_seconds: 10 });
    expect(result.success).toBe(false);
  });

  it("rejects duration_seconds below 8", () => {
    const result = CreateJobSchema.safeParse({ ...validJob, duration_seconds: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects duration_seconds above 300", () => {
    const result = CreateJobSchema.safeParse({ ...validJob, duration_seconds: 304 });
    expect(result.success).toBe(false);
  });

  it("accepts duration_seconds = 300 (max, multiple of 8 rounds to 296 but 300 is not — tests boundary)", () => {
    const result = CreateJobSchema.safeParse({ ...validJob, duration_seconds: 296 });
    expect(result.success).toBe(true);
  });

  it("rejects script shorter than 50 chars", () => {
    const result = CreateJobSchema.safeParse({ ...validJob, script: "short" });
    expect(result.success).toBe(false);
  });

  it("rejects script longer than 10000 chars", () => {
    const result = CreateJobSchema.safeParse({ ...validJob, script: "A".repeat(10001) });
    expect(result.success).toBe(false);
  });

  it("rejects empty title", () => {
    const result = CreateJobSchema.safeParse({ ...validJob, title: "" });
    expect(result.success).toBe(false);
  });

  it("rejects invalid aspect_ratio", () => {
    const result = CreateJobSchema.safeParse({ ...validJob, aspect_ratio: "4:3" });
    expect(result.success).toBe(false);
  });

  it("rejects invalid veo_model", () => {
    const result = CreateJobSchema.safeParse({ ...validJob, veo_model: "veo-2" });
    expect(result.success).toBe(false);
  });

  it("accepts optional style_guide", () => {
    const result = CreateJobSchema.safeParse({ ...validJob, style_guide: "cinematic" });
    expect(result.success).toBe(true);
  });

  it("rejects style_guide longer than 1000 chars", () => {
    const result = CreateJobSchema.safeParse({ ...validJob, style_guide: "A".repeat(1001) });
    expect(result.success).toBe(false);
  });
});
