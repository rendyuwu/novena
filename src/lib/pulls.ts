// Pull planner arithmetic (after ako's pulls.py): what savings buy now, steady income, and pulls by a banner's date.
import type { Account } from "../state";
import type { UpcomingFile } from "../types";

export type Savings = NonNullable<Account["savings"]>;

export const ORUNDUM_PER_PULL = 600;
export const ORUNDUM_PER_PRIME = 180;
const DAILY = 100; // daily missions
const WEEKLY = 500 + 1800; // weekly missions + Annihilation cap
const CARD = 200; // monthly card, per day
const DAY = 86400_000;

/** Steady Orundum a day: daily and weekly missions, Annihilation, and the monthly card while it runs. */
export const orundumPerDay = (sv: Savings) => DAILY + WEEKLY / 7 + (sv.card ? CARD : 0);
/** Pulls the savings buy now; Originite Prime counted only when asked. */
export const pullsNow = (sv: Savings, withPrime: boolean) => (sv.orundum + (withPrime ? sv.prime * ORUNDUM_PER_PRIME : 0)) / ORUNDUM_PER_PULL + sv.permits;
/** Banners from now on; an estimate up to 3 days past still counts. */
export const bannersAhead = (up: UpcomingFile, now = Date.now()) => up.banners.filter((b) => new Date(b.eta).getTime() > now - 3 * DAY);
/** Pulls by `eta` if everything is saved until then. */
export function pullsBy(sv: Savings, eta: string, now = Date.now()): number {
  const days = Math.max(0, (new Date(eta).getTime() - now) / DAY);
  return pullsNow(sv, false) + (days * orundumPerDay(sv)) / ORUNDUM_PER_PULL;
}
