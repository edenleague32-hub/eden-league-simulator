// Tiny event bus for incoming DM notifications. MessagesSuite emits, the
// NotificationCenter subscribes and surfaces a bell entry + toast.
export interface IncomingDm {
  from: string;
  team: string;
  kind: "manager" | "player";
  preview: string;
}

type Listener = (m: IncomingDm) => void;
const listeners = new Set<Listener>();

export function notifyIncomingDm(m: IncomingDm) {
  for (const l of listeners) {
    try { l(m); } catch { /* ignore */ }
  }
}

export function subscribeIncomingDm(l: Listener): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
