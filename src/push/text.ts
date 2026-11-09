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
  const name = regionById(regionId)?.names[lang] ?? regionId;
  return { title: TITLE[lang](name), body: BODY[lang] };
}

/** The APNs payload: an alert and nothing else. */
export function allClearPayload(regionId: string, lang: Lang): string {
  return JSON.stringify({ aps: { alert: allClearText(regionId, lang) } });
}
