#!/usr/bin/env python3
"""Fail fast when local, gallery, and production routing contracts drift."""

from __future__ import annotations

import ipaddress
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
PREVIEW_HOST = "image.aituring.xyz"
ENV_LINE = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$")


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        match = ENV_LINE.match(line)
        if not match or line.lstrip().startswith("#"):
            continue
        value = match.group(2).strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        values[match.group(1)] = value
    return values


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def main() -> int:
    example = read_env(ROOT / ".env.example")
    gallery = read_env(ROOT / "frontend/.env.gallery")
    quick_example = read_env(ROOT / "frontend/.env.quick.example")
    cloud_api = example.get("CLOUD_API_BASE_URL", "").rstrip("/")
    require(cloud_api, ".env.example must define CLOUD_API_BASE_URL")
    require(
        "QUICK_ENTRY_TOKEN" in example,
        ".env.example must declare QUICK_ENTRY_TOKEN separately from INGEST_TOKEN",
    )

    parsed_cloud_api = urlparse(cloud_api)
    require(
        parsed_cloud_api.scheme == "http" and parsed_cloud_api.hostname,
        "CLOUD_API_BASE_URL must be an explicit HTTP cloud backend address",
    )
    require(
        parsed_cloud_api.hostname != PREVIEW_HOST,
        "CLOUD_API_BASE_URL must never point at the preview frontend domain",
    )
    try:
        cloud_port = parsed_cloud_api.port
    except ValueError as exc:
        raise ValueError("CLOUD_API_BASE_URL has an invalid port") from exc
    require(
        cloud_port == 8000,
        "CLOUD_API_BASE_URL must target the cloud backend port 8000",
    )
    try:
        ipaddress.ip_address(parsed_cloud_api.hostname)
    except ValueError:
        raise ValueError(
            "CLOUD_API_BASE_URL must use the reviewed cloud server IP, not a frontend or proxy domain"
        )

    require(
        gallery.get("VITE_API_BASE_URL", "") == "",
        "gallery VITE_API_BASE_URL must stay empty so /api remains same-origin",
    )
    require(
        gallery.get("VITE_CLOUD_BACKEND", "").rstrip("/") == cloud_api,
        "gallery VITE_CLOUD_BACKEND must match CLOUD_API_BASE_URL",
    )
    require(
        quick_example.get("VITE_QUICK_ENTRY_API_BASE_URL", "") == "",
        "quick entry must use same-origin /api through the Vite or Vercel proxy",
    )
    require(
        "VITE_QUICK_ENTRY_TOKEN" in quick_example,
        "quick entry example must declare VITE_QUICK_ENTRY_TOKEN",
    )

    vite_source = (ROOT / "frontend/vite.config.ts").read_text(encoding="utf-8")
    require(
        f"env.VITE_CLOUD_BACKEND || env.CLOUD_API_BASE_URL || '{cloud_api}'"
        in vite_source,
        "vite cloud backend fallback must match CLOUD_API_BASE_URL",
    )
    require(
        "'import.meta.env.VITE_AMAP_SCRIPT_SRC'" in vite_source
        and "env.AMAP_SCRIPT_SRC" in vite_source,
        "vite must keep the AMap script URL configurable",
    )
    require(
        "const isQuickEntry = mode === 'quick'" in vite_source
        and "isGallery || isQuickEntry" in vite_source
        and "env.VITE_QUICK_ENTRY_API_BASE_URL || cloudBackend" in vite_source,
        "vite quick entry must proxy /api to the cloud backend",
    )

    vercel = json.loads((ROOT / "frontend/vercel.json").read_text(encoding="utf-8"))
    rewrites = vercel.get("rewrites", [])
    destinations = {rewrite.get("source"): rewrite.get("destination") for rewrite in rewrites}
    require(
        destinations.get("/api/:path*") == f"{cloud_api}/api/:path*",
        "Vercel /api rewrite must target the cloud backend, not the preview frontend",
    )
    require(
        destinations.get("/files/:path*") == f"{cloud_api}/files/:path*",
        "Vercel /files rewrite must target the cloud backend",
    )
    require(
        destinations.get("/quick-entry") == "/quick-entry.html",
        "Vercel quick-entry route must serve the standalone upload page",
    )
    require(
        destinations.get("/(.*)") == "/index.html",
        "Vercel SPA fallback must remain /index.html",
    )

    print("Runtime contracts: OK")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"Runtime contracts: FAILED\n- {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
