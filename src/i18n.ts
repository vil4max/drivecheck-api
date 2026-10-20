import type { Lang } from "./regions.ts";
import type { Phase } from "./status.ts";

export const LANGS: readonly Lang[] = ["en", "uk", "ru"];

export interface Strings {
  phase: Record<Phase, string>;
  stayAlert: string;
  updated: (time: string) => string;
  lastKnown: (status: string, time: string) => string;
  /** The meta line when there is no status to date: `unavailable` and `regionUnavailable`. */
  retry: Record<"unavailable" | "regionUnavailable", string>;
  nearby: (names: string) => string;
  refresh: string;
  informational: string;
  languageName: string;
  languages: string;
  source: string;
  mapCaption: (alerting: number, total: number) => string;
  minutesAgo: (n: number) => string;
  hoursAgo: (n: number) => string;
  mapAlarm: (count: number, names: string) => string;
  mapClear: string;
  mapUnavailable: string;
  mapError: string;
  opensRegions: string;
  regions: string;
  back: string;
  currentRegion: string;
  alertSection: (n: number) => string;
  otherRegions: string;
  alertShort: string;
  noAlertShort: string;
  install: string;
  hintIos: string;
  hintMac: string;
}

// Wording follows the apps' String Catalogs (regional-check `Localizable.xcstrings`); strings
// only the web needs are written in the same voice.
export const STRINGS: Record<Lang, Strings> = {
  en: {
    phase: {
      alarm: "Air Raid Alert",
      quiet: "No Alert",
      unavailable: "Unavailable",
      regionUnavailable: "Region Unavailable",
    },
    stayAlert: "Stay Alert",
    updated: (t) => `Updated ${t}`,
    lastKnown: (s, t) => `Last known: ${s} · ${t}`,
    retry: {
      unavailable: "Refresh and try again",
      regionUnavailable: "Pick another region or refresh",
    },
    nearby: (n) => `Nearby: ${n}`,
    refresh: "Refresh",
    informational: "Alert data is informational only. Do not rely on it for critical decisions.",
    languageName: "English",
    languages: "Language",
    source: "Data: Ubilling aerial alerts API",
    mapCaption: (a, t) => `${a} of ${t} regions under alert`,
    minutesAgo: (n) => `${n} min ago`,
    hoursAgo: (n) => `${n} h ago`,
    mapAlarm: (c, n) => `Alert map. Regions in alert (${c}): ${n}`,
    mapClear: "Alert map. All regions clear.",
    mapUnavailable: "Alert map. Status unavailable.",
    mapError: "Couldn't load the map.",
    opensRegions: "Opens the list of regions",
    regions: "Regions",
    back: "Status",
    currentRegion: "Current region",
    alertSection: (n) => `Alert Active · ${n}`,
    otherRegions: "Other regions",
    alertShort: "Alert",
    noAlertShort: "No Alert",
    install: "Install app",
    hintIos: "To install: Share → Add to Home Screen",
    hintMac: "To install: File → Add to Dock",
  },
  uk: {
    phase: {
      alarm: "Повітряна тривога",
      quiet: "Тривоги немає",
      unavailable: "Недоступно",
      regionUnavailable: "Регіон недоступний",
    },
    stayAlert: "Будьте уважні",
    updated: (t) => `Оновлено ${t}`,
    lastKnown: (s, t) => `Востаннє відоме: ${s} · ${t}`,
    retry: {
      unavailable: "Оновіть і спробуйте знову",
      regionUnavailable: "Оберіть інший регіон або оновіть",
    },
    nearby: (n) => `Поруч: ${n}`,
    refresh: "Оновити",
    informational:
      "Дані тривог мають інформаційний характер. Не покладайтеся на них при критичних рішеннях.",
    languageName: "Українська",
    languages: "Мова",
    source: "Дані: Ubilling aerial alerts API",
    mapCaption: (a, t) => `${a} із ${t} регіонів під тривогою`,
    minutesAgo: (n) => `${n} хв тому`,
    hoursAgo: (n) => `${n} год тому`,
    mapAlarm: (c, n) => `Карта тривог. Регіони в тривозі (${c}): ${n}`,
    mapClear: "Карта тривог. У всіх регіонах спокійно.",
    mapUnavailable: "Карта тривог. Статус недоступний.",
    mapError: "Не вдалося завантажити карту.",
    opensRegions: "Відкриває список регіонів",
    regions: "Регіони",
    back: "Статус",
    currentRegion: "Поточний регіон",
    alertSection: (n) => `Тривога · ${n}`,
    otherRegions: "Інші регіони",
    alertShort: "Тривога",
    noAlertShort: "Тривоги немає",
    install: "Установити застосунок",
    hintIos: "Щоб установити: Поділитися → на початковий екран",
    hintMac: "Щоб установити: Файл → додати в Dock",
  },
  ru: {
    phase: {
      alarm: "Воздушная тревога",
      quiet: "Тревоги нет",
      unavailable: "Недоступно",
      regionUnavailable: "Регион недоступен",
    },
    stayAlert: "Будьте внимательны",
    updated: (t) => `Обновлено ${t}`,
    lastKnown: (s, t) => `Последнее известное: ${s} · ${t}`,
    retry: {
      unavailable: "Обновите и попробуйте снова",
      regionUnavailable: "Выберите другой регион или обновите",
    },
    nearby: (n) => `Рядом: ${n}`,
    refresh: "Обновить",
    informational:
      "Данные тревог носят информационный характер. Не полагайтесь на них при критических решениях.",
    languageName: "Русский",
    languages: "Язык",
    source: "Данные: Ubilling aerial alerts API",
    mapCaption: (a, t) => `${a} из ${t} регионов под тревогой`,
    minutesAgo: (n) => `${n} мин назад`,
    hoursAgo: (n) => `${n} ч назад`,
    mapAlarm: (c, n) => `Карта тревог. Регионы в тревоге (${c}): ${n}`,
    mapClear: "Карта тревог. Во всех регионах спокойно.",
    mapUnavailable: "Карта тревог. Статус недоступен.",
    mapError: "Не удалось загрузить карту.",
    opensRegions: "Открывает список регионов",
    regions: "Регионы",
    back: "Статус",
    currentRegion: "Текущий регион",
    alertSection: (n) => `Тревога · ${n}`,
    otherRegions: "Остальные регионы",
    alertShort: "Тревога",
    noAlertShort: "Тревоги нет",
    install: "Установить приложение",
    hintIos: "Чтобы установить: Поделиться → на экран «Домой»",
    hintMac: "Чтобы установить: Файл → добавить в Dock",
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
