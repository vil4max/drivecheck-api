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

/**
 * Every push from this server plays this short, calm sound, which the app bundles; while a build
 * lacks the file, iOS plays the default sound instead (owner, 2026-11-10).
 */
export const PUSH_SOUND = "drivecheck.caf";
/**
 * Pushes inform, never alarm: the normal level for everyone (owner, 2026-11-10). Only a driver who
 * turned the app's urgent switch on gets the alert start through Focus (spec 004 AC-12); the
 * all-clear never does, and nothing is ever `critical`.
 */
export function interruptionLevel(urgent: boolean): "active" | "time-sensitive" {
  return urgent ? "time-sensitive" : "active";
}

/** The APNs payload: the alert with the Drive Check sound, nothing else. */
export function allClearPayload(regionId: string, lang: Lang): string {
  return JSON.stringify({ aps: { alert: allClearText(regionId, lang), sound: PUSH_SOUND } });
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

/** The alert-start notice: title only, the Drive Check sound, the device's interruption level. */
export function alertStartPayload(regionId: string, lang: Lang, urgent = false): string {
  return JSON.stringify({
    aps: {
      alert: { title: alertStartTitle(regionId, lang) },
      sound: PUSH_SOUND,
      "interruption-level": interruptionLevel(urgent),
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
