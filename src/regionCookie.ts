import { type Region, regionById } from "./regions.ts";

/** The visitor's chosen region lives only in this cookie, never on the server (REQ-WEB-004). */
export const REGION_COOKIE = "region";
const ONE_YEAR_S = 365 * 24 * 60 * 60;

/** The region named by the `region` cookie, when it is a catalog id; anything else is ignored. */
export function parseRegionCookie(header: string | null): Region | undefined {
  for (const pair of (header ?? "").split(";")) {
    const [name, value] = pair.trim().split("=", 2);
    if (name === REGION_COOKIE && value !== undefined) return regionById(value);
  }
  return undefined;
}

export function regionCookie(id: string): string {
  return `${REGION_COOKIE}=${id}; Path=/; Max-Age=${ONE_YEAR_S}; SameSite=Lax; Secure`;
}
