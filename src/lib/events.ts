// whale — in-memory pub/sub for live UI updates (SSE). Single-process (next start),
// like krill's broadcast. Any data mutation emits "changed"; the client refreshes.
import { EventEmitter } from "node:events";

const bus = new EventEmitter();
bus.setMaxListeners(0);

export const broadcast = (event = "changed") => bus.emit("event", event);

export function subscribe(fn: (event: string) => void): () => void {
  bus.on("event", fn);
  return () => bus.off("event", fn);
}
