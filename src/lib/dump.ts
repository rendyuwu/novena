// The Sanity Dump's calculation (src/pages/Dump.tsx shows it): demand from the built plan or the Planner targets plus
// community builds, paid once from the depot, and the farming planner's runs for today's sanity.
import { communityState, goalStates, rosterStates } from "./account";
import { add, EXP, LMD, sanity, stateCost, type Cost, type CostData, type OpState } from "./costs";
import { Stock } from "./crafting";
import { plan as farmPlan, schedule, type Day } from "./farming";
import type { PlanResult } from "./planner";
import { gameDay } from "./time";
import type { Account, PlanTarget, Prefs } from "../state";
import type { ItemsFile, Meta, OpIndex, Server, StagesFile, UsageFile } from "../types";

const OPERATORS = 40;
const DEEP_RATE = 0.3;
export const ANNI_SANITY = 25;

export interface Lacking { id: string; held: number; need: number; short: number; coverage: number; near: boolean; value: number }

/** What the Dump works from. `plan`: the built plan, which replaces the targets as demand; `today`: sanity to spend today. */
export interface DumpInput {
  server: Server; ops: OpIndex[]; usage: UsageFile; costs: Record<string, CostData>; stg: StagesFile; items: ItemsFile; meta: Meta;
  account: Account; targets: PlanTarget[]; plan: PlanResult | null; prefs: Prefs; today: number;
}

/** The Dump's answer. `farmed`: what today's runs aim at; `days`: the week's schedule, today first; `depth`: "builds", or
 *  "deep" when the community builds were nearly covered; `near`: demand includes the plan or targets; `plan`: a built plan was used. */
export interface DumpResult {
  lacking: Lacking[]; stock: Lacking[]; runs: Day["runs"]; farmed: Lacking[]; days: Day[]; depth: string; counted: number; near: boolean;
  unlocks: { code: string; saves: number }[]; lmd: number; exp: number; plan: boolean;
}

function demandOf({ ops, usage, costs, meta, account, targets, plan }: DumpInput, deep: boolean): { near: Cost; far: Cost; counted: number; covered: Set<string> } {
  const byId = new Map(ops.map((o) => [o.id, o]));
  const states = rosterStates(account, costs);
  const near: Cost = {};
  const covered = new Set<string>();
  if (plan) {
    for (const st of [...plan.goals, ...plan.steps]) { add(near, st.cost); covered.add(st.id); }
  } else {
    const goals = goalStates(targets, states, costs, byId);
    for (const [id, to] of Object.entries(goals)) { add(near, stateCost(costs[id], meta.const, states[id], to, !!byId.get(id)?.patch)); covered.add(id); }
  }
  const owned = Object.keys(states).filter((id) => !covered.has(id) && byId.has(id))
    .sort((a, b) => (usage.ops[b]?.score || 0) - (usage.ops[a]?.score || 0));
  const far: Cost = {};
  let counted = 0;
  for (const id of deep ? owned : owned.slice(0, OPERATORS)) {
    const op = byId.get(id)!;
    const from = states[id];
    let to: OpState | null = communityState(op, usage, costs[id], from);
    if (deep && op.rarity >= 4) {
      const inv = usage.ops[id]?.inv;
      const base = to || from;
      const masteries = base.masteries.map((m, i) => ((inv?.m3[String(i + 1)] || 0) >= DEEP_RATE ? 3 : m));
      const modules = { ...base.modules };
      for (const [k, r] of Object.entries(inv?.mod3 || {})) if (r >= DEEP_RATE && k in modules) modules[k] = 3;
      if (masteries.some((m, i) => m > base.masteries[i]) || Object.keys(modules).some((k) => modules[k] > base.modules[k])) {
        to = { ...base, elite: 2, level: Math.max(base.elite === 2 ? base.level : 1, costs[id].modules.find((m) => modules[m.letter] > (base.modules[m.letter] || 0))?.unlock.level || 1), skillLevel: masteries.some((m) => m) ? 7 : base.skillLevel, masteries, modules };
      }
    }
    if (!to) continue;
    const c = stateCost(costs[id], meta.const, from, to, !!op.patch);
    if (Object.keys(c).length) { add(far, c); counted++; }
  }
  return { near, far, counted, covered };
}

export async function dump(input: DumpInput): Promise<DumpResult> {
  const { server, stg, items, account, prefs, today } = input;
  const depot = account.depot;
  const pay = (need: Cost) => {
    const stock = new Stock(depot, items.recipes);
    const short: Cost = {};
    for (const [id, n] of Object.entries(need)) Object.assign(short, stock.pay({ [id]: n }));
    return short;
  };
  let d = demandOf(input, false);
  let demand = add({ ...d.near }, d.far);
  let short = pay(demand);
  let depth = "builds";
  if (sanity(short, items.values) < today) {
    d = demandOf(input, true);
    demand = add({ ...d.near }, d.far);
    short = pay(demand);
    depth = "deep";
  }
  const nearShort = pay(d.near);
  const farmable = (id: string) => ["material", "chip", "skill"].includes(items.items[id]?.group || "");
  const row = (id: string, n: number): Lacking => ({
    id, held: depot[id] || 0, need: Math.ceil(demand[id] || 0), short: Math.ceil(n),
    coverage: demand[id] ? (depot[id] || 0) / demand[id] : 1, near: (nearShort[id] || 0) > 0, value: (items.values[id] || 0) * n,
  });
  const lacking = Object.entries(short).filter(([id]) => farmable(id)).map(([id, n]) => row(id, n))
    .sort((a, b) => Number(!a.near) - Number(!b.near) || Math.round(a.coverage * 100) - Math.round(b.coverage * 100) || b.value - a.value);
  const stock = Object.keys(demand).filter((id) => farmable(id) && !short[id] && items.items[id]?.group === "material" && items.items[id].rarity >= 3)
    .map((id) => row(id, 0)).sort((a, b) => a.coverage - b.coverage);
  const allowed = stg.stages.filter((x) => !prefs.excluded.includes(x.id));
  let runs: { code: string; runs: number; sanity: number }[] = [];
  let farmed: Lacking[] = [];
  let days: Day[] = [];
  const tries: [Lacking[], Lacking[]][] = [...[3, 6, 10, lacking.length].filter((k, i, a) => lacking.length && a.indexOf(k) === i).map((k) => [lacking.slice(0, k), []] as [Lacking[], Lacking[]]),
    ...[3, 6, 10].filter(() => stock.length).map((k) => [lacking, stock.slice(0, k)] as [Lacking[], Lacking[]])];
  for (const [want, extra] of tries) {
    const target: Cost = {};
    for (const r of want) target[r.id] = r.short;
    for (const r of extra) target[r.id] = (target[r.id] || 0) + r.need;
    const p = await farmPlan(target, {}, allowed, items.recipes, items.values[LMD] || 0.0036);
    const whole = p.runs.map((x) => ({ code: x.stage.code, runs: Math.ceil(x.runs - 1e-6), sanity: x.stage.ap }));
    const open = Object.fromEntries(p.runs.map((x) => [x.stage.code, x.stage.days || null]));
    const sch = schedule(whole, open, gameDay(server).weekday, today, 135 + 45, prefs.daily);
    runs = sch.days.find((x) => x.offset === 0)?.runs || [];
    days = sch.days.slice(0, 7);
    farmed = [...want, ...extra];
    if (runs.reduce((a, r) => a + r.sanity, 0) >= today * 0.85) break;
  }
  // stages the player left out that would make the shortfall cheaper to farm
  const unlocks: { code: string; saves: number }[] = [];
  const goal = Object.fromEntries(Object.entries(short).filter(([id]) => farmable(id)));
  if (Object.keys(goal).length && prefs.excluded.length) {
    const base = await farmPlan(goal, {}, allowed, items.recipes);
    for (const id of prefs.excluded) {
      const st = stg.stages.find((x) => x.id === id);
      if (!st) continue;
      const withIt = await farmPlan(goal, {}, [...allowed, st], items.recipes);
      if (base.sanity - withIt.sanity >= 1) unlocks.push({ code: st.code, saves: Math.round(base.sanity - withIt.sanity) });
    }
    unlocks.sort((a, b) => b.saves - a.saves);
  }
  return { lacking, stock, runs, farmed, days, depth, counted: d.counted, near: Object.keys(d.near).length > 0, unlocks, lmd: short[LMD] || 0, exp: short[EXP] || 0, plan: !!input.plan };
}
