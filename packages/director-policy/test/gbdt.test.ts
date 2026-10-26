import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { LgbDump } from "../src/model/gbdt.ts";
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

describe("GbdtModel parity with LightGBM (exported fixture)", () => {
  // Fixture produced by `python -m mf_common.cli make-parity-fixture` (LightGBM 4.7.0, synthetic data, no demo content).
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "models", "contact_2s_parity");
  const model = JSON.parse(readFileSync(join(dir, "model.json"), "utf8")) as LgbDump;
  const parity = JSON.parse(readFileSync(join(dir, "parity_vectors.json"), "utf8")) as {
    feature_names: string[];
    tolerance: number;
    vectors: { features: (number | null)[]; raw_score: number; probability: number }[];
  };

  it("loads the exported dump with the expected feature order", () => {
    const m = new GbdtModel(model);
    expect(m.featureNames).toEqual(parity.feature_names);
    expect(parity.vectors.length).toBeGreaterThanOrEqual(32);
  });

  it("matches LightGBM raw scores and probabilities, including missing (NaN) features", () => {
    const m = new GbdtModel(model);
    let withMissing = 0;
    for (const v of parity.vectors) {
      const x = v.features.map((f) => (f === null ? Number.NaN : f));
      if (v.features.includes(null)) withMissing++;
      expect(Math.abs(m.raw(x) - v.raw_score)).toBeLessThanOrEqual(parity.tolerance);
      expect(Math.abs(m.predict(x) - v.probability)).toBeLessThanOrEqual(parity.tolerance);
    }
    expect(withMissing).toBeGreaterThan(0);
  });
});
