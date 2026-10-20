import type { Snapshot } from "./feed.ts";
import type { Glyph } from "./glyphs.ts";
import { STRINGS } from "./i18n.ts";
import { type Lang, REGIONS, type Region } from "./regions.ts";
import { statusView } from "./status.ts";

/** The status colour, as iOS `StatusAccent`; theme.ts maps it to the palette. */
export type Accent = "clear" | "alert" | "caution" | "stale" | "unavailable";

/** Everything the Status page shows, computed once for the server render and the client patch. */
export interface StatusModel {
  lang: Lang;
  regionId: string;
  regionName: string;
  title: string;
  accent: Accent;
  symbol: Glyph;
  meta: string;
  nearby: string | null;
  mapCaption: string | null;
  mapLabel: string;
  documentTitle: string;
}

export function kyivClock(epochMs: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Kyiv",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(epochMs);
}

/** iOS `NearbyAlertsLine`: at most two names, then "+N". */
function nearbyNames(names: string[]): string {
  const shown = names.slice(0, 2).join(", ");
  return names.length > 2 ? `${shown} +${names.length - 2}` : shown;
}

function age(lang: Lang, ms: number): string {
  const s = STRINGS[lang];
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes < 60 ? s.minutesAgo(minutes) : s.hoursAgo(Math.floor(minutes / 60));
}

export function statusModel(
  snapshot: Snapshot | null,
  region: Region,
  lang: Lang,
  now: number,
  mapFetchedAt: number | null,
): StatusModel {
  const s = STRINGS[lang];
  const view = statusView(snapshot, region, now);
  let accent: Accent;
  let symbol: Glyph;
  let title = s.phase[view.phase];
  if (view.phase === "alarm") {
    // A known alarm stays red even when old (iOS, REQ-REFRESH-006).
    [accent, symbol] = ["alert", "exclamation"];
  } else if (view.phase === "quiet" && view.stale) {
    [accent, symbol] = ["stale", "clock"];
  } else if (view.phase === "quiet" && view.surrounded) {
    [accent, symbol, title] = ["caution", "triangle", s.stayAlert];
  } else if (view.phase === "quiet") {
    [accent, symbol] = ["clear", "check"];
  } else {
    [accent, symbol] = ["unavailable", "question"];
  }

  let meta: string;
  if (view.phase === "unavailable" || view.phase === "regionUnavailable") {
    meta = s.retry[view.phase];
  } else {
    const time = kyivClock(view.checkedAt!);
    meta = view.stale ? s.lastKnown(title, time) : s.updated(time);
  }

  const showNearby = (view.phase === "alarm" || view.phase === "quiet") && view.nearby.length > 0;
  const alerting = snapshot === null ? [] : REGIONS.filter((r) => inAlarm(snapshot, r));
  let mapCaption: string | null = null;
  let mapLabel = s.mapUnavailable;
  if (snapshot !== null) {
    mapCaption = s.mapCaption(alerting.length, REGIONS.length);
    if (mapFetchedAt !== null) mapCaption += ` · ${age(lang, now - mapFetchedAt)}`;
    mapLabel =
      alerting.length > 0
        ? s.mapAlarm(alerting.length, alerting.map((r) => r.names[lang]).join(", "))
        : s.mapClear;
  }

  const regionName = region.names[lang];
  return {
    lang,
    regionId: region.id,
    regionName,
    title,
    accent,
    symbol,
    meta,
    nearby: showNearby ? s.nearby(nearbyNames(view.nearby.map((r) => r.names[lang]))) : null,
    mapCaption,
    mapLabel,
    documentTitle: `${title} — ${regionName} · Drive Check`,
  };
}

function inAlarm(snapshot: Snapshot, region: Region): boolean {
  return snapshot.feed.states[region.apiKey]?.alertnow === true;
}

export interface RegionRow {
  id: string;
  name: string;
  current: boolean;
  /** `on` under alert, `off` quiet, `unknown` missing from the feed. */
  state: "on" | "off" | "unknown";
}

export interface RegionsModel {
  lang: Lang;
  current: { name: string; accent: Accent; pill: string | null };
  alerting: RegionRow[];
  others: RegionRow[];
}

/** iOS `RegionListView`: the current region first, then regions under alert, then the rest. */
export function regionsModel(snapshot: Snapshot | null, region: Region, lang: Lang): RegionsModel {
  const s = STRINGS[lang];
  const rows: RegionRow[] = REGIONS.map((r) => {
    const state = snapshot?.feed.states[r.apiKey];
    return {
      id: r.id,
      name: r.names[lang],
      current: r.id === region.id,
      state: state === undefined ? "unknown" : state.alertnow ? "on" : "off",
    };
  });
  const own = rows.find((r) => r.current)!;
  return {
    lang,
    current: {
      name: own.name,
      accent: own.state === "on" ? "alert" : own.state === "off" ? "clear" : "unavailable",
      pill: own.state === "on" ? s.alertShort : own.state === "off" ? s.noAlertShort : null,
    },
    alerting: rows.filter((r) => r.state === "on"),
    others: rows.filter((r) => r.state !== "on"),
  };
}
