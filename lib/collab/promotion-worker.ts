import type { ExecutionStore } from "./execution-store";
import type { PromotionClaim } from "./promotion-schema";
import { abortLocalPromotion, applyLocalPromotion, localPromotionCommit, prepareLocalPromotion } from "./runtime/local-promotion";

/** Native trusted supervisor. No inference, remote fetch or user shell code. */
export async function executePromotion(store: ExecutionStore, claim: PromotionClaim, root: string, external?: AbortSignal, heartbeatMs = 5000,
  hooks: { afterPreparation?: () => Promise<void>; afterIntent?: () => Promise<void>; afterTargetUpdate?: () => Promise<void> } = {}) {
  const controller = new AbortController();
  let controlLost = false, admitted = false, gateDenied = false, pending: Promise<void> | undefined;
  let gate: Awaited<ReturnType<ExecutionStore["openPromotionGate"]>> = null;
  const cancel = () => controller.abort(), lost = () => { controlLost = true; cancel(); };
  external?.addEventListener("abort", cancel, { once: true }); if (external?.aborted) cancel();
  const heartbeat = () => pending ??= (async () => {
    try { if (!await store.heartbeatPromotion(claim)) cancel(); } catch { lost(); }
  })().finally(() => { pending = undefined; });
  const timer = setInterval(() => void heartbeat(), heartbeatMs);
  const stopHeartbeat = async () => { clearInterval(timer); if (pending) await pending; };
  const abort = async (failure: string | null) => {
    await stopHeartbeat();
    if (controlLost) return store.finishPromotion(claim, null, "promotion_control_lost");
    // Fresh signal: cancellation must create a terminal Git fence before the
    // target can be released, even when the requester's authority disappeared.
    const observation = await abortLocalPromotion(root, claim.input, AbortSignal.timeout(120_000));
    return store.finishPromotion(claim, observation, failure);
  };
  try {
    if (claim.promotionSha !== localPromotionCommit(claim.input).oid) throw new Error("promotion_identity_mismatch");
    await heartbeat();
    if (controlLost) throw new Error("promotion_control_lost");
    if (claim.mode === "reconcile") {
      const observed = await abortLocalPromotion(root, claim.input, controller.signal);
      await stopHeartbeat();
      if (controlLost) throw new Error("promotion_control_lost");
      return await store.finishPromotion(claim, observed, null);
    }
    if (controller.signal.aborted) return await abort("promotion_cancelled");
    await prepareLocalPromotion(root, claim.input, controller.signal);
    await hooks.afterPreparation?.();
    if (controller.signal.aborted) return await abort("promotion_cancelled");
    try { admitted = await store.admitPromotion(claim); } catch (error) { lost(); throw error; }
    if (!admitted) return await abort("promotion_authority_changed");
    await hooks.afterIntent?.();
    const observed = await applyLocalPromotion(root, claim.input, controller.signal, {
      beforeTargetUpdate: async () => {
        await stopHeartbeat();
        if (controller.signal.aborted) throw new Error("promotion_cancelled");
        gate = await store.openPromotionGate(claim, lost);
        if (!gate) { gateDenied = true; throw new Error("promotion_authority_changed"); }
      },
      afterTargetUpdate: hooks.afterTargetUpdate,
    });
    await stopHeartbeat();
    if (controlLost) throw new Error("promotion_control_lost");
    // TypeScript cannot see assignment from the asynchronous runtime callback.
    const activeGate = gate as Awaited<ReturnType<ExecutionStore["openPromotionGate"]>>;
    return activeGate ? await activeGate.finish(observed) : await store.finishPromotion(claim, observed, null);
  } catch (error) {
    await stopHeartbeat();
    const activeGate = gate as Awaited<ReturnType<ExecutionStore["openPromotionGate"]>>;
    await activeGate?.rollback().catch(lost);
    const message = error instanceof Error ? error.message : "";
    const failure = /^promotion_[a-z_]+$/.test(message) ? message : "promotion_outcome_unknown";
    if (!controlLost && claim.mode !== "reconcile" && (!admitted || gateDenied)) {
      try { return await abort(failure); } catch { /* Missing/corrupt Git evidence retains occupancy. */ }
    }
    return store.finishPromotion(claim, null, controlLost ? "promotion_control_lost" : failure);
  } finally {
    await stopHeartbeat(); external?.removeEventListener("abort", cancel);
  }
}
