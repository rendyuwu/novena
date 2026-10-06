// Sanity Dump (after ako's dump.py): what today's sanity should go into. Demand is everything you're working
// toward, counted together: your Planner targets (or the built plan), plus the community builds of your strongest
// operators the plan doesn't cover. The depot pays it once, crafting included; the materials held least against what
// they're needed for come first, and the farming planner turns the top of that list into today's runs.
import { useState } from "preact/hooks";
import { Await, Explain, ItemIcon, Items, itemsSig, metaSig, useAsync } from "../components/ui";
import { costTable, lastPlan } from "../lib/account";
import { EXP, LMD, type CostData } from "../lib/costs";
import { operators, stages as loadStages, usage as loadUsage } from "../lib/data";
import { ANNI_SANITY, dump, type DumpResult } from "../lib/dump";
import { dayTime, fmt, pct } from "../lib/format";
import { href } from "../lib/router";
import { nextWeeklyReset, WEEKDAYS } from "../lib/time";
import { account, hasRoster, prefs, server, targets } from "../state";
import type { ItemsFile, OpIndex, StagesFile, UsageFile } from "../types";

export default function Dump() {
  const s = server.value;
  const st = useAsync(() => Promise.all([operators(s), loadUsage(), costTable(s), loadStages(s)]), [s]);
  return (
    <div class="stack fade-in">
      <h1>Sanity Dump</h1>
      {!hasRoster.value ? (
        <div class="card"><p>The Sanity Dump aims today's sanity at what your account lacks most, so it needs your roster and depot. <a href={href("/roster")}>Add them under My roster</a>.</p></div>
      ) : (
        <Await state={st} what="account data">
          {([ops, usage, costs, stg]) => (itemsSig.value && metaSig.value ? <DumpView ops={ops} usage={usage} costs={costs} stg={stg} items={itemsSig.value} /> : <p class="muted">Loading…</p>)}
        </Await>
      )}
    </div>
  );
}

function DumpView({ ops, usage, costs, stg, items }: { ops: OpIndex[]; usage: UsageFile; costs: Record<string, CostData>; stg: StagesFile; items: ItemsFile }) {
  const s = server.value;
  const [now, setNow] = useState(prefs.value.daily);
  const [potions, setPotions] = useState(0);
  const [anni, setAnni] = useState(0);
  const [result, setResult] = useState<DumpResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const today = Math.max(0, now + potions - anni * ANNI_SANITY);

  const go = async () => {
    setBusy(true);
    setError("");
    try {
      setResult(await dump({ server: s, ops, usage, costs, stg, items, meta: metaSig.value!, account: account.value, targets: targets.value, plan: lastPlan.value?.result ?? null, prefs: prefs.value, today }));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <>
      <section class="card">
        <div class="row" style={{ alignItems: "flex-end" }}>
          <label class="field"><span>Sanity to spend now</span><input type="number" min={0} value={now} onChange={(e) => setNow(+(e.target as HTMLInputElement).value || 0)} /></label>
          <label class="field"><span>Potions expiring soon (sanity)</span><input type="number" min={0} value={potions} onChange={(e) => setPotions(+(e.target as HTMLInputElement).value || 0)} /></label>
          <label class="field"><span>Annihilation runs left this week</span><input type="number" min={0} max={10} value={anni} onChange={(e) => setAnni(+(e.target as HTMLInputElement).value || 0)} /></label>
          <button class="primary" onClick={go} disabled={busy}>{busy ? "Working…" : "What should I farm?"}</button>
        </div>
        <p class="muted" style={{ marginTop: "8px" }}>Today's budget: <strong>{fmt(today)}</strong> sanity. The weekly Annihilation cap (1,800 Orundum) resets {dayTime(nextWeeklyReset(s))}.</p>
        {error && <p role="alert" class="bad-text">{error}</p>}
        <Explain>Demand: {lastPlan.value ? "your built plan" : "your Planner targets"} plus the community builds (E2, main skill M3, main module) of your 40 most-used operators the plan doesn't cover; if that's nearly paid for, everything players commonly build. Your depot pays all of it at once, crafting included.</Explain>
      </section>
      {result && (
        <>
          <section class="card">
            <h2>Today's runs</h2>
            {result.runs.length ? (
              <ul>{result.runs.map((r) => <li key={r.code}><strong>{r.code}</strong> × {r.runs} <span class="muted">({fmt(r.sanity)} sanity)</span></li>)}</ul>
            ) : <p>Nothing to farm with today's sanity{result.lacking.length ? "" : ": your depot covers what you're working toward"}.</p>}
            {result.farmed.length > 0 && <><p>Aimed at:</p><div class="items">{result.farmed.map((r) => <ItemIcon key={r.id} id={r.id} count={r.short || r.need} />)}</div></>}
            {result.days.filter((d) => d.offset > 0 && d.runs.length).length > 0 && (
              <details style={{ marginTop: "10px" }}><summary>The week ahead</summary>
                <ul>{result.days.filter((d) => d.offset > 0 && d.runs.length).map((d) => <li key={d.offset}>{WEEKDAYS[d.weekday - 1]}: {d.runs.map((r) => `${r.code} ×${r.runs}`).join(", ")}</li>)}</ul>
              </details>
            )}
          </section>
          <section class="card">
            <h2>Most lacking</h2>
            <p class="muted">Counted over {result.near ? (result.plan ? "your plan and " : "your targets and ") : ""}{result.counted} operators' builds{result.depth === "deep" ? " (everything players commonly build, since the main builds are nearly covered)" : ""}.</p>
            <div class="table-wrap">
              <table class="cards">
                <thead><tr><th>Material</th><th class="num">Held</th><th class="num">Needed</th><th class="num">Covered</th><th>For</th></tr></thead>
                <tbody>
                  {result.lacking.slice(0, 12).map((r) => (
                    <tr key={r.id}>
                      <td data-label="Material"><ItemIcon id={r.id} /></td>
                      <td data-label="Held" class="num">{fmt(r.held)}</td>
                      <td data-label="Needed" class="num">{fmt(r.need)}</td>
                      <td data-label="Covered" class="num">{pct(r.coverage, 0)}</td>
                      <td data-label="For">{r.near ? "plan / targets" : "community builds"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {(result.lmd > 0 || result.exp > 0) && <p style={{ marginTop: "8px" }}>Also short: <Items cost={{ ...(result.lmd ? { [LMD]: result.lmd } : {}), ...(result.exp ? { [EXP]: result.exp } : {}) }} /> (CE and LS stages)</p>}
            <Explain>Ranked: your plan or targets first, then by how little of the need your depot covers, then by the sanity the shortfall is worth.</Explain>
          </section>
          {result.unlocks.length > 0 && (
            <section class="card">
              <h2>Left-out stages worth clearing</h2>
              <ul>{result.unlocks.map((u) => <li key={u.code}><strong>{u.code}</strong> would save about {fmt(u.saves)} sanity on what you're short of</li>)}</ul>
              <Explain>Stages you left out on the Farming page that the farming plan would use if they were back in.</Explain>
            </section>
          )}
        </>
      )}
    </>
  );
}
