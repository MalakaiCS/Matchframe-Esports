"""FTP dataset storage against a real local FTP server (plain and FTPS), and archive unpacking."""

from __future__ import annotations

import hashlib
import ssl
import subprocess
import threading
import zipfile
from collections.abc import Iterator
from pathlib import Path

import pytest

from mf_common import errors
from mf_common.emit import NullEmitter
from mf_common.storage import storage_test, upload_dataset
from mf_common.unpack import unpack_archive
from synthetic_demo import build_dataset

pyftpdlib = pytest.importorskip("pyftpdlib")
from pyftpdlib.authorizers import DummyAuthorizer  # noqa: E402
from pyftpdlib.handlers import FTPHandler  # noqa: E402
from pyftpdlib.servers import FTPServer  # noqa: E402


def _cert(tmp: Path) -> Path:
    pem = tmp / "server.pem"
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=storage.test", "-keyout", str(pem), "-out", str(pem)],
        check=True,
        capture_output=True,
    )
    return pem


@pytest.fixture(params=["plain", "ftps"])
def server(request: pytest.FixtureRequest, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[Path, str | None]]:
    root = tmp_path / "ftp-root"
    root.mkdir()
    auth = DummyAuthorizer()
    auth.add_user("box", "s3cret", str(root), perm="elradfmwMT")
    fingerprint = None
    if request.param == "ftps":
        pytest.importorskip("OpenSSL")
        from pyftpdlib.handlers import TLS_FTPHandler

        pem = _cert(tmp_path)
        handler = type("H", (TLS_FTPHandler,), {"certfile": str(pem), "tls_control_required": True, "tls_data_required": True})
        der = ssl.PEM_cert_to_DER_cert(pem.read_text().split("-----BEGIN CERTIFICATE-----")[1].join(["-----BEGIN CERTIFICATE-----", ""]))
        fingerprint = hashlib.sha256(der).hexdigest()
    else:
        handler = type("H", (FTPHandler,), {})
    handler.authorizer = auth
    handler.auth_failed_timeout = 0.05
    srv = FTPServer(("127.0.0.1", 0), handler)
    port = srv.socket.getsockname()[1]
    t = threading.Thread(target=srv.serve_forever, kwargs={"timeout": 0.2}, daemon=True)
    t.start()
    monkeypatch.setenv("MF_STORAGE_HOST", "127.0.0.1")
    monkeypatch.setenv("MF_STORAGE_PORT", str(port))
    monkeypatch.setenv("MF_STORAGE_USER", "box")
    monkeypatch.setenv("MF_STORAGE_PASSWORD", "s3cret")
    monkeypatch.setenv("MF_STORAGE_SECURE", request.param)
    monkeypatch.delenv("MF_STORAGE_FINGERPRINT", raising=False)
    yield root, fingerprint
    srv.close_all()


def test_connection_test_writes_and_removes_a_file(server: tuple[Path, str | None]) -> None:
    root, fingerprint = server
    out = storage_test("/matchframe", NullEmitter())
    assert out["ok"] is True and out["fingerprint"] == fingerprint
    assert (root / "matchframe").is_dir() and not list((root / "matchframe").iterdir())


def test_upload_is_complete_and_then_skipped(server: tuple[Path, str | None], tmp_path: Path) -> None:
    root, _ = server
    (tmp_path / "data").mkdir()
    ds = build_dataset(tmp_path / "data")
    first = upload_dataset(ds, "/matchframe", NullEmitter())
    assert first["status"] == "uploaded"
    rel = Path(*ds.parts[-3:])
    remote = root / "matchframe" / "datasets" / rel
    assert first["remote"] == "/matchframe/datasets/" + rel.as_posix()
    local = {p.name: p.read_bytes() for p in ds.iterdir() if p.is_file()}
    assert {p.name: p.read_bytes() for p in remote.iterdir()} == local
    # No staging directory left behind.
    assert [p.name for p in remote.parent.iterdir()] == [remote.name]
    assert upload_dataset(ds, "/matchframe", NullEmitter())["status"] == "exists"
    # A changed dataset (features added later) replaces the remote copy.
    (ds / "extra.json").write_text("{}")
    assert upload_dataset(ds, "/matchframe", NullEmitter())["status"] == "uploaded"
    assert (remote / "extra.json").exists() and [p.name for p in remote.parent.iterdir()] == [remote.name]


def test_wrong_password_is_refused(server: tuple[Path, str | None], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MF_STORAGE_PASSWORD", "nope")
    with pytest.raises(errors.MfError) as e:
        storage_test("/matchframe", NullEmitter())
    assert e.value.code == errors.STORAGE_REFUSED, e.value.message


def test_a_changed_certificate_is_refused(server: tuple[Path, str | None], monkeypatch: pytest.MonkeyPatch) -> None:
    _, fingerprint = server
    if fingerprint is None:
        pytest.skip("plain FTP has no certificate")
    monkeypatch.setenv("MF_STORAGE_FINGERPRINT", "00" * 32)
    with pytest.raises(errors.MfError) as e:
        storage_test("/matchframe", NullEmitter())
    assert e.value.code == errors.STORAGE_CERT_CHANGED
    monkeypatch.setenv("MF_STORAGE_FINGERPRINT", fingerprint)
    assert storage_test("/matchframe", NullEmitter())["ok"] is True


def test_ftps_refused_by_a_plain_server(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    auth = DummyAuthorizer()
    auth.add_user("box", "s3cret", str(tmp_path), perm="elradfmw")
    handler = type("H", (FTPHandler,), {})
    handler.authorizer = auth
    srv = FTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, kwargs={"timeout": 0.2}, daemon=True).start()
    try:
        for k, v in {"MF_STORAGE_HOST": "127.0.0.1", "MF_STORAGE_PORT": str(srv.socket.getsockname()[1]), "MF_STORAGE_USER": "box", "MF_STORAGE_PASSWORD": "s3cret", "MF_STORAGE_SECURE": "ftps"}.items():
            monkeypatch.setenv(k, v)
        with pytest.raises(errors.MfError) as e:
            storage_test("/matchframe", NullEmitter())
        assert e.value.code == errors.STORAGE_NO_TLS
    finally:
        srv.close_all()


def test_unpack_takes_only_demos_out_of_a_zip(tmp_path: Path) -> None:
    arc = tmp_path / "match.zip"
    with zipfile.ZipFile(arc, "w") as zf:
        zf.writestr("maps/m1-mirage.dem", b"A" * 100)
        zf.writestr("../../evil.dem", b"B" * 10)
        zf.writestr("readme.txt", b"hi")
    out = unpack_archive(arc, tmp_path / "out", NullEmitter())
    names = sorted(Path(p).name for p in out["files"])
    assert names == ["evil.dem", "m1-mirage.dem"]
    assert all(Path(p).parent == tmp_path / "out" for p in out["files"])
    assert not (tmp_path / "evil.dem").exists()


def test_unpack_refuses_an_archive_without_demos(tmp_path: Path) -> None:
    arc = tmp_path / "empty.zip"
    with zipfile.ZipFile(arc, "w") as zf:
        zf.writestr("readme.txt", b"hi")
    with pytest.raises(errors.MfError) as e:
        unpack_archive(arc, tmp_path / "out", NullEmitter())
    assert e.value.code == errors.EMPTY_PARSE
