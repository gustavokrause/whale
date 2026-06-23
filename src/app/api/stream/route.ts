import { subscribe } from "@/lib/events";

export const dynamic = "force-dynamic";

// Server-Sent Events: pushes "changed" on any data mutation so the UI refreshes
// live (mirrors krill's /api/stream). Single-process in-memory bus.
export async function GET() {
  let unsub = () => {};
  let ka: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const send = (s: string) => {
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          /* closed */
        }
      };
      send(": connected\n\n");
      unsub = subscribe((e) => send(`data: ${e}\n\n`));
      ka = setInterval(() => send(": ka\n\n"), 25000);
    },
    cancel() {
      unsub();
      if (ka) clearInterval(ka);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
