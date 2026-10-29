"""Single CLI entry point: ``python -m mf_common.cli <command> ...``.

Every command writes JSON lines to stdout (``progress``/``warning`` lines, then exactly one
``result`` or ``error`` line). Exit codes: 0 success, 1 error, 2 usage error, 3 the command
completed but its verdict is negative (quarantine, checksum mismatch, split leak, leakage,
refused promotion). Handlers live in the stage packages and are imported lazily.
"""

from __future__ import annotations

import argparse
import sys
import traceback
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from . import errors
from .emit import Emitter

Handler = Callable[[argparse.Namespace, Emitter], dict[str, Any]]

#: Result key a handler may set to request a non-zero exit while still emitting a result.
EXIT_KEY = "_exit_code"


def _hash(a: argparse.Namespace, em: Emitter) -> dict[str, Any]:
    from mf_demo_parser.inspect_demo import hash_file

    return hash_file(Path(a.input), em)


def _inspect(a: argparse.Namespace, em: Emitter) -> dict[str, Any]:
    from mf_demo_parser.inspect_demo import inspect_demo

    return inspect_demo(Path(a.input), em)


def _extract(a: argparse.Namespace, em: Emitter) -> dict[str, Any]:
    from mf_demo_parser.extract import ExtractSettings, extract_demo

    settings = ExtractSettings(sample_hz=a.sample_hz, event_window_s=a.event_window_s)
    out = extract_demo(Path(a.input), Path(a.dataset_root), em, settings)
    if a.validate and out.get("dataset"):
        from mf_demo_parser.validate import validate_dataset

        v = validate_dataset(Path(out["dataset"]), em)
        out["validation"] = {"verdict": v["verdict"], "reasons": v["reasons"], "flags": v["flags"]}
    return out


def _validate(a: argparse.Namespace, em: Emitter) -> dict[str, Any]:
    from mf_demo_parser.validate import validate_dataset

    out = validate_dataset(Path(a.dataset), em, expected_map=a.expected_map)
    if out["verdict"] != "usable":
        out[EXIT_KEY] = errors.EXIT_CHECK_FAILED
    return out


def _verify(a: argparse.Namespace, em: Emitter) -> dict[str, Any]:
    from mf_demo_parser.validate import verify_dataset

    out = verify_dataset(Path(a.dataset), em)
    if not out["ok"]:
        out[EXIT_KEY] = errors.EXIT_CHECK_FAILED
    return out


def _benchmark(a: argparse.Namespace, em: Emitter) -> dict[str, Any]:
    from mf_demo_parser.benchmark import run_benchmark

    return run_benchmark(Path(a.inputs), Path(a.dataset_root), em, with_features=a.with_features, out=a.out)


def _estimate(a: argparse.Namespace, em: Emitter) -> dict[str, Any]:
    from mf_demo_parser.benchmark import estimate_capacity

    return estimate_capacity(
        Path(a.benchmark_json),
        maps=a.maps,
        demos_per_map=a.demos_per_map,
        budget_gb=a.budget_gb,
        raw_queue_demos=a.raw_queue_demos,
        curated_raw_fraction=a.curated_raw_fraction,
        out=a.out,
    )


def _build_map_pack(a: argparse.Namespace, em: Emitter) -> dict[str, Any]:
    from mf_features.map_pack import MapPackSettings, build_map_pack

    settings = MapPackSettings(cell_size=a.cell_size, z_cell_size=a.z_cell_size, floor_cell_size=a.floor_cell_size)
    return build_map_pack(
        [Path(p) for p in a.datasets],
        a.map,
        Path(a.out),
        em,
        settings=settings,
        graph_out=Path(a.graph_out) if a.graph_out else None,
        allow_unvalidated=a.allow_unvalidated,
    )


def _validate_map_pack(a: argparse.Namespace, em: Emitter) -> dict[str, Any]:
    from mf_features.map_pack_schema import validate_map_pack_file

    issues = validate_map_pack_file(Path(a.file))
    out: dict[str, Any] = {"file": a.file, "valid": not issues, "issues": issues[:50]}
    if issues:
        out[EXIT_KEY] = errors.EXIT_CHECK_FAILED
    return out


def _measure_utility(a: argparse.Namespace, em: Emitter) -> dict[str, Any]:
    from mf_features.utility_profiles import measure_utility

    return measure_utility([Path(p) for p in a.datasets], Path(a.out), em, min_samples=a.min_samples, allow_unvalidated=a.allow_unvalidated)


def _build_features(a: argparse.Namespace, em: Emitter) -> dict[str, Any]:
    from mf_features.features import build_features

    return build_features(Path(a.dataset), em, force=a.force)


def _check_leakage(a: argparse.Namespace, em: Emitter) -> dict[str, Any]:
    from mf_features.leakage import check_dataset_leakage

    out = check_dataset_leakage(Path(a.dataset), em, cuts=a.cuts)
    if not out["passed"]:
        out[EXIT_KEY] = errors.EXIT_CHECK_FAILED
    return out


def _freeze(a: argparse.Namespace, em: Emitter) -> dict[str, Any]:
    from mf_training.splits import freeze_dataset

    return freeze_dataset(
        [Path(p) for p in a.datasets],
        Path(a.out),
        em,
        seed=a.seed,
        val_fraction=a.val_fraction,
        test_fraction=a.test_fraction,
        allow_unvalidated=a.allow_unvalidated,
    )


def _audit(a: argparse.Namespace, em: Emitter) -> dict[str, Any]:
    from mf_training.splits import audit_split

    out = audit_split(Path(a.manifest), em, datasets=[Path(p) for p in a.datasets] if a.datasets else None)
    if not out["passed"]:
        out[EXIT_KEY] = errors.EXIT_CHECK_FAILED
    return out


def _train(a: argparse.Namespace, em: Emitter) -> dict[str, Any]:
    from mf_training.train import train_model

    return train_model(a.task, Path(a.dataset_manifest), Path(a.out_dir), em, seed=a.seed, feature_set=a.feature_set)


def _evaluate(a: argparse.Namespace, em: Emitter) -> dict[str, Any]:
    from mf_evaluation.evaluate import evaluate_model

    return evaluate_model(Path(a.model_dir), Path(a.dataset_manifest), em, split=a.split, bootstrap=a.bootstrap, seed=a.seed)


def _export(a: argparse.Namespace, em: Emitter) -> dict[str, Any]:
    from mf_training.export import export_model

    return export_model(Path(a.model_dir), Path(a.out), em, parity_count=a.parity_count)


def _promote(a: argparse.Namespace, em: Emitter) -> dict[str, Any]:
    from mf_training.registry import promote

    return promote(Path(a.models_dir), a.model_id, a.to, reason=a.reason)


def _registry(a: argparse.Namespace, em: Emitter) -> dict[str, Any]:
    from mf_training.registry import list_models

    return list_models(Path(a.models_dir))


def _parity_fixture(a: argparse.Namespace, em: Emitter) -> dict[str, Any]:
    from mf_training.synthetic import make_parity_fixture

    return make_parity_fixture(Path(a.out), em, seed=a.seed, parity_count=a.parity_count)


def _doctor(a: argparse.Namespace, em: Emitter) -> dict[str, Any]:
    from .doctor import doctor

    return doctor(em)


def _unpack(a: argparse.Namespace, em: Emitter) -> dict[str, Any]:
    from .unpack import unpack_archive

    return unpack_archive(Path(a.input), Path(a.out_dir), em)


def _storage_test(a: argparse.Namespace, em: Emitter) -> dict[str, Any]:
    from .storage import storage_test

    return storage_test(a.remote_dir, em)


def _upload_dataset(a: argparse.Namespace, em: Emitter) -> dict[str, Any]:
    from .storage import upload_dataset

    return upload_dataset(Path(a.dataset), a.remote_dir, em)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="matchframe-workers", description="Matchframe offline demo pipeline")
    sub = p.add_subparsers(dest="command", required=True)

    def add(name: str, handler: Handler, help_text: str) -> argparse.ArgumentParser:
        sp = sub.add_parser(name, help=help_text)
        sp.set_defaults(handler=handler)
        return sp

    add("doctor", _doctor, "check the Python version and the pipeline's packages")

    sp = add("unpack", _unpack, "take the demos out of a .zip or .rar")
    sp.add_argument("--input", required=True)
    sp.add_argument("--out-dir", required=True)

    sp = add("storage-test", _storage_test, "log in to the FTP storage and write, check and delete a test file (connection from MF_STORAGE_*)")
    sp.add_argument("--remote-dir", default="/matchframe")

    sp = add("upload-dataset", _upload_dataset, "upload a committed dataset to the FTP storage (connection from MF_STORAGE_*)")
    sp.add_argument("--dataset", required=True)
    sp.add_argument("--remote-dir", default="/matchframe")

    sp = add("hash", _hash, "sha256 and size of a file")
    sp.add_argument("--input", required=True)

    sp = add("inspect", _inspect, "header, events and compatibility notes of a demo")
    sp.add_argument("--input", required=True)

    sp = add("extract", _extract, "extract a demo into a committed dataset")
    sp.add_argument("--input", required=True)
    sp.add_argument("--dataset-root", required=True)
    sp.add_argument("--sample-hz", type=float, default=16.0)
    sp.add_argument("--event-window-s", type=float, default=2.0)
    sp.add_argument("--validate", action="store_true", help="run validate after commit and include the verdict")

    sp = add("validate", _validate, "run dataset validation checks (writes validation.json)")
    sp.add_argument("--dataset", required=True)
    sp.add_argument("--expected-map", default=None)

    sp = add("verify", _verify, "re-check checksums and run a sample query")
    sp.add_argument("--dataset", required=True)

    sp = add("benchmark", _benchmark, "extract every demo in a directory and report resource usage")
    sp.add_argument("--inputs", required=True)
    sp.add_argument("--dataset-root", required=True)
    sp.add_argument("--with-features", action="store_true")
    sp.add_argument("--out", default=None, help="also write the result JSON to this file")

    sp = add("estimate", _estimate, "capacity forecast from a benchmark result")
    sp.add_argument("--benchmark-json", required=True)
    sp.add_argument("--maps", type=int, required=True)
    sp.add_argument("--demos-per-map", type=int, default=3000)
    sp.add_argument("--budget-gb", type=float, default=2000.0)
    sp.add_argument("--raw-queue-demos", type=int, default=200)
    sp.add_argument("--curated-raw-fraction", type=float, default=0.02)
    sp.add_argument("--out", default=None)

    sp = add("build-map-pack", _build_map_pack, "build a MapPack JSON from demo place names")
    sp.add_argument("--datasets", nargs="+", required=True)
    sp.add_argument("--map", required=True)
    sp.add_argument("--out", required=True)
    sp.add_argument("--graph-out", default=None)
    sp.add_argument("--cell-size", type=float, default=64.0)
    sp.add_argument("--z-cell-size", type=float, default=128.0)
    sp.add_argument("--floor-cell-size", type=float, default=64.0)
    sp.add_argument("--allow-unvalidated", action="store_true")

    sp = add("validate-map-pack", _validate_map_pack, "validate a MapPack JSON against the contract")
    sp.add_argument("--file", required=True)

    sp = add("measure-utility", _measure_utility, "measure per-type utility profiles from datasets")
    sp.add_argument("--datasets", nargs="+", required=True)
    sp.add_argument("--out", required=True)
    sp.add_argument("--min-samples", type=int, default=5)
    sp.add_argument("--allow-unvalidated", action="store_true")

    sp = add("build-features", _build_features, "causal features + separate future labels for one dataset")
    sp.add_argument("--dataset", required=True)
    sp.add_argument("--force", action="store_true")

    sp = add("check-leakage", _check_leakage, "perturb future frames and assert features are unchanged")
    sp.add_argument("--dataset", required=True)
    sp.add_argument("--cuts", type=int, default=3)

    sp = add("freeze-dataset", _freeze, "freeze a dataset manifest with match-grouped splits")
    sp.add_argument("--datasets", nargs="+", required=True)
    sp.add_argument("--out", required=True)
    sp.add_argument("--seed", type=int, default=20231)
    sp.add_argument("--val-fraction", type=float, default=0.2)
    sp.add_argument("--test-fraction", type=float, default=0.2)
    sp.add_argument("--allow-unvalidated", action="store_true")

    sp = add("audit-split", _audit, "fail if any match/hash/group appears in two splits")
    sp.add_argument("--manifest", required=True)
    sp.add_argument("--datasets", nargs="*", default=None)

    sp = add("train", _train, "train a LightGBM baseline and compare with the heuristic")
    sp.add_argument("--task", required=True, choices=["contact_2s"])
    sp.add_argument("--dataset-manifest", required=True)
    sp.add_argument("--out-dir", required=True)
    sp.add_argument("--seed", type=int, default=7)
    sp.add_argument("--feature-set", choices=["gsi_compatible", "demo_rich"], default="gsi_compatible")

    sp = add("evaluate", _evaluate, "metrics per map with match-level bootstrap CIs")
    sp.add_argument("--model-dir", required=True)
    sp.add_argument("--dataset-manifest", required=True)
    sp.add_argument("--split", default="test", choices=["train", "val", "test"])
    sp.add_argument("--bootstrap", type=int, default=1000)
    sp.add_argument("--seed", type=int, default=11)

    sp = add("export-model", _export, "export LightGBM JSON, model card and parity vectors")
    sp.add_argument("--model-dir", required=True)
    sp.add_argument("--out", required=True)
    sp.add_argument("--parity-count", type=int, default=64)

    sp = add("promote", _promote, "change a model's registry status")
    sp.add_argument("--models-dir", required=True)
    sp.add_argument("--model-id", required=True)
    sp.add_argument("--to", required=True)
    sp.add_argument("--reason", default=None)

    sp = add("registry", _registry, "list registered models")
    sp.add_argument("--models-dir", required=True)

    sp = add("make-parity-fixture", _parity_fixture, "train on synthetic data and export a parity fixture")
    sp.add_argument("--out", required=True)
    sp.add_argument("--seed", type=int, default=1234)
    sp.add_argument("--parity-count", type=int, default=64)
    return p


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:  # argparse already printed usage to stderr
        code = int(exc.code) if isinstance(exc.code, int) else errors.EXIT_USAGE
        if code != 0:
            Emitter("cli").error("USAGE", "invalid command line", argv=list(argv) if argv is not None else sys.argv[1:])
        return code
    em = Emitter(args.command)
    try:
        payload = args.handler(args, em)
    except errors.MfError as exc:
        em.error(exc.code, exc.message, **exc.details)
        return exc.exit_code
    except Exception as exc:  # noqa: BLE001 - last-resort classification for the engine
        em.error(errors.INTERNAL, f"{type(exc).__name__}: {exc}"[:1000], traceback=traceback.format_exc()[-4000:])
        return errors.EXIT_ERROR
    exit_code = int(payload.pop(EXIT_KEY, 0))
    em.result(payload)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
