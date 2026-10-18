import type { Lang } from "./regions";
import type { Phase } from "./status";

export const LANGS: readonly Lang[] = ["en", "uk", "ru"];

export interface Strings {
  phase: Record<Phase, string>;
  updated: (time: string) => string;
  lastKnown: (time: string) => string;
  nearby: (names: string) => string;
  refresh: string;
  informational: string;
  languageName: string;
  languages: string;
  source: string;
}

// Status wording follows the apps' String Catalogs, by way of the Android resources.
export const STRINGS: Record<Lang, Strings> = {
  en: {
    phase: {
      alarm: "Air Raid Alert",
      quiet: "No Alert",
      unavailable: "Unavailable",
      regionUnavailable: "Region Unavailable",
    },
    updated: (t) => `Updated ${t}`,
    lastKnown: (t) => `Last known · Updated ${t}`,
    nearby: (n) => `Nearby: ${n}`,
    refresh: "Refresh",
    informational: "Alert data is informational only. Do not rely on it for critical decisions.",
    languageName: "English",
    languages: "Language",
    source: "Data: Ubilling aerial alerts API",
  },
  uk: {
    phase: {
      alarm: "Повітряна тривога",
      quiet: "Тривоги немає",
      unavailable: "Недоступно",
      regionUnavailable: "Регіон недоступний",
    },
    updated: (t) => `Оновлено ${t}`,
    lastKnown: (t) => `Востаннє відоме · Оновлено ${t}`,
    nearby: (n) => `Поруч: ${n}`,
    refresh: "Оновити",
    informational:
      "Дані тривог мають інформаційний характер. Не покладайтеся на них при критичних рішеннях.",
    languageName: "Українська",
    languages: "Мова",
    source: "Дані: Ubilling aerial alerts API",
  },
  ru: {
    phase: {
      alarm: "Воздушная тревога",
      quiet: "Тревоги нет",
      unavailable: "Недоступно",
      regionUnavailable: "Регион недоступен",
    },
    updated: (t) => `Обновлено ${t}`,
    lastKnown: (t) => `Последнее известное · Обновлено ${t}`,
    nearby: (n) => `Рядом: ${n}`,
    refresh: "Обновить",
    informational:
      "Данные тревог носят информационный характер. Не полагайтесь на них при критических решениях.",
    languageName: "Русский",
    languages: "Язык",
    source: "Данные: Ubilling aerial alerts API",
  },
};

function isLang(value: string): value is Lang {
  return (LANGS as readonly string[]).includes(value);
}

/** `?lang=` wins, then the first supported `Accept-Language` entry by weight, then English. */
export function negotiateLanguage(query: string | null, acceptLanguage: string | null): Lang {
  if (query !== null && isLang(query)) return query;
  const ranked = (acceptLanguage ?? "")
    .split(",")
    .map((entry, index) => {
      const [tag = "", ...params] = entry.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return {
        base: tag.toLowerCase().split("-")[0] ?? "",
        weight: q ? Number(q.slice(2)) : 1,
        index,
      };
    })
    .filter((e) => Number.isFinite(e.weight) && e.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  return ranked.map((e) => e.base).find(isLang) ?? "en";
}
