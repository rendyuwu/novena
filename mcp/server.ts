// Novena's MCP server: runs locally over stdio, reads the published data and the player's roster file, and answers
// with the site's own calculations. Stdout is the protocol: nothing else may write to it.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { planInput } from "../src/lib/account";
import { stateLabel } from "../src/lib/build";
import type { CostData } from "../src/lib/costs";
import { ANNI_SANITY, dump } from "../src/lib/dump";
import { pct } from "../src/lib/format";
import { readData } from "../src/lib/importers";
import { makePlan, type GuidebookFile, type PlanStep } from "../src/lib/planner";
import { bannersAhead, ORUNDUM_PER_PULL, orundumPerDay, pullsBy, pullsNow } from "../src/lib/pulls";
import { WEEKDAYS } from "../src/lib/time";
import { DEFAULT_WEIGHTS } from "../src/lib/weights";
import type { ItemsFile, Meta, OpDetail, OpIndex, StagesFile, UpcomingFile, UsageFile } from "../src/types";
import { assertServer, findByEffect, readPlayer, resolveEffect } from "./core";

const server = z.enum(["en", "jp", "kr", "cn"]).parse(process.env.NOVENA_SERVER || "en");
const ROSTER = process.env.NOVENA_ROSTER || join(homedir(), "Documents", "Novena Sync", `novena-sync-${server}.json`);
const DATA = (process.env.NOVENA_DATA_URL || "https://vanastraea.github.io/novena/data/v1/").replace(/\/?$/, "/");

// an hour's cache: clients keep this server running for days, and the data is rebuilt daily
const cache = new Map<string, { at: number; p: Promise<unknown> }>();
function load<T>(path: string): Promise<T> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < 3600_000) return hit.p as Promise<T>;
  const get = () => fetch(DATA + path).then((r) => {
    if (!r.ok) throw new Error(`Couldn't load ${path} (${r.status})`);
    return r.json() as Promise<T>;
  });
  const p = get().catch(get); // one retry: the host now and then answers with an HTML error page
  p.catch(() => cache.delete(path));
  cache.set(path, { at: Date.now(), p });
  return p;
}

const opsIndex = () => load<{ ops: OpIndex[] }>(`${server}/operators.json`).then((d) => d.ops);
const json = (x: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(x) }] });
const r1 = (x: number) => Math.round(x * 10) / 10;

/** The roster file, read on every call: Novena Sync rewrites it on each sync. */
async function player() {
  let text: string;
  try {
    text = await readFile(ROSTER, "utf8");
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") throw new Error(`No roster file at ${ROSTER}. Set NOVENA_ROSTER to a Novena Sync file, a roster exported from Novena, or a Novena backup.`);
    throw e;
  }
  const data = readData(text);
  // name the wrong-server case before the data fetch: on a mirror that only has one server the fetch would 404 first
  assertServer(data, server);
  const p = readPlayer(data, await opsIndex(), server);
  if (!Object.keys(p.account.ops).length) throw new Error(`The roster file at ${ROSTER} has no ${server.toUpperCase()} operators.`);
  return p;
}

/** Operator detail files, 16 at a time. */
async function details(ids: string[]): Promise<Map<string, OpDetail>> {
  const out = new Map<string, OpDetail>();
  const queue = [...ids];
  await Promise.all(Array.from({ length: 16 }, async () => {
    for (let id = queue.pop(); id !== undefined; id = queue.pop()) out.set(id, await load<OpDetail>(`${server}/ops/${encodeURIComponent(id)}.json`));
  }));
  return out;
}

const mcp = new McpServer({ name: "novena", version: "0.1.0" });

mcp.registerTool("find_operators_by_effect", {
  description: "Operators whose trait, talents, skills or modules mention a game effect (a term such as Fear, Stun, Slow, Bind, Sleep), from Novena's data. Each hit carries the sentence it comes from: tell operators that inflict the effect apart from ones that only benefit from it. With owned=true (default) only the player's operators are searched, and each hit says whether it is usable now (`usable`) or what it needs (`needs`: promotion, level, potential, module stage).",
  inputSchema: z.object({
    effect: z.string().describe("The effect's name as the game writes it (\"Fear\") or its term tag (\"ba.fear\")"),
    owned: z.boolean().default(true).describe("Only the player's operators (reads the roster file)"),
  }),
}, async ({ effect, owned }) => {
  const [meta, ops] = await Promise.all([load<Meta>(`${server}/meta.json`), opsIndex()]);
  const tag = resolveEffect(meta.terms, effect);
  const p = owned ? await player() : null;
  const roster = p?.account.ops ?? null;
  const ids = ops.filter((o) => o.on.includes(server) && (!roster || roster[o.id])).map((o) => o.id);
  return json({ server, format: p?.format, term: meta.terms[tag], ...findByEffect(ops, await details(ids), tag, server, roster) });
});

mcp.registerTool("pull_plan", {
  description: "The player's headhunting savings in pulls, a steady-income estimate (daily and weekly missions, Annihilation, monthly card; events, stores and login rewards not counted), and pulls by each banner expected on their server if they save everything until then. Banner dates are CN's plus the measured lag; servers skip and reorder banners. Limited banners guarantee their operator at the spark count. Reads savings from the roster file.",
  inputSchema: z.object({}),
}, async () => {
  const p = await player();
  const sv = p.account.savings;
  if (!sv) throw new Error("The roster file has no savings: Novena Sync files, rosters exported from Novena and Novena backups carry them.");
  const perDay = orundumPerDay(sv);
  const base = { server, savings: sv, pullsNow: r1(pullsNow(sv, false)), pullsNowWithPrime: r1(pullsNow(sv, true)), orundumPerDay: Math.round(perDay), pullsPerMonth: r1(perDay * 30 / ORUNDUM_PER_PULL) };
  if (server === "cn") return json({ ...base, banners: "CN banners aren't previewed (CN is the server the others follow)." });
  const [up, ops, usage] = await Promise.all([load<UpcomingFile>(`${server}/upcoming.json`), opsIndex(), load<UsageFile>("common/usage.json")]);
  const byId = new Map(ops.map((o) => [o.id, o]));
  const banners = bannersAhead(up).map((b) => {
    const pulls = pullsBy(sv, b.eta);
    return {
      name: b.name_en ?? b.name_cn, kind: b.kind, eta: b.eta, estimate: b.dated_by !== "wiki",
      featured: b.featured.filter((id) => byId.has(id)).map((id) => ({ name: byId.get(id)!.name, owned: !!p.account.ops[id], usage: pct(usage.ops[id]?.score || 0) })),
      pullsByThen: Math.round(pulls), spark: b.spark ?? null, sparkReached: !!b.spark && pulls >= b.spark,
    };
  });
  return json({ ...base, lagDays: up.lag_days, banners });
});

mcp.registerTool("sanity_dump", {
  description: "What to farm with today's sanity, worked out like Novena's Sanity Dump. Demand is the player's Planner targets (only a Novena backup carries them) plus the community builds (E2, main skill M3, main module) of their 40 most-used operators, or everything players commonly build once those are nearly covered. The depot pays it, crafting included. The most-lacking materials are turned into today's runs by the farming planner (Penguin Statistics drop rates, solved with HiGHS).",
  inputSchema: z.object({
    sanity: z.number().int().min(0).optional().describe("Sanity to spend now (default: the backup's daily sanity, else 240)"),
    potions: z.number().int().min(0).default(0).describe("Sanity in potions expiring soon"),
    annihilation_runs: z.number().int().min(0).max(10).default(0).describe("Annihilation runs still to do this week (25 sanity each is kept back)"),
  }),
}, async ({ sanity, potions, annihilation_runs }) => {
  const p = await player();
  const [ops, usage, costs, stg, items, meta] = await Promise.all([opsIndex(), load<UsageFile>("common/usage.json"), load<Record<string, CostData>>(`${server}/costs.json`),
    load<StagesFile>(`${server}/stages.json`), load<ItemsFile>(`${server}/items.json`), load<Meta>(`${server}/meta.json`)]);
  const today = Math.max(0, (sanity ?? p.prefs.daily) + potions - annihilation_runs * ANNI_SANITY);
  const r = await dump({ server, ops, usage, costs, stg, items, meta, account: p.account, targets: p.targets, plan: null, prefs: p.prefs, today });
  return json({
    budget: today,
    demand: `${r.near ? "the Planner targets and " : ""}the community builds of ${r.counted} operators${r.depth === "deep" ? " (everything players commonly build: the main builds are nearly covered)" : ""}`,
    todaysRuns: r.runs,
    aimedAt: r.farmed.map((x) => ({ item: items.items[x.id]?.name ?? x.id, count: x.short || x.need })),
    weekAhead: r.days.filter((d) => d.offset > 0 && d.runs.length).map((d) => ({ day: WEEKDAYS[d.weekday - 1], runs: d.runs.map((x) => `${x.code} ×${x.runs}`) })),
    mostLacking: r.lacking.slice(0, 12).map((x) => ({ item: items.items[x.id]?.name ?? x.id, held: x.held, needed: x.need, covered: pct(x.coverage, 0), for: x.near ? "targets" : "community builds" })),
    alsoShort: { lmd: Math.round(r.lmd), exp: Math.round(r.exp) },
    leftOutStagesWorthClearing: r.unlocks,
  });
});

mcp.registerTool("priorities", {
  description: "What the player should raise next. Novena's planner scores the account by the community clear guides (MAA Copilot) it can follow and picks upgrades by coverage gained per sanity. Uses Novena's default content weights; Planner targets (only a Novena backup carries them) come first as goals. Can take a while on a big roster.",
  inputSchema: z.object({
    steps: z.number().int().min(1).max(40).default(20).describe("How many upgrades to suggest (the site offers 10, 20 or 40)"),
    support: z.boolean().default(true).describe("Count on borrowing one support operator"),
  }),
}, async ({ steps, support }) => {
  const p = await player();
  const [book, costs, ops, meta, items] = await Promise.all([load<GuidebookFile>("common/guidebook.json"), load<Record<string, CostData>>(`${server}/costs.json`),
    opsIndex(), load<Meta>(`${server}/meta.json`), load<ItemsFile>(`${server}/items.json`)]);
  const byId = new Map(ops.map((o) => [o.id, o]));
  // synchronous: Node has no Web Worker, so the site's runPlan can't be used here
  const r = makePlan(planInput({ server, account: p.account, targets: p.targets, book, costs, ops, meta, items, weights: DEFAULT_WEIGHTS, top: steps, support }));
  const [goals, upgrades] = [r.goals, r.steps].map((list) => list.map((s: PlanStep) => ({
    operator: byId.get(s.id)?.name ?? s.id, from: stateLabel(s.before), to: stateLabel(s.after), coverage: `+${(s.gain * 100).toFixed(2)}%`, sanity: Math.round(s.sanity),
  })));
  return json({
    coverageNow: pct(r.startValue), clearableStages: `${r.startStages.toFixed(0)} of ${r.totalStages}`, withGoals: r.goalValue === null ? null : pct(r.goalValue),
    coverageAfter: pct(r.endValue), goals, steps: upgrades,
  });
});

await mcp.connect(new StdioServerTransport());
