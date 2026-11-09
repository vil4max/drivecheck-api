import type { Outcome } from "./apns.ts";
import type { OutboxItem, PushStore } from "./registry.ts";

/** 50 subrequests per invocation on Free, less the feed request and its retry, less a margin. */
export const BATCH_SIZE = 45;
/** Cloudflare lets 6 connections wait for response headers at once. */
export const PARALLEL = 6;

/**
 * Sends up to `BATCH_SIZE` queued pushes, `PARALLEL` at a time (REQ-PUSHAPI-004). Each row is
 * deleted before its request, so an alarm retried after a crash cannot send it twice; a token
 * APNs calls gone is deleted with its device.
 */
export async function sendBatch(
  store: PushStore,
  send: (item: OutboxItem) => Promise<Outcome>,
  log: (message: string) => void,
): Promise<void> {
  const items = store.takeOutbox(BATCH_SIZE);
  const outcomes: Record<Outcome, number> = { sent: 0, "drop-token": 0, keep: 0 };
  for (let start = 0; start < items.length; start += PARALLEL) {
    const chunk = items.slice(start, start + PARALLEL);
    for (const item of chunk) store.deleteOutbox(item.id);
    const results = await Promise.all(chunk.map((item) => send(item).catch(() => "keep" as const)));
    results.forEach((outcome, index) => {
      outcomes[outcome] += 1;
      if (outcome === "drop-token") store.deleteDevice(chunk[index]!.token);
    });
  }
  if (items.length > 0) {
    log(
      `push batch: ${outcomes.sent} sent, ${outcomes["drop-token"]} tokens deleted, ${outcomes.keep} failed`,
    );
  }
}
