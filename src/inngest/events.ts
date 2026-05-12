// Typed event map for the Vishnu Inngest pipeline.
// All events carry only the minimum data needed — the worker fetches full
// job/scene rows from the DB rather than passing large payloads through events.

export type Events = {
  "job/created":         { data: { jobId: string } };
  "job/stage-1-start":  { data: { jobId: string } };
  "job/stage-2-needed": { data: { jobId: string } };
  "job/stage-3-needed": { data: { jobId: string } };
  "job/stage-4-needed": { data: { jobId: string } };
  "job/stage-5-needed": { data: { jobId: string } };
  "job/approved":       { data: { jobId: string; stage: string } };
  "job/rejected":       { data: { jobId: string; stage: string } };
  "job/restitch-needed":{ data: { jobId: string } };
};
