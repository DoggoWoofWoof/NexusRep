/**
 * Server-side convenience for the activity log: stamps the CURRENT signed-in user automatically
 * (from the session cookie) so route instrumentation reads as one line. Fire-and-forget — never
 * awaited on the request path, never throws (observability must not break the flow it observes).
 *
 * The pure store lives in @modules/activity; this wrapper just adds request identity, which is why it
 * sits in lib (it reaches into next/headers via currentUserId) rather than the dependency-free module.
 */

import { currentUserId } from "@lib/container";
import { recordActivity, type ActivityInput } from "@modules/activity";

export async function logServerActivity(input: Omit<ActivityInput, "user" | "surface"> & { user?: string }): Promise<void> {
  try {
    const user = input.user ?? (await currentUserId()) ?? "anon";
    recordActivity({ ...input, user, surface: "server" });
  } catch {
    /* never break the caller */
  }
}
