// Pull planner (after ako's pulls.py): savings, a steady-income estimate, and the banners coming from CN.
import { Await, Explain, OpLink, useAsync } from "../components/ui";
import { operators, upcoming as loadUpcoming, usage as loadUsage } from "../lib/data";
import { date, fmt, pct, relative } from "../lib/format";
import { bannersAhead, ORUNDUM_PER_PRIME, ORUNDUM_PER_PULL, orundumPerDay, pullsBy, pullsNow } from "../lib/pulls";
import { account, saveAccount, server } from "../state";

export default function Pulls() {
  const s = server.value;
  const st = useAsync(() => Promise.all([loadUpcoming(s), operators(s), loadUsage()]), [s]);
  const sv = account.value.savings || { orundum: 0, prime: 0, permits: 0, card: false };
  const set = (patch: Partial<typeof sv>) => saveAccount({ ...account.value, savings: { ...sv, ...patch } });
  const perDay = orundumPerDay(sv);
  return (
    <div class="stack fade-in">
      <h1>Pull planner</h1>
      <section class="card">
        <h2>Your savings</h2>
        <div class="row" style={{ alignItems: "flex-end" }}>
          <label class="field"><span>Orundum</span><input type="number" min={0} value={sv.orundum} style={{ width: "8em" }} onChange={(e) => set({ orundum: +(e.target as HTMLInputElement).value || 0 })} /></label>
          <label class="field"><span>Originite Prime</span><input type="number" min={0} value={sv.prime} onChange={(e) => set({ prime: +(e.target as HTMLInputElement).value || 0 })} /></label>
          <label class="field"><span>Headhunting Permits</span><input type="number" min={0} value={sv.permits} onChange={(e) => set({ permits: +(e.target as HTMLInputElement).value || 0 })} /></label>
          <label class="row tight"><input type="checkbox" checked={sv.card} onChange={(e) => set({ card: (e.target as HTMLInputElement).checked })} /> Monthly card running</label>
        </div>
        <p style={{ marginTop: "10px" }}>Now: <strong>{pullsNow(sv, false).toFixed(1)} pulls</strong> <span class="muted">({pullsNow(sv, true).toFixed(1)} counting Originite Prime at {ORUNDUM_PER_PRIME} Orundum each)</span></p>
        <p class="muted">Steady income ≈ {fmt(perDay)} Orundum a day ({(perDay * 30 / ORUNDUM_PER_PULL).toFixed(1)} pulls a month).</p>
        <Explain>Steady sources only: daily missions 100/day, weekly missions 500 and Annihilation 1,800 per week, the monthly card 200/day while it runs. Events, stores and login rewards add more, unevenly, and aren't counted. Saved in this browser.</Explain>
      </section>
      {s === "cn" ? <p class="muted">CN banners aren't previewed (CN is the server the others follow).</p> : (
        <Await state={st} what="upcoming banners">
          {([up, ops, usage]) => {
            const byId = new Map(ops.map((o) => [o.id, o]));
            const rows = bannersAhead(up);
            return (
              <section class="card">
                <h2>Banners coming</h2>
                <div class="table-wrap">
                  <table class="cards">
                    <thead><tr><th>Expected</th><th>Banner</th><th>Featured 6★</th><th class="num">Pulls by then</th></tr></thead>
                    <tbody>
                      {rows.map((b) => {
                        const pulls = pullsBy(sv, b.eta);
                        return (
                          <tr key={b.id}>
                            <td data-label="Expected">~{date(b.eta)} <span class="badge est">estimate</span><br /><small class="muted">{relative(b.eta)}</small></td>
                            <td data-label="Banner">{{ limited: "Limited", collab: "Collaboration", special: "Special", kernel: "Kernel" }[b.kind] || b.kind}<br /><small class="muted">{b.name_cn}</small></td>
                            <td data-label="Featured 6★">{b.featured.map((id) => { const op = byId.get(id); return op ? <div key={id}><OpLink op={op} sub={<>usage {pct(usage.ops[id]?.score || 0)}{account.value.ops[id] ? " · owned" : ""}</>} /></div> : null; })}</td>
                            <td data-label="Pulls by then" class="num">{pulls.toFixed(0)}{b.spark && pulls >= b.spark ? " ✓ spark" : ""}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <Explain>Dates are CN's plus the measured lag ({up.lag_days} days); servers skip and reorder banners. "Pulls by then" assumes you save everything until that date. Limited banners guarantee their operator at 300 pulls (spark).</Explain>
              </section>
            );
          }}
        </Await>
      )}
    </div>
  );
}
