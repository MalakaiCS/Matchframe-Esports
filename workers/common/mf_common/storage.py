"""Dataset storage on an FTP server (``storage-test``, ``upload-dataset``).

The connection comes from the environment, never the command line (process lists show it):
``MF_STORAGE_HOST``, ``MF_STORAGE_PORT`` (21), ``MF_STORAGE_USER``, ``MF_STORAGE_PASSWORD``,
``MF_STORAGE_SECURE`` (``ftps``: explicit TLS for the login and every file, the default; ``plain``:
unencrypted FTP) and ``MF_STORAGE_FINGERPRINT`` (the SHA-256 of the server's TLS certificate seen at
the first successful test; a different certificate is refused).

Storage boxes are mostly reached by IP with self-signed certificates, so the certificate is pinned
on first use rather than checked against a certificate authority.

Uploads go to ``<remote>/datasets/<map=…>/<build=…>/<demo=…>/``: every file into a staging
directory next to it, each size checked, then the staging directory renamed into place, so a
dataset there is always complete.
"""

from __future__ import annotations

import ftplib
import hashlib
import os
import secrets
import socket
import ssl
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import errors
from .datasets import load_dataset
from .emit import Emitter

TIMEOUT_S = 60


@dataclass(frozen=True)
class StorageConfig:
    host: str
    port: int
    user: str
    password: str
    secure: bool
    fingerprint: str | None


def config_from_env() -> StorageConfig:
    host = os.environ.get("MF_STORAGE_HOST", "").strip()
    user = os.environ.get("MF_STORAGE_USER", "").strip()
    if not host or not user:
        raise errors.MfError(errors.STORAGE_NOT_CONFIGURED, "storage host and user are not set")
    secure = os.environ.get("MF_STORAGE_SECURE", "ftps").strip().lower() != "plain"
    fp = os.environ.get("MF_STORAGE_FINGERPRINT", "").strip().lower().replace(":", "") or None
    return StorageConfig(host, int(os.environ.get("MF_STORAGE_PORT", "21") or 21), user, os.environ.get("MF_STORAGE_PASSWORD", ""), secure, fp)


class _FtpTls(ftplib.FTP_TLS):
    """FTPS that reuses the login's TLS session on data connections (many servers require it)."""

    def ntransfercmd(self, cmd: str, rest: int | str | None = None) -> tuple[socket.socket, int | None]:
        conn, size = ftplib.FTP.ntransfercmd(self, cmd, rest)
        if self._prot_p:  # type: ignore[attr-defined]
            conn = self.context.wrap_socket(conn, server_hostname=self.host, session=self.sock.session)  # type: ignore[union-attr]
        return conn, size


def connect(cfg: StorageConfig) -> tuple[ftplib.FTP, str | None]:
    """Logged-in connection in binary mode, and the server certificate's SHA-256 (FTPS)."""
    try:
        if cfg.secure:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE  # pinned below instead
            ftp: ftplib.FTP = _FtpTls(context=ctx, timeout=TIMEOUT_S)
            ftp.connect(cfg.host, cfg.port)
            try:
                ftp.auth()  # type: ignore[attr-defined]
            except ftplib.error_perm as exc:
                ftp.close()
                raise errors.MfError(
                    errors.STORAGE_NO_TLS,
                    f"the storage server doesn't offer encrypted FTP (FTPS): {str(exc)[:120]}. It can be allowed unencrypted in the storage settings.",
                ) from exc
            der = ftp.sock.getpeercert(binary_form=True)  # type: ignore[union-attr]
            fingerprint = hashlib.sha256(der).hexdigest() if der else None
            if cfg.fingerprint and fingerprint != cfg.fingerprint:
                ftp.close()
                raise errors.MfError(
                    errors.STORAGE_CERT_CHANGED,
                    "the storage server's certificate changed since it was trusted; check the server, then test the connection again",
                    expected=cfg.fingerprint,
                    seen=fingerprint,
                )
            ftp.login(cfg.user, cfg.password)
            ftp.prot_p()  # type: ignore[attr-defined]
        else:
            ftp = ftplib.FTP(timeout=TIMEOUT_S)
            ftp.connect(cfg.host, cfg.port)
            ftp.login(cfg.user, cfg.password)
            fingerprint = None
        ftp.voidcmd("TYPE I")
        return ftp, fingerprint
    except errors.MfError:
        raise
    except ftplib.error_perm as exc:
        raise errors.MfError(errors.STORAGE_REFUSED, f"the storage server refused: {str(exc)[:200]}") from exc
    except (OSError, EOFError, ftplib.Error) as exc:
        raise errors.MfError(errors.STORAGE_UNREACHABLE, f"could not connect to {cfg.host}:{cfg.port}: {type(exc).__name__}: {str(exc)[:200]}") from exc


def _join(*parts: str) -> str:
    return "/" + "/".join(p.strip("/") for p in parts if p.strip("/"))


def _exists_dir(ftp: ftplib.FTP, path: str) -> bool:
    cur = ftp.pwd()
    try:
        ftp.cwd(path)
        return True
    except ftplib.error_perm:
        return False
    finally:
        ftp.cwd(cur)


def _makedirs(ftp: ftplib.FTP, path: str) -> None:
    built = ""
    for part in [p for p in path.split("/") if p]:
        built += "/" + part
        if not _exists_dir(ftp, built):
            ftp.mkd(built)


def _remote_sizes(ftp: ftplib.FTP, path: str) -> dict[str, int]:
    """File name → size in a remote directory (MLSD where offered, else NLST + SIZE)."""
    try:
        return {name: int(facts["size"]) for name, facts in ftp.mlsd(path, facts=["type", "size"]) if facts.get("type") == "file" and "size" in facts}
    except ftplib.error_perm:
        out: dict[str, int] = {}
        try:
            entries = ftp.nlst(path)
        except ftplib.error_perm:  # some servers answer an empty directory with 550
            return out
        for entry in entries:
            name = entry.rsplit("/", 1)[-1]
            try:
                size = ftp.size(f"{path}/{name}")
            except ftplib.error_perm:
                continue
            if size is not None:
                out[name] = int(size)
        return out


def _remove_tree(ftp: ftplib.FTP, path: str) -> None:
    for name in _remote_sizes(ftp, path):
        ftp.delete(f"{path}/{name}")
    ftp.rmd(path)


def storage_test(remote_dir: str, emitter: Emitter) -> dict[str, Any]:
    """Logs in, writes, reads back the size of and deletes a small file under ``remote_dir``."""
    cfg = config_from_env()
    ftp, fingerprint = connect(cfg)
    try:
        welcome = (ftp.getwelcome() or "")[:200]
        root = _join(remote_dir)
        _makedirs(ftp, root)
        name = f"{root.rstrip('/')}/.matchframe-test-{secrets.token_hex(4)}"
        body = b"matchframe storage test\n"
        import io

        ftp.storbinary(f"STOR {name}", io.BytesIO(body))
        size = ftp.size(name)
        ftp.delete(name)
        if size is not None and int(size) != len(body):
            raise errors.MfError(errors.STORAGE_VERIFY_FAILED, f"test file came back as {size} bytes, sent {len(body)}")
        emitter.progress("tested", 1.0)
        return {"ok": True, "secure": cfg.secure, "fingerprint": fingerprint, "welcome": welcome, "remote_dir": root}
    finally:
        try:
            ftp.quit()
        except Exception:  # noqa: BLE001 - closing only
            ftp.close()


def upload_dataset(dataset: Path, remote_dir: str, emitter: Emitter) -> dict[str, Any]:
    """Uploads one committed dataset directory; already there with the same files: nothing sent."""
    ref = load_dataset(Path(dataset))
    parts = ref.path.parts[-3:]
    if not (parts[0].startswith("map=") and parts[1].startswith("build=") and parts[2].startswith("demo=")):
        raise errors.MfError(errors.DATASET_INVALID, "dataset directory is not map=…/build=…/demo=…", dataset=str(ref.path))
    files = sorted(p for p in ref.path.iterdir() if p.is_file() and not p.name.startswith("."))
    local = {p.name: p.stat().st_size for p in files}
    total = sum(local.values())
    cfg = config_from_env()
    ftp, _ = connect(cfg)
    try:
        final = _join(remote_dir, "datasets", *parts)
        parent = final.rsplit("/", 1)[0]
        _makedirs(ftp, parent)
        if _exists_dir(ftp, final) and _remote_sizes(ftp, final) == local:
            return {"status": "exists", "remote": final, "files": len(files), "bytes": total}
        token = secrets.token_hex(4)
        staging = f"{final}.partial-{token}"
        ftp.mkd(staging)
        sent = 0
        try:
            for p in files:
                with p.open("rb") as fh:
                    ftp.storbinary(f"STOR {staging}/{p.name}", fh, blocksize=1 << 16)
                remote_size = ftp.size(f"{staging}/{p.name}")
                if remote_size is not None and int(remote_size) != local[p.name]:
                    raise errors.MfError(errors.STORAGE_VERIFY_FAILED, f"{p.name} arrived as {remote_size} bytes, sent {local[p.name]}")
                sent += local[p.name]
                emitter.progress("upload", round(sent / max(total, 1), 3), file=p.name)
        except BaseException:
            try:
                _remove_tree(ftp, staging)
            except Exception:  # noqa: BLE001 - best effort; a later upload uses a new staging name
                pass
            raise
        old = None
        if _exists_dir(ftp, final):
            old = f"{final}.old-{token}"
            ftp.rename(final, old)
        ftp.rename(staging, final)
        if _remote_sizes(ftp, final) != local:
            raise errors.MfError(errors.STORAGE_VERIFY_FAILED, "the uploaded dataset's files don't match the local ones", remote=final)
        if old:
            _remove_tree(ftp, old)
        return {"status": "uploaded", "remote": final, "files": len(files), "bytes": total}
    except ftplib.Error as exc:
        raise errors.MfError(errors.STORAGE_REFUSED, f"the storage server refused: {str(exc)[:200]}") from exc
    except OSError as exc:
        raise errors.MfError(errors.STORAGE_UNREACHABLE, f"the connection to the storage server failed: {type(exc).__name__}: {str(exc)[:200]}") from exc
    finally:
        try:
            ftp.quit()
        except Exception:  # noqa: BLE001 - closing only
            ftp.close()
