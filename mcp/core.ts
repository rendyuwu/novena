// The MCP server's own logic, apart from the stdio wiring so the unit tests can call it: reading the roster file the
// player points to, and finding operators by a game effect (a term such as Fear) with what an owned operator can use now.
import * as z from "zod/v4";
import { skillUnlock, stateLabel } from "../src/lib/build";
import { CLASS_NAMES } from "../src/lib/format";
import { parseRoster, ROSTER_APP, type Imported } from "../src/lib/importers";
import type { Account, PlanTarget, Prefs, RosterOp } from "../src/state";
import type { Meta, OpDetail, OpIndex, Server } from "../src/types";

export interface Player { account: Account; targets: PlanTarget[]; prefs: Prefs; format: string }

const DEFAULT_PREFS: Prefs = { daily: 240, excluded: [], useDepot: true };

const Backup = z.object({ app: z.enum(["novena", "doctors-toolkit"]), data: z.record(z.string(), z.unknown()) });
// depot and savings may be missing (a manual account has no savings); zod 4 rejects a missing z.unknown() key
const BackupAccount = z.object({ ops: z.record(z.string(), z.unknown()), depot: z.unknown().optional(), savings: z.unknown().optional() });
const Targets = z.array(z.object({ id: z.string(), text: z.string() }));
const BackupPrefs = z.object({ daily: z.number(), excluded: z.array(z.string()) }).partial();

const toAccount = (im: Imported): Account => ({ ops: im.ops, depot: im.depot || {}, savings: im.savings, updated: 0, snapshots: [] });

/** Throws when a roster file names another server (backups carry none). Checked before the data fetch in server.ts,
 *  so the diagnosis isn't hidden behind a missing-file error. */
export function assertServer(json: unknown, server: Server): void {
  const said = typeof json === "object" && json !== null && "server" in json && typeof json.server === "string" ? json.server : undefined;
  if (said && said !== server) throw new Error(`This roster file is from the ${said.toUpperCase()} server; set NOVENA_SERVER=${said}.`);
}

/** The player's account from a roster file: a Settings backup (with its Planner targets and prefs) or anything the
 *  importer reads. */
export function readPlayer(json: unknown, ops: OpIndex[], server: Server): Player {
  assertServer(json, server);
  const backup = Backup.safeParse(json);
  if (backup.success) {
    const { data } = backup.data;
    const acc = BackupAccount.safeParse(data[`account.${server}`]);
    if (!acc.success) throw new Error(`This backup has no ${server.toUpperCase()} roster.`);
    // the backup's operators go through the importer's roster-file path, so they're sanitised exactly like an export
    const im = parseRoster({ app: ROSTER_APP, ops: Object.values(acc.data.ops), depot: acc.data.depot, savings: acc.data.savings }, ops);
    const targets = data[`targets.${server}`];
    return {
      account: toAccount(im), targets: targets === undefined ? [] : Targets.parse(targets),
      prefs: { ...DEFAULT_PREFS, ...BackupPrefs.parse(data[`prefs.${server}`] ?? {}) }, format: "Novena backup",
    };
  }
  const im = parseRoster(json, ops);
  if (im.server && im.server !== server) throw new Error(`This roster file is from the ${im.server.toUpperCase()} server; set NOVENA_SERVER=${im.server}.`);
  return { account: toAccount(im), targets: [], prefs: DEFAULT_PREFS, format: im.format };
}

/** A term's tag from its name as the game writes it ("Fear", battle terms first) or the tag itself ("ba.fear"). */
export function resolveEffect(terms: Meta["terms"], effect: string): string {
  const e = effect.trim();
  if (Object.hasOwn(terms, e)) return e;
  const keys = Object.keys(terms).filter((k) => terms[k].name.toLowerCase() === e.toLowerCase());
  const tag = keys.find((k) => k.startsWith("ba.")) ?? keys[0];
  if (tag) return tag;
  const names = [...new Set(Object.keys(terms).filter((k) => k.startsWith("ba.")).map((k) => terms[k].name))].sort().join(", ");
  throw new Error(`No game term called "${effect}". Battle terms: ${names}.`);
}

/** Where an operator mentions the effect, the sentence it's in, and what it needs; `usable` only with the player's copy. */
export interface Hit { where: string; text: string; needs?: string; usable?: boolean }

interface Variant { elite: number; level: number; pot: number; desc: string }

const carries = (html: string, tag: string) => html.includes(`data-t="${tag}"`);
const sentences = (html: string, tag: string) => html.split(/\n|;\s+|\.\s+/)
  .filter((s) => carries(s, tag))
  .map((s) => s.replace(/<[^>]+>/g, "").trim())
  .join(" … ");
// talent and trait `pot` is the game's 0-based rank: pot n needs P(n+1)
const applies = (r: RosterOp, v: Variant) => (r.elite > v.elite || (r.elite === v.elite && r.level >= v.level)) && r.pot - 1 >= v.pot;
const needsOf = (v: Variant) =>
  [v.elite || v.level > 1 ? `E${v.elite}` + (v.level > 1 ? ` Lv${v.level}` : "") : "", v.pot ? `P${v.pot + 1}` : ""]
    .filter(Boolean).join(" ") || undefined;

/** A trait or talent slot: the variant the player has now, else the last one that carries the tag. */
function variantHit(where: string, vs: Variant[], tag: string, r?: RosterOp): Hit | null {
  const first = vs.find((v) => carries(v.desc, tag));
  if (!first) return null;
  const rev = [...vs].reverse(); // ES2022 has no findLast
  const now = r && rev.find((v) => applies(r, v));
  const usable = r ? !!now && carries(now.desc, tag) : undefined;
  const last = rev.find((v) => carries(v.desc, tag)) ?? first;
  return { where, text: sentences(usable && now ? now.desc : last.desc, tag), needs: needsOf(first), usable };
}

export function effectHits(d: OpDetail, tag: string, r?: RosterOp): Hit[] {
  const hits: (Hit | null)[] = [
    variantHit("Trait", [{ elite: 0, level: 1, pot: 0, desc: d.desc }, ...(d.trait ?? []).map((t) => ({ ...t, level: 1 }))], tag, r),
    ...d.talents.map((vs, j) => variantHit(`Talent ${j + 1} (${vs[0].name})`, vs, tag, r)),
  ];
  // skill level index 0-6 is SL1-7, 7-9 M1-M3; a tag can appear above SL1 (char_1048_orchd2 S1 has Stun from SL4)
  d.skills.forEach((s, i) => {
    const first = s.levels.findIndex((l) => carries(l.desc, tag));
    if (first < 0) return;
    const e = skillUnlock(i);
    const at = r ? Math.min(r.skillLevel - 1 + (r.skillLevel >= 7 ? r.masteries[i] || 0 : 0), s.levels.length - 1) : -1;
    const usable = r ? r.elite >= e && at >= first : undefined;
    const needs = [e ? `E${e}` : "", first ? (first < 7 ? `SL${first + 1}` : `M${first - 6}`) : ""].filter(Boolean).join(" ") || undefined;
    hits.push({ where: `S${i + 1} ${s.name}`, text: sentences(usable ? s.levels[at].desc : s.levels[s.levels.length - 1].desc, tag), needs, usable });
  });
  for (const m of d.modules) {
    const texts = m.stages.map((st) => [...st.trait, ...st.talents.map((t) => t.desc)].join("\n"));
    const k = texts.findIndex((t) => carries(t, tag));
    if (k < 0) continue;
    const have = Math.min(r?.modules[m.letter] || 0, texts.length);
    const usable = r ? have > 0 && carries(texts[have - 1], tag) : undefined;
    hits.push({ where: `Module ${m.letter} (${m.name})`, text: sentences(usable ? texts[have - 1] : texts[k], tag), needs: `Module ${m.letter} stage ${k + 1}`, usable });
  }
  return hits.filter((h): h is Hit => h !== null);
}

/** Operators on the server (only the player's, with a roster) that mention the effect: usable first, then by rarity. */
export function findByEffect(ops: OpIndex[], details: Map<string, OpDetail>, tag: string, server: Server, roster: Record<string, RosterOp> | null) {
  const found = ops.flatMap((o) => {
    const r: RosterOp | undefined = roster?.[o.id];
    const d = details.get(o.id);
    // CN-only operators sit in the en/jp/kr files with CN text
    if (!o.on.includes(server) || (roster && !r) || !d) return [];
    const hits = effectHits(d, tag, r);
    return hits.length ? [{ id: o.id, name: o.name, rarity: o.rarity, cls: CLASS_NAMES[o.cls] ?? o.cls, owned: r && `${stateLabel(r)}, P${r.pot}`, hits }] : [];
  });
  found.sort((a, b) => Number(b.hits.some((h) => h.usable)) - Number(a.hits.some((h) => h.usable)) || b.rarity - a.rarity || a.name.localeCompare(b.name));
  // a fixed cap of 50 keeps answers small; add rarity/class filters if lists outgrow it
  return { effect: tag, total: found.length, operators: found.slice(0, 50) };
}
