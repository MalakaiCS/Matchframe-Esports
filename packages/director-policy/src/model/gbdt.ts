/**
 * Evaluator for LightGBM models exported with `Booster.dump_model()` (JSON). Pure TypeScript,
 * deterministic and allocation-light, so a promoted model can run inside the live engine with
 * bounded latency. Only numerical splits are supported; models with categorical splits or other
 * unsupported features are rejected at load time (and the deterministic policy is used instead).
 */
interface LgbNode {
  split_feature?: number;
  threshold?: number;
  decision_type?: string;
  default_left?: boolean;
  missing_type?: "None" | "Zero" | "NaN";
  left_child?: LgbNode;
  right_child?: LgbNode;
  leaf_value?: number;
}

export interface LgbDump {
  name?: string;
  version?: string;
  num_class?: number;
  num_tree_per_iteration?: number;
  max_feature_idx?: number;
  objective?: string;
  feature_names?: string[];
  tree_info: { tree_structure: LgbNode; shrinkage?: number }[];
  average_output?: boolean;
}

export class ModelLoadError extends Error {}

type Compiled =
  | { leaf: true; value: number }
  | { leaf: false; feature: number; threshold: number; defaultLeft: boolean; missing: "None" | "Zero" | "NaN"; left: Compiled; right: Compiled };

function compile(n: LgbNode): Compiled {
  if (n.leaf_value !== undefined && n.split_feature === undefined) return { leaf: true, value: n.leaf_value };
  if (n.decision_type !== undefined && n.decision_type !== "<=") throw new ModelLoadError(`unsupported decision type ${n.decision_type} (categorical splits are not supported)`);
  if (n.split_feature === undefined || n.threshold === undefined || !n.left_child || !n.right_child) throw new ModelLoadError("malformed tree node");
  return {
    leaf: false,
    feature: n.split_feature,
    threshold: n.threshold,
    defaultLeft: n.default_left ?? true,
    missing: n.missing_type ?? "None",
    left: compile(n.left_child),
    right: compile(n.right_child),
  };
}

function walk(node: Compiled, x: ArrayLike<number>): number {
  let n = node;
  while (!n.leaf) {
    const v = x[n.feature];
    let goLeft: boolean;
    if (v === undefined || Number.isNaN(v)) {
      // LightGBM: NaN goes to the default direction when missing_type is NaN; otherwise it is
      // treated as 0 for "Zero"/"None".
      goLeft = n.missing === "NaN" ? n.defaultLeft : 0 <= n.threshold;
      if (n.missing === "Zero") goLeft = n.defaultLeft;
    } else if (n.missing === "Zero" && v === 0) {
      goLeft = n.defaultLeft;
    } else {
      goLeft = v <= n.threshold;
    }
    n = goLeft ? n.left : n.right;
  }
  return n.value;
}

export class GbdtModel {
  private readonly trees: Compiled[];
  readonly featureNames: string[];
  readonly objective: string;

  constructor(dump: LgbDump) {
    if (!Array.isArray(dump.tree_info) || dump.tree_info.length === 0) throw new ModelLoadError("model has no trees");
    if ((dump.num_class ?? 1) !== 1 || (dump.num_tree_per_iteration ?? 1) !== 1) throw new ModelLoadError("only single-output models are supported");
    this.objective = (dump.objective ?? "binary").split(" ")[0]!;
    if (!["binary", "regression", "lambdarank", "rank_xendcg"].includes(this.objective)) throw new ModelLoadError(`unsupported objective ${this.objective}`);
    this.trees = dump.tree_info.map((t) => compile(t.tree_structure));
    this.featureNames = dump.feature_names ?? Array.from({ length: (dump.max_feature_idx ?? 0) + 1 }, (_, i) => `f${i}`);
  }

  /** Raw score (sum of leaf values). */
  raw(x: ArrayLike<number>): number {
    let s = 0;
    for (const t of this.trees) s += walk(t, x);
    return s;
  }

  /** Probability for binary objectives, raw score otherwise. */
  predict(x: ArrayLike<number>): number {
    const r = this.raw(x);
    return this.objective === "binary" ? 1 / (1 + Math.exp(-r)) : r;
  }

  /** Builds a feature vector from named features; missing names become NaN (never 0). */
  vector(features: Record<string, number | null | undefined>): Float64Array {
    const v = new Float64Array(this.featureNames.length);
    this.featureNames.forEach((name, i) => {
      const x = features[name];
      v[i] = x === null || x === undefined ? Number.NaN : x;
    });
    return v;
  }
}
