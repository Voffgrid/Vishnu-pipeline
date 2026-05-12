import { inngest } from "@/inngest/client";

export const helloWorld = inngest.createFunction(
  {
    id: "hello-world",
    triggers: [{ event: "demo/hello" }],
  },
  async ({ event, step }) => {
    await step.run("log-hello", async () => {
      console.log("hello world", { eventData: event.data });
      return { greeting: "hello world", at: new Date().toISOString() };
    });

    return { ok: true };
  }
);
