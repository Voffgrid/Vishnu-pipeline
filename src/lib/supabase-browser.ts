import { createBrowserClient } from "@supabase/ssr";
import { getPublicEnv } from "@/lib/env";

let cached: ReturnType<typeof createBrowserClient> | undefined;

export function getSupabaseBrowserClient() {
  if (cached) return cached;
  const env = getPublicEnv();
  cached = createBrowserClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
  return cached;
}
