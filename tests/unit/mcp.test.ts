import { describe, expect, it } from "vitest";
import fixture from "../fixtures/novena-sync.json";
import { effectHits, findByEffect, readPlayer, resolveEffect, type Hit } from "../../mcp/core";
import type { RosterOp } from "../../src/state";
import type { Module, OpDetail, OpIndex, Skill, TalentCand } from "../../src/types";

const FEAR = '<i data-t="ba.fear">Fear</i>';
const TAG = "ba.fear";

const detail = (p: Partial<OpDetail>): OpDetail => ({
  id: "x", src: "en", desc: "", trait: null, phases: [], trust: {}, pots: [], talents: [], skills: [], skillUp: [], modules: [], riic: [], ...p,
});
const opIndex = (p: Partial<OpIndex>): OpIndex => ({
  id: "x", name: "x", rarity: 6, cls: "CASTER", branch: "", pos: "RANGED", tags: [], factions: [], obtain: "", recruit: true, on: ["en"], mods: [], modIds: [], ...p,
});
const skill = (name: string, descs: string[]): Skill => ({
  id: name, icon: "", name, sp: "auto", type: "", ammo: false, levels: descs.map((desc) => ({ desc, sp: 0, init: 0, dur: 0 })), mastery: [],
});
const talent = (elite: number, level: number, pot: number, desc: string): TalentCand => ({ name: "T", elite, level, pot, desc });
const mod = (letter: string, stages: string[]): Module => ({
  id: letter, name: `Mod ${letter}`, letter, icon: "", type: "", img: "", unlock: { elite: 2, level: 60 }, cost: [],
  stages: stages.map((t) => ({ attrs: {}, trait: [t], talents: [] })),
});
const roster = (p: Partial<RosterOp>): RosterOp => ({ id: "x", elite: 0, level: 1, pot: 1, skillLevel: 1, masteries: [0, 0, 0], modules: {}, ...p });
const at = (hits: Hit[], where: string) => hits.find((h) => h.where.startsWith(where));

describe("effectHits", () => {
  it("unlocks skills at E0/E1/E2", () => {
    const d = detail({ skills: [skill("A", ["Deals damage"]), skill("B", [`Inflicts ${FEAR} on enemies; deals damage`]), skill("C", [FEAR])] });
    const e0 = effectHits(d, TAG, roster({ elite: 0 }));
    expect(at(e0, "S1")).toBeUndefined();
    expect(at(e0, "S2")).toEqual({ where: "S2 B", text: "Inflicts Fear on enemies", needs: "E1", usable: false });
    expect(at(e0, "S3")).toMatchObject({ needs: "E2", usable: false });
    const e1 = effectHits(d, TAG, roster({ elite: 1 }));
    expect(at(e1, "S2")?.usable).toBe(true);
    expect(at(e1, "S3")?.usable).toBe(false);
  });

  it("finds skill effects from a higher level", () => {
    const d = detail({ skills: [skill("A", Array.from({ length: 10 }, (_, i) => (i >= 3 ? FEAR : "none")))] });
    expect(at(effectHits(d, TAG, roster({ elite: 1, skillLevel: 3 })), "S1")).toMatchObject({ usable: false, needs: "SL4" });
    expect(at(effectHits(d, TAG, roster({ elite: 1, skillLevel: 4 })), "S1")?.usable).toBe(true);
  });

  it("reads talent potential as 0-based", () => {
    const d = detail({ talents: [[talent(0, 1, 0, "none"), talent(2, 1, 2, FEAR)]] });
    expect(at(effectHits(d, TAG, roster({ elite: 2, pot: 2 })), "Talent 1 (T)")).toMatchObject({ usable: false, needs: "E2 P3", text: "Fear" });
    expect(at(effectHits(d, TAG, roster({ elite: 2, pot: 3 })), "Talent 1")?.usable).toBe(true);
  });

  it("gates talents by level", () => {
    const d = detail({ talents: [[talent(0, 1, 0, "none"), talent(1, 55, 0, FEAR)]] });
    const usable = (elite: number, level: number) => at(effectHits(d, TAG, roster({ elite, level })), "Talent 1")?.usable;
    expect(usable(1, 54)).toBe(false);
    expect(usable(1, 55)).toBe(true);
    expect(usable(2, 1)).toBe(true);
    expect(at(effectHits(d, TAG), "Talent 1")).toEqual({ where: "Talent 1 (T)", text: "Fear", needs: "E1 Lv55", usable: undefined });
  });

  it("needs the module stage that carries the effect", () => {
    const d = detail({ modules: [mod("X", ["none", FEAR, FEAR])] });
    expect(at(effectHits(d, TAG, roster({ modules: { X: 1 } })), "Module X")).toMatchObject({ usable: false, needs: "Module X stage 2" });
    expect(at(effectHits(d, TAG, roster({ modules: { X: 2 } })), "Module X")?.usable).toBe(true);
  });

  it("finds a trait hit and joins every sentence that carries the tag", () => {
    const d = detail({ desc: `Inflicts ${FEAR} on enemies. Then inflicts ${FEAR} again`, trait: [{ elite: 2, pot: 0, desc: "no tag here" }] });
    expect(effectHits(d, TAG)).toEqual([{ where: "Trait", text: "Inflicts Fear on enemies … Then inflicts Fear again", needs: undefined, usable: undefined }]);
  });

  it("gates a trait variant by potential only", () => {
    const d = detail({ desc: "none", trait: [{ elite: 2, pot: 2, desc: FEAR }] });
    expect(at(effectHits(d, TAG, roster({ elite: 2, pot: 2 })), "Trait")).toMatchObject({ usable: false, needs: "E2 P3" });
    expect(at(effectHits(d, TAG, roster({ elite: 2, pot: 3 })), "Trait")?.usable).toBe(true);
  });
});

describe("findByEffect", () => {
  const skills = [skill("s1", ["none"]), skill("s2", [FEAR])];
  const ops = [
    opIndex({ id: "a", name: "Alpha", rarity: 5 }),
    opIndex({ id: "b", name: "Bravo", rarity: 5 }),
    opIndex({ id: "c", name: "Charlie", on: ["cn"] }),
    opIndex({ id: "d", name: "Delta", rarity: 4 }),
  ];
  const details = new Map(ops.map((o) => [o.id, detail({ id: o.id, skills })]));

  it("searches only the server's operators", () => {
    const r = findByEffect(ops, details, TAG, "en", null);
    expect(r.operators.map((o) => o.name)).toEqual(["Alpha", "Bravo", "Delta"]);
    expect(r).toMatchObject({ effect: TAG, total: 3 });
  });

  it("puts the player's usable operators first", () => {
    const r = findByEffect(ops, details, TAG, "en", { a: roster({ id: "a", elite: 0 }), b: roster({ id: "b", elite: 1 }) });
    expect(r.operators.map((o) => o.name)).toEqual(["Bravo", "Alpha"]);
    expect(r.operators[0]).toMatchObject({ cls: "Caster", owned: "E1 L1, SL1, P1" });
  });

  it("caps the list but counts everyone", () => {
    const many = Array.from({ length: 55 }, (_, i) => opIndex({ id: `op${i}`, name: `Op${i}` }));
    const all = new Map(many.map((o) => [o.id, detail({ id: o.id, skills })]));
    const r = findByEffect(many, all, TAG, "en", null);
    expect(r.total).toBe(55);
    expect(r.operators).toHaveLength(50);
  });
});

describe("resolveEffect", () => {
  const terms = { "cc.fear": { name: "Fear", desc: "" }, "ba.fear": { name: "Fear", desc: "" }, "ba.stun": { name: "Stun", desc: "" } };

  it("takes a name or a tag", () => {
    expect(resolveEffect(terms, "fear")).toBe("ba.fear");
    expect(resolveEffect(terms, "ba.fear")).toBe("ba.fear");
  });

  it("lists the battle terms when nothing matches", () => {
    expect(() => resolveEffect(terms, "nonsense")).toThrow('No game term called "nonsense". Battle terms: Fear, Stun.');
  });
});

describe("readPlayer", () => {
  const ops = [opIndex({ id: "char_1" })];
  const op = roster({ id: "char_1", elite: 2, level: 90, pot: 3, skillLevel: 7, masteries: [0, 3, 0] });
  const backup = {
    app: "novena", version: 1,
    data: { "account.en": { ops: { char_1: op }, depot: { "30073": 5 } }, "targets.en": [{ id: "char_1", text: "E2" }], "prefs.en": { daily: 200, excluded: ["s1"], useDepot: true } },
  };

  it("reads a Novena backup with its targets and prefs", () => {
    const p = readPlayer(backup, ops, "en");
    expect(p.account.ops).toEqual({ char_1: op });
    expect(p.account.depot).toEqual({ "30073": 5 });
    expect(p.targets).toEqual([{ id: "char_1", text: "E2" }]);
    expect(p.prefs).toEqual({ daily: 200, excluded: ["s1"], useDepot: true });
    expect(p.format).toBe("Novena backup");
  });

  it("refuses a backup without the server's roster", () => {
    expect(() => readPlayer(backup, ops, "jp")).toThrow("This backup has no JP roster.");
  });

  it("refuses a roster file from another server", () => {
    expect(() => readPlayer(fixture, ops, "jp")).toThrow("This roster file is from the EN server; set NOVENA_SERVER=en.");
  });
});
