export type Lang = "en" | "uk" | "ru";

export interface Region {
  id: string;
  /** The Ubilling `states` key. */
  apiKey: string;
  /** ISO 3166-2:UA subdivision code, as Cloudflare reports it in `request.cf.regionCode`. */
  isoCode: string;
  names: Record<Lang, string>;
}

// Names as in the iOS DriveCheckKit catalog, by way of the Android string resources.
const CATALOG: [string, string, string, string, string, string][] = [
  ["kyiv-city", "м. Київ", "30", "Kyiv", "Київ", "Киев"],
  [
    "vinnytsia",
    "Вінницька область",
    "05",
    "Vinnytsia Oblast",
    "Вінницька область",
    "Винницкая область",
  ],
  ["volyn", "Волинська область", "07", "Volyn Oblast", "Волинська область", "Волынская область"],
  [
    "dnipropetrovsk",
    "Дніпропетровська область",
    "12",
    "Dnipropetrovsk Oblast",
    "Дніпропетровська область",
    "Днепропетровская область",
  ],
  ["donetsk", "Донецька область", "14", "Donetsk Oblast", "Донецька область", "Донецкая область"],
  [
    "zhytomyr",
    "Житомирська область",
    "18",
    "Zhytomyr Oblast",
    "Житомирська область",
    "Житомирская область",
  ],
  [
    "zakarpattia",
    "Закарпатська область",
    "21",
    "Zakarpattia Oblast",
    "Закарпатська область",
    "Закарпатская область",
  ],
  [
    "zaporizhzhia",
    "Запорізька область",
    "23",
    "Zaporizhzhia Oblast",
    "Запорізька область",
    "Запорожская область",
  ],
  [
    "ivano-frankivsk",
    "Івано-Франківська область",
    "26",
    "Ivano-Frankivsk Oblast",
    "Івано-Франківська область",
    "Ивано-Франковская область",
  ],
  ["kyiv-oblast", "Київська область", "32", "Kyiv Oblast", "Київська область", "Киевская область"],
  [
    "kirovohrad",
    "Кіровоградська область",
    "35",
    "Kirovohrad Oblast",
    "Кіровоградська область",
    "Кировоградская область",
  ],
  [
    "luhansk",
    "Луганська область",
    "09",
    "Luhansk Oblast",
    "Луганська область",
    "Луганская область",
  ],
  ["lviv", "Львівська область", "46", "Lviv Oblast", "Львівська область", "Львовская область"],
  [
    "mykolaiv",
    "Миколаївська область",
    "48",
    "Mykolaiv Oblast",
    "Миколаївська область",
    "Николаевская область",
  ],
  ["odesa", "Одеська область", "51", "Odesa Oblast", "Одеська область", "Одесская область"],
  [
    "poltava",
    "Полтавська область",
    "53",
    "Poltava Oblast",
    "Полтавська область",
    "Полтавская область",
  ],
  ["rivne", "Рівненська область", "56", "Rivne Oblast", "Рівненська область", "Ровенская область"],
  ["sumy", "Сумська область", "59", "Sumy Oblast", "Сумська область", "Сумская область"],
  [
    "ternopil",
    "Тернопільська область",
    "61",
    "Ternopil Oblast",
    "Тернопільська область",
    "Тернопольская область",
  ],
  [
    "kharkiv",
    "Харківська область",
    "63",
    "Kharkiv Oblast",
    "Харківська область",
    "Харьковская область",
  ],
  [
    "kherson",
    "Херсонська область",
    "65",
    "Kherson Oblast",
    "Херсонська область",
    "Херсонская область",
  ],
  [
    "khmelnytskyi",
    "Хмельницька область",
    "68",
    "Khmelnytskyi Oblast",
    "Хмельницька область",
    "Хмельницкая область",
  ],
  [
    "cherkasy",
    "Черкаська область",
    "71",
    "Cherkasy Oblast",
    "Черкаська область",
    "Черкасская область",
  ],
  [
    "chernivtsi",
    "Чернівецька область",
    "77",
    "Chernivtsi Oblast",
    "Чернівецька область",
    "Черновицкая область",
  ],
  [
    "chernihiv",
    "Чернігівська область",
    "74",
    "Chernihiv Oblast",
    "Чернігівська область",
    "Черниговская область",
  ],
];

export const REGIONS: readonly Region[] = CATALOG.map(([id, apiKey, isoCode, en, uk, ru]) => ({
  id,
  apiKey,
  isoCode,
  names: { en, uk, ru },
}));

// The iOS NearbyRegionPolicy table (REQ-SURF-005). Kyiv city deliberately uses a wider ring than
// its administrative border, so the table is not symmetric.
const NEIGHBOURS: Record<string, string[]> = {
  "kyiv-city": ["kyiv-oblast", "chernihiv", "zhytomyr", "cherkasy", "poltava"],
  vinnytsia: [
    "zhytomyr",
    "kyiv-oblast",
    "cherkasy",
    "kirovohrad",
    "odesa",
    "chernivtsi",
    "khmelnytskyi",
  ],
  volyn: ["rivne", "lviv"],
  dnipropetrovsk: [
    "poltava",
    "kharkiv",
    "donetsk",
    "zaporizhzhia",
    "kherson",
    "mykolaiv",
    "kirovohrad",
  ],
  donetsk: ["luhansk", "kharkiv", "dnipropetrovsk", "zaporizhzhia"],
  zhytomyr: ["rivne", "khmelnytskyi", "vinnytsia", "kyiv-oblast"],
  zakarpattia: ["lviv", "ivano-frankivsk"],
  zaporizhzhia: ["donetsk", "dnipropetrovsk", "kherson"],
  "ivano-frankivsk": ["zakarpattia", "lviv", "ternopil", "chernivtsi"],
  "kyiv-oblast": ["kyiv-city", "zhytomyr", "vinnytsia", "cherkasy", "poltava", "chernihiv"],
  kirovohrad: ["vinnytsia", "cherkasy", "poltava", "dnipropetrovsk", "mykolaiv", "odesa"],
  luhansk: ["kharkiv", "donetsk"],
  lviv: ["volyn", "rivne", "ternopil", "ivano-frankivsk", "zakarpattia"],
  mykolaiv: ["odesa", "kirovohrad", "dnipropetrovsk", "kherson"],
  odesa: ["vinnytsia", "kirovohrad", "mykolaiv"],
  poltava: [
    "kyiv-oblast",
    "chernihiv",
    "sumy",
    "kharkiv",
    "dnipropetrovsk",
    "kirovohrad",
    "cherkasy",
  ],
  rivne: ["volyn", "lviv", "ternopil", "khmelnytskyi", "zhytomyr"],
  sumy: ["chernihiv", "poltava", "kharkiv"],
  ternopil: ["lviv", "rivne", "khmelnytskyi", "chernivtsi", "ivano-frankivsk"],
  kharkiv: ["sumy", "poltava", "dnipropetrovsk", "donetsk", "luhansk"],
  kherson: ["mykolaiv", "dnipropetrovsk", "zaporizhzhia"],
  khmelnytskyi: ["rivne", "zhytomyr", "vinnytsia", "chernivtsi", "ternopil"],
  cherkasy: ["vinnytsia", "kyiv-oblast", "poltava", "kirovohrad"],
  chernivtsi: ["ivano-frankivsk", "ternopil", "khmelnytskyi", "vinnytsia"],
  chernihiv: ["kyiv-oblast", "poltava", "sumy"],
};

const byId = new Map(REGIONS.map((r) => [r.id, r]));
const byIsoCode = new Map(REGIONS.map((r) => [r.isoCode, r]));

export const regionById = (id: string): Region | undefined => byId.get(id);
export const regionByIsoCode = (code: string): Region | undefined => byIsoCode.get(code);
export const DEFAULT_REGION: Region = byId.get("kyiv-city")!;

export function neighbours(region: Region): Region[] {
  return (NEIGHBOURS[region.id] ?? []).map((id) => byId.get(id)!);
}
