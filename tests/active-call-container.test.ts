/**
 * Regression: the video-call ISI-repeat bug. A live call's session is created in the signed-in
 * user's per-user container, but Tavus's cookie-less callback (/api/tavus/llm) resolves a
 * container by user id. If it used the DEFAULT container (no cookie), the session wasn't found and
 * every turn started a fresh session — re-delivering the ISI on each reply.
 *
 * These lock in the two facts the fix depends on: (1) the active-call map carries the owning userId
 * and is keyed BY that owner (so a second account can't supersede the first), and (2) a session
 * created in getContainerForUser(X) is found in getContainerForUser(X) again — and NOT in the
 * default container. So the callback MUST reload the recorded owner.
 */

import { describe, expect, it } from "vitest";
import { getContainerForUser } from "@lib/container";
import { setActiveCall, getActiveCall } from "@lib/active-call";

describe("active-call map carries the container owner, keyed by owner", () => {
  it("round-trips { sessionId, userId } under that owner's key", () => {
    setActiveCall({ sessionId: "session_abc", userId: "mahek" });
    expect(getActiveCall("mahek")).toEqual({ sessionId: "session_abc", userId: "mahek" });
  });
  it("a second owner's call does not supersede the first (no cross-user clobber)", () => {
    setActiveCall({ sessionId: "session_one", userId: "acc_one" });
    setActiveCall({ sessionId: "session_two", userId: "acc_two" });
    expect(getActiveCall("acc_one")?.sessionId).toBe("session_one");
    expect(getActiveCall("acc_two")?.sessionId).toBe("session_two");
  });
});

describe("a call session lives in its owner's container, not the default", () => {
  it("is found by getContainerForUser(owner) and NOT by the default container", async () => {
    const owner = await getContainerForUser("mahek"); // a per-user (demo-seeded) container
    const hist = await owner.conversation.start({ aiRepId: owner.demo.aiRepId, hcpId: owner.demo.hcpId });

    // The Tavus callback path: reload the SAME owner → the call's session is present.
    const sameOwner = await getContainerForUser("mahek");
    expect(await sameOwner.sessions.get(hist.id)).toBeTruthy();

    // The OLD (buggy) path: the cookie-less callback hit the default container → session absent →
    // it would have created a fresh session per turn and re-delivered the ISI.
    const fallbackDefault = await getContainerForUser(null);
    expect(await fallbackDefault.sessions.get(hist.id)).toBeFalsy();
  });
});
