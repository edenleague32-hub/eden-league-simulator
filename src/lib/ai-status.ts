// Tiny client-side event bus for AI Gateway status. UI surfaces (NotificationCenter)
// subscribe and react when an AI call reports credits exhausted or rate limiting.
export type AiStatus = "credits" | "rate_limit";

const target = typeof window !== "undefined" ? new EventTarget() : null;

export function reportAiOutcome(errMessage: unknown) {
  if (!target) return;
  const m = typeof errMessage === "string" ? errMessage : (errMessage as Error)?.message ?? "";
  if (m.includes("CREDITS")) target.dispatchEvent(new CustomEvent("ai-status", { detail: "credits" as AiStatus }));
  else if (m.includes("RATE_LIMIT")) target.dispatchEvent(new CustomEvent("ai-status", { detail: "rate_limit" as AiStatus }));
}

export function subscribeAiStatus(cb: (s: AiStatus) => void): () => void {
  if (!target) return () => {};
  const handler = (e: Event) => cb((e as CustomEvent<AiStatus>).detail);
  target.addEventListener("ai-status", handler);
  return () => target.removeEventListener("ai-status", handler);
}
