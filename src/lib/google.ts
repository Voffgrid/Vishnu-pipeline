import { GoogleGenAI } from "@google/genai";

export const google = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

// Maps the DB veo_model values to actual Gemini model IDs.
export const VEO_MODEL_MAP: Record<string, string> = {
  "veo-3-fast": "veo-3.0-fast-generate-001",
  "veo-3":      "veo-3.0-generate-001",
};
