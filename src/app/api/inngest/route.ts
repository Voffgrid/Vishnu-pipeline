import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { helloWorld }       from "@/inngest/functions/hello";
import { onJobCreated }     from "@/inngest/functions/job-created";
import { runStage1Script }  from "@/inngest/functions/stage-1-script";
import { runStage2Prompts } from "@/inngest/functions/stage-2-prompts";
import { runStage3Images }  from "@/inngest/functions/stage-3-images";
import { runStage4Videos }  from "@/inngest/functions/stage-4-videos";
import { runStage5Stitch }  from "@/inngest/functions/stage-5-stitch";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    helloWorld,
    onJobCreated,
    runStage1Script,
    runStage2Prompts,
    runStage3Images,
    runStage4Videos,
    runStage5Stitch,
  ],
});
