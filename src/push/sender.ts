import type { Snapshot } from "../feed.ts";
import { regionById } from "../regions.ts";
import { isStale } from "../status.ts";
import type { Outcome } from "./apns.ts";
import type { OutboxItem, PushStore } from "./registry.ts";

/** 50 subrequests per invocation on Free, less the feed request and its retry, less a margin. */
export const BATCH_SIZE = 45;
/** Cloudflare lets 6 connections wait for response headers at once. */
export const PARALLEL = 6;

export type Send = (item: OutboxItem) => Promise<Outcome>;

export interface SendOptions {
  /** How many pushes this call may send; the update walk takes what the outbox leaves. */
  limit?: number;
  /** The last fresh snapshot the alarm processed: the state a Live Activity push carries. */
  latest?: Snapshot | null;
  now?: () => number;
}

/** One region of the 5-minute update walk (option B): records after `after` are still due. */
export interface WalkEntry {
  region: string;
  after: string;
}

/** What an answer does to the stored tokens (REQ-PUSHAPI-005, REQ-PUSHAPI-011). */
function settle(store: PushStore, item: OutboxItem, outcome: Outcome): void {
  if (item.kind === "allclear" || item.kind === "alertstart") {
    if (outcome === "drop-token") store.deleteDevice(item.key);
  } else if (item.kind === "la-start") {
    if (outcome === "drop-token") store.deleteLiveActivity(item.key);
  } else if (item.token !== null && (item.kind === "la-end" || outcome === "drop-token")) {
    // An end is tried once, whatever the answer, so a failing end is not repeated every poll.
    store.clearActivityToken(item.key, item.token);
  }
}

/** Sends `items` `PARALLEL` at a time and settles each answer; returns the outcome counts. */
async function sendAll(
  store: PushStore,
  items: OutboxItem[],
  send: Send,
  beforeEach: (item: OutboxItem) => void,
): Promise<Record<Outcome, number>> {
  const outcomes: Record<Outcome, number> = { sent: 0, "drop-token": 0, keep: 0 };
  for (let start = 0; start < items.length; start += PARALLEL) {
    const chunk = items.slice(start, start + PARALLEL);
    for (const item of chunk) beforeEach(item);
    const results = await Promise.all(chunk.map((item) => send(item).catch(() => "keep" as const)));
    results.forEach((outcome, index) => {
      outcomes[outcome] += 1;
      settle(store, chunk[index]!, outcome);
    });
  }
  return outcomes;
}

/**
 * A queued row as it will be sent, or null to drop it unsent: a Live Activity push needs the
 * feed state, an activity token cleared since queueing has nothing to reach, and a move needs a
 * fresh state of its new region (AC-10) to become a red update or the green end.
 */
function resolve(item: OutboxItem, latest: Snapshot | null, now: number): OutboxItem | null {
  if (item.kind === "allclear" || item.kind === "alertstart") return item;
  if (latest === null || item.token === null) return null;
  if (item.kind !== "la-move") return { ...item, snapshot: latest };
  const apiKey = regionById(item.region)?.apiKey;
  const state = apiKey === undefined ? undefined : latest.feed.states[apiKey];
  if (state === undefined || isStale(latest, now)) return null;
  return { ...item, kind: state.alertnow ? "la-update" : "la-end", snapshot: latest };
}

/**
 * Sends up to `limit` queued pushes, `PARALLEL` at a time (REQ-PUSHAPI-004). Each row is deleted
 * before its request, so an alarm retried after a crash cannot send it twice. Returns the number
 * of rows taken, sent or dropped.
 */
export async function sendBatch(
  store: PushStore,
  send: Send,
  log: (message: string) => void,
  options: SendOptions = {},
): Promise<number> {
  const now = (options.now ?? Date.now)();
  const taken = store.takeOutbox(options.limit ?? BATCH_SIZE);
  const items: OutboxItem[] = [];
  for (const row of taken) {
    const item = resolve(row, options.latest ?? null, now);
    if (item === null) store.deleteOutbox(row.id);
    else items.push(item);
  }
  const outcomes = await sendAll(store, items, send, (item) => store.deleteOutbox(item.id));
  if (items.length > 0) {
    log(
      `push batch: ${outcomes.sent} sent, ${outcomes["drop-token"]} tokens deleted, ${outcomes.keep} failed`,
    );
  }
  return taken.length;
}

/**
 * Sends the 5-minute updates (AC-3) straight from the records, `limit` at most, walking `walk`
 * in key order; finished regions leave the walk. Returns the number of updates sent.
 */
export async function sendUpdates(
  store: PushStore,
  walk: WalkEntry[],
  send: Send,
  log: (message: string) => void,
  options: SendOptions = {},
): Promise<number> {
  const latest = options.latest ?? null;
  if (latest === null) {
    walk.length = 0;
    return 0;
  }
  let remaining = options.limit ?? BATCH_SIZE;
  const items: OutboxItem[] = [];
  while (remaining > 0 && walk.length > 0) {
    const entry = walk[0]!;
    const rows = store.heldLiveActivities(entry.region, entry.after, remaining);
    for (const row of rows) {
      items.push({
        id: 0,
        kind: "la-update",
        key: row.startToken,
        token: row.activityToken,
        region: row.region,
        env: row.env,
        lang: row.lang,
        createdAt: 0,
        // An update carries no alert, so the switch does not apply.
        urgent: false,
        snapshot: latest,
      });
    }
    remaining -= rows.length;
    if (rows.length > 0) entry.after = rows[rows.length - 1]!.startToken;
    if (remaining > 0) walk.shift();
  }
  const outcomes = await sendAll(store, items, send, () => {});
  if (items.length > 0) {
    log(`push updates: ${outcomes.sent} sent, ${outcomes["drop-token"]} tokens cleared`);
  }
  return items.length;
}
