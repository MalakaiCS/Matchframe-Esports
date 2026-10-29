"""Typed pipeline errors. Every failure the TypeScript engine must react to carries a stable code."""

from __future__ import annotations

from typing import Any

#: Exit code for crashes / errors (an ``{"type":"error"}`` line is emitted).
EXIT_ERROR = 1
#: Exit code for bad command-line usage.
EXIT_USAGE = 2
#: Exit code when a command ran to completion but its verdict is negative
#: (validation → quarantine, verify mismatch, split leak, leakage detected, refused promotion).
EXIT_CHECK_FAILED = 3


class MfError(Exception):
    """An expected, classified failure. ``code`` is part of the engine contract."""

    def __init__(self, code: str, message: str, *, exit_code: int = EXIT_ERROR, **details: Any) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.exit_code = exit_code
        self.details = details


# Stable error codes (documented in workers/README.md).
INPUT_NOT_FOUND = "INPUT_NOT_FOUND"
INPUT_UNREADABLE = "INPUT_UNREADABLE"
UNSUPPORTED_FORMAT = "UNSUPPORTED_FORMAT"
PARSER_FAILED = "PARSER_FAILED"
EMPTY_PARSE = "EMPTY_PARSE"
DATASET_CONFLICT = "DATASET_CONFLICT"
DATASET_NOT_FOUND = "DATASET_NOT_FOUND"
DATASET_INVALID = "DATASET_INVALID"
FEATURES_MISSING = "FEATURES_MISSING"
LEAKAGE_DETECTED = "LEAKAGE_DETECTED"
SPLIT_LEAK = "SPLIT_LEAK"
INSUFFICIENT_DATA = "INSUFFICIENT_DATA"
MODEL_NOT_FOUND = "MODEL_NOT_FOUND"
STORAGE_NOT_CONFIGURED = "STORAGE_NOT_CONFIGURED"
STORAGE_UNREACHABLE = "STORAGE_UNREACHABLE"
STORAGE_REFUSED = "STORAGE_REFUSED"
STORAGE_NO_TLS = "STORAGE_NO_TLS"
STORAGE_CERT_CHANGED = "STORAGE_CERT_CHANGED"
STORAGE_VERIFY_FAILED = "STORAGE_VERIFY_FAILED"
ARCHIVE_UNSUPPORTED = "ARCHIVE_UNSUPPORTED"
PROMOTION_REFUSED = "PROMOTION_REFUSED"
SCHEMA_INVALID = "SCHEMA_INVALID"
INTERNAL = "INTERNAL"
