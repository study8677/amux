import { describe, expect, it } from "vitest";
import { reconcile, type ReconcileOptions } from "../src/projects/reconcile.js";
import type { HarnessProject, UnifiedProject } from "../src/core/types.js";

const H = ["codex", "antigravity"];
const opts = (o: Partial<ReconcileOptions> = {}): ReconcileOptions => ({
  harnesses: H,
  exclude: [],
  propagateDeletes: true,
  maxAutoDeletes: 2,
  exists: () => true,
  ...o,
});
const cx = (id: string, name: string, ...roots: string[]): HarnessProject => ({ harness: "codex", id, name, roots });
const ag = (id: string, name: string, ...roots: string[]): HarnessProject => ({ harness: "antigravity", id, name, roots });

describe("reconcile", () => {
  it("pairs by root overlap and creates missing copies", () => {
    const plan = reconcile(
      {
        codex: [cx("c1", "amux", "/p/amux"), cx("c2", "MediaKit", "/p/media")],
        antigravity: [ag("a1", "amux", "/p/amux"), ag("a2", "Attn", "/p/attn")],
      },
      [],
      opts(),
    );
    const creates = plan.actions.filter((a) => a.type === "create");
    expect(creates.map((a) => `${a.harness}:${(a as any).name}`).sort()).toEqual(["antigravity:MediaKit", "codex:Attn"]);
    expect(plan.registry.find((e) => e.name === "amux")?.ids).toEqual({ codex: "c1", antigravity: "a1" });
  });

  it("treats same-root duplicates inside one harness as aliases (prefers the same name)", () => {
    const plan = reconcile(
      {
        codex: [cx("c1", "孙玲sl简历", "/d/sl"), cx("c2", "sl简历", "/d/sl")],
        antigravity: [ag("a1", "sl简历", "/d/sl")],
      },
      [],
      opts(),
    );
    expect(plan.actions).toHaveLength(0);
    const e = plan.registry.find((x) => x.roots.includes("/d/sl"))!;
    expect(e.ids).toEqual({ codex: "c2", antigravity: "a1" });
    expect(e.aliases?.map((a) => a.id)).toEqual(["c1"]);
  });

  it("skips excluded projects and missing roots", () => {
    const plan = reconcile(
      { codex: [cx("c1", "ddn", "/p/ddn"), cx("c2", "gone", "/p/gone")], antigravity: [] },
      [],
      opts({ exclude: ["/p/ddn"], exists: (p) => p !== "/p/gone" }),
    );
    expect(plan.actions).toHaveLength(0);
    expect(plan.skipped.map((s) => s.reason)).toEqual(expect.arrayContaining(["在 projects.exclude 中", "根目录在磁盘上已不存在"]));
  });

  it("is idempotent: reconciling the produced registry yields no actions", () => {
    const current = { codex: [cx("c1", "amux", "/p/amux")], antigravity: [ag("a1", "amux", "/p/amux")] };
    const first = reconcile(current, [], opts());
    const second = reconcile(current, first.registry, opts());
    expect(second.actions).toHaveLength(0);
  });

  it("propagates a rename made on one side (3-way merge)", () => {
    const base = reconcile({ codex: [cx("c1", "old", "/p/x")], antigravity: [ag("a1", "old", "/p/x")] }, [], opts()).registry;
    const plan = reconcile({ codex: [cx("c1", "old", "/p/x")], antigravity: [ag("a1", "new", "/p/x")] }, base, opts());
    expect(plan.actions).toEqual([expect.objectContaining({ type: "update", harness: "codex", id: "c1", name: "new" })]);
  });

  it("propagates root changes from the side that changed", () => {
    const base = reconcile({ codex: [cx("c1", "x", "/p/x")], antigravity: [ag("a1", "x", "/p/x")] }, [], opts()).registry;
    const plan = reconcile({ codex: [cx("c1", "x", "/p/x", "/p/y")], antigravity: [ag("a1", "x", "/p/x")] }, base, opts());
    expect(plan.actions).toEqual([expect.objectContaining({ type: "update", harness: "antigravity", roots: ["/p/x", "/p/y"] })]);
  });

  it("propagates deletions of synced projects", () => {
    const base = reconcile({ codex: [cx("c1", "x", "/p/x")], antigravity: [ag("a1", "x", "/p/x")] }, [], opts()).registry;
    const plan = reconcile({ codex: [cx("c1", "x", "/p/x")], antigravity: [] }, base, opts());
    expect(plan.actions).toEqual([expect.objectContaining({ type: "delete", harness: "codex", id: "c1" })]);
    expect(plan.registry).toHaveLength(0);
  });

  it("does not infer deletions from an unreliable (empty / unreadable) side", () => {
    const base = reconcile({ codex: [cx("c1", "x", "/p/x")], antigravity: [ag("a1", "x", "/p/x")] }, [], opts()).registry;
    const plan = reconcile({ codex: [cx("c1", "x", "/p/x")], antigravity: [] }, base, opts({ unreliable: ["antigravity"] }));
    expect(plan.actions).toHaveLength(0);
    expect(plan.registry[0].ids).toEqual({ codex: "c1", antigravity: "a1" });
  });

  it("holds mass deletions above the guard threshold until confirmed", () => {
    const projs = ["a", "b", "c"];
    const base = reconcile(
      { codex: projs.map((p) => cx("c" + p, p, "/p/" + p)), antigravity: projs.map((p) => ag("a" + p, p, "/p/" + p)) },
      [],
      opts(),
    ).registry;
    const held = reconcile({ codex: projs.map((p) => cx("c" + p, p, "/p/" + p)), antigravity: [ag("az", "z", "/p/z")] }, base, opts());
    expect(held.heldDeletes).toHaveLength(3);
    expect(held.actions.filter((a) => a.type === "delete")).toHaveLength(0);
    expect(held.actions.filter((a) => a.type === "create" && a.harness === "antigravity")).toHaveLength(0);
    const ok = reconcile({ codex: projs.map((p) => cx("c" + p, p, "/p/" + p)), antigravity: [] }, base, opts({ confirmDeletes: true }));
    expect(ok.actions.filter((a) => a.type === "delete")).toHaveLength(3);
  });

  it("with propagation off, a deleted side is detached and never re-created", () => {
    const base = reconcile({ codex: [cx("c1", "x", "/p/x")], antigravity: [ag("a1", "x", "/p/x")] }, [], opts()).registry;
    const p1 = reconcile({ codex: [cx("c1", "x", "/p/x")], antigravity: [] }, base, opts({ propagateDeletes: false }));
    expect(p1.actions).toHaveLength(0);
    const p2 = reconcile({ codex: [cx("c1", "x", "/p/x")], antigravity: [] }, p1.registry, opts({ propagateDeletes: false }));
    expect(p2.actions).toHaveLength(0);
    expect((p2.registry[0] as UnifiedProject).detached).toEqual(["antigravity"]);
  });
});
