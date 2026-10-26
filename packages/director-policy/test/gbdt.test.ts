import { describe, expect, it } from "vitest";
import { GbdtModel, ModelLoadError } from "../src/model/gbdt.ts";

const dump = {
  objective: "binary sigmoid:1",
  feature_names: ["distance", "facing"],
  max_feature_idx: 1,
  tree_info: [
    {
      tree_structure: {
        split_feature: 0,
        threshold: 500,
        decision_type: "<=",
        default_left: false,
        missing_type: "NaN" as const,
        left_child: { split_feature: 1, threshold: 0.5, decision_type: "<=", default_left: true, missing_type: "None" as const, left_child: { leaf_value: 0.2 }, right_child: { leaf_value: 1.1 } },
        right_child: { leaf_value: -0.8 },
      },
    },
    { tree_structure: { leaf_value: 0.05 } },
  ],
};

describe("GbdtModel", () => {
  it("evaluates numeric splits and applies the binary link", () => {
    const m = new GbdtModel(dump);
    expect(m.raw([400, 0.9])).toBeCloseTo(1.15);
    expect(m.raw([400, 0.1])).toBeCloseTo(0.25);
    expect(m.raw([900, 0.9])).toBeCloseTo(-0.75);
    expect(m.predict([400, 0.9])).toBeCloseTo(1 / (1 + Math.exp(-1.15)));
  });

  it("routes missing values by the model's default direction, never as a fabricated zero", () => {
    const m = new GbdtModel(dump);
    const v = m.vector({ distance: null, facing: 0.9 });
    expect(Number.isNaN(v[0]!)).toBe(true);
    expect(m.raw(v)).toBeCloseTo(-0.75); // default_left false → right child
  });

  it("rejects unsupported models", () => {
    expect(() => new GbdtModel({ tree_info: [] })).toThrow(ModelLoadError);
    expect(() => new GbdtModel({ objective: "multiclass", num_class: 3, tree_info: dump.tree_info })).toThrow(ModelLoadError);
    expect(() => new GbdtModel({ tree_info: [{ tree_structure: { split_feature: 0, threshold: 1, decision_type: "==", left_child: { leaf_value: 1 }, right_child: { leaf_value: 0 } } }] })).toThrow(/categorical/);
  });
});
