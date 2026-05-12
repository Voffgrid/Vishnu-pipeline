import OpenAI from "openai";

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export const SCRIPT_MODEL = "gpt-5.4-mini";
