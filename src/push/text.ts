import { type Lang, regionById } from "../regions.ts";

export interface AllClearText {
  title: string;
  body: string;
}

// The owner's wording, 2026-11-09 (spec 003, REQ-PUSHAPI-006); the region name is the catalog's.
const TITLE: Record<Lang, (region: string) => string> = {
  en: (region) => `All clear: ${region}`,
  uk: (region) => `Відбій тривоги: ${region}`,
  ru: (region) => `Отбой тревоги: ${region}`,
};
const BODY: Record<Lang, string> = {
  en: "The air alert has ended.",
  uk: "Повітряна тривога закінчилась.",
  ru: "Воздушная тревога окончена.",
};

export function allClearText(regionId: string, lang: Lang): AllClearText {
  return { title: TITLE[lang](regionName(regionId, lang)), body: BODY[lang] };
}

/** The APNs payload: the alert with the default sound (owner, 2026-11-10), nothing else. */
export function allClearPayload(regionId: string, lang: Lang): string {
  return JSON.stringify({ aps: { alert: allClearText(regionId, lang), sound: "default" } });
}

// The owner's wording at the app's plan gate, 2026-11-10 (spec 004, REQ-PUSHAPI-012); title only.
const ALERT_START: Record<Lang, (region: string) => string> = {
  en: (region) => `Air raid alert: ${region}`,
  uk: (region) => `Повітряна тривога: ${region}`,
  ru: (region) => `Воздушная тревога: ${region}`,
};

export function alertStartTitle(regionId: string, lang: Lang): string {
  return ALERT_START[lang](regionName(regionId, lang));
}

/** The alert-start notice: title only, the default sound, time-sensitive (owner, 2026-11-10). */
export function alertStartPayload(regionId: string, lang: Lang): string {
  return JSON.stringify({
    aps: {
      alert: { title: alertStartTitle(regionId, lang) },
      sound: "default",
      "interruption-level": "time-sensitive",
    },
  });
}

export function regionName(regionId: string, lang: Lang): string {
  return regionById(regionId)?.names[lang] ?? regionId;
}

// The app's `StatusSourceLabel` and its String Catalog (`status.source.alertFeed`, `.external`).
const SOURCE_LABELS: Record<Lang, { alertFeed: string; external: string }> = {
  en: { alertFeed: "Alert feed", external: "External feed" },
  uk: { alertFeed: "Стрічка тривог", external: "Зовнішнє джерело" },
  ru: { alertFeed: "Лента тревог", external: "Внешний источник" },
};

/** The source name the app writes into the Live Activity, by the app's own rule. */
export function sourceLabel(source: string, lang: Lang): string {
  const normalized = source.toLowerCase();
  const isAlertFeed = ["mørk", "mork", "skogen"].some((part) => normalized.includes(part));
  return isAlertFeed ? SOURCE_LABELS[lang].alertFeed : SOURCE_LABELS[lang].external;
}
