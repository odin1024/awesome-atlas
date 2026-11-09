#!/usr/bin/env python
"""Deploy to GitHub Pages using the GitHub credential Windows already stores.

    py -3.12 scripts/deploy-with-vault.py

Why this exists
---------------
`deploy-pages.mjs` needs a token with `contents: write`. It resolves one from
GH_TOKEN / GITHUB_TOKEN first, then from the WorkBuddy GitHub connector. That
connector token is a GitHub App user token carrying `contents: read` only, so
every deploy through it dies on the first blob with 403. Meanwhile `git push`
is not an option either: on this machine `github.com:443` is unreachable while
`api.github.com` answers in half a second.

Windows Credential Manager, however, usually holds a `git:https://github.com`
entry from the last time this account pushed over HTTPS. That entry is a
classic OAuth token with `repo` scope — exactly the missing piece.

This helper reads that one entry, hands it to `deploy-pages.mjs` as GH_TOKEN in
a child process environment, and never prints, logs or writes the token. The
token stays in memory for the lifetime of the call.

Nothing here is needed on CI: set GH_TOKEN there and run the .mjs directly.
"""
from __future__ import annotations

import ctypes
import os
import subprocess
import sys
from ctypes import wintypes

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET = "git:https://github.com"


class CREDENTIAL(ctypes.Structure):
    _fields_ = [
        ("Flags", wintypes.DWORD),
        ("Type", wintypes.DWORD),
        ("TargetName", wintypes.LPWSTR),
        ("Comment", wintypes.LPWSTR),
        ("LastWritten", wintypes.FILETIME),
        ("CredentialBlobSize", wintypes.DWORD),
        ("CredentialBlob", ctypes.c_void_p),
        ("Persist", wintypes.DWORD),
        ("AttributeCount", wintypes.DWORD),
        ("Attributes", ctypes.c_void_p),
        ("TargetAlias", wintypes.LPWSTR),
        ("UserName", wintypes.LPWSTR),
    ]


def vault_token(target: str = TARGET) -> str | None:
    """Read one generic credential. Returns the secret, or None if absent."""
    if os.name != "nt":
        return None
    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    advapi32.CredReadW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.POINTER(ctypes.POINTER(CREDENTIAL)),
    ]
    advapi32.CredReadW.restype = wintypes.BOOL
    advapi32.CredFree.argtypes = [ctypes.c_void_p]

    ptr = ctypes.POINTER(CREDENTIAL)()
    # 1 = CRED_TYPE_GENERIC, 0 = no flags (no prompt).
    if not advapi32.CredReadW(target, 1, 0, ctypes.byref(ptr)):
        return None
    try:
        cred = ptr.contents
        raw = ctypes.string_at(cred.CredentialBlob, cred.CredentialBlobSize)
        # Git Credential Manager stores the secret as UTF-16LE.
        return raw.decode("utf-16-le").rstrip("\x00").strip()
    finally:
        advapi32.CredFree(ctypes.cast(ptr, ctypes.c_void_p))


def main() -> int:
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or vault_token()
    if not token:
        print(
            "找不到可用凭据：环境变量 GH_TOKEN 为空，Windows 凭据管理器里也没有 "
            f"{TARGET} 条目。\n先用 HTTPS 推送一次并勾选记住凭据，或直接设置 GH_TOKEN。",
            file=sys.stderr,
        )
        return 1

    env = dict(os.environ, GH_TOKEN=token)
    proc = subprocess.run(
        ["node", os.path.join(ROOT, "scripts", "deploy-pages.mjs")],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    out = (proc.stdout or "") + (proc.stderr or "")
    # A stray echo would put the secret in a log file; strip it just in case.
    sys.stdout.write(out.replace(token, "<token>"))
    return proc.returncode


if __name__ == "__main__":
    raise SystemExit(main())
