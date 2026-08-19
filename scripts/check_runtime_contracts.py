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
PUBLIC_API_ORIGIN = "https://api.aituring.xyz"
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
    vercel_example = read_env(ROOT / "frontend/.env.vercel.example")
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
        vercel_example.get("VITE_CLOUD_ONLY", "") == "true"
        and vercel_example.get("VITE_API_BASE_URL", "").rstrip("/") == PUBLIC_API_ORIGIN,
        "Vercel production example must use the HTTPS public API origin",
    )
    require(
        quick_example.get("QUICK_ENTRY_API_BASE_URL", "") == "",
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
        and "env.QUICK_ENTRY_API_BASE_URL || env.VITE_QUICK_ENTRY_API_BASE_URL || cloudBackend"
        in vite_source,
        "vite quick entry must proxy /api to the cloud backend",
    )

    app_source = (ROOT / "frontend/src/App.tsx").read_text(encoding="utf-8")
    require(
        'const quickEntryApiBaseUrl = ""' in app_source
        and "import.meta.env.VITE_QUICK_ENTRY_API_BASE_URL" not in app_source,
        "quick-entry browser requests must remain same-origin and never bypass the proxy",
    )
    require(
        "enableAutomaticFilenameParsing={quickEntryOnly}" in app_source,
        "quick entry must automatically parse supported compound filenames",
    )

    quick_entry_html = (ROOT / "frontend/quick-entry.html").read_text(
        encoding="utf-8"
    )
    require(
        'data-app-entry="quick-entry"' in quick_entry_html
        and 'src="/src/main.tsx"' in quick_entry_html,
        "quick entry must render the original EXIF workbench application",
    )
    require(
        not (ROOT / "frontend/src/features/quick-entry/QuickEntryPage.tsx").exists(),
        "the rejected simplified quick-entry page must not replace the EXIF workbench",
    )
    exif_submission = (
        ROOT / "frontend/src/features/exif/lib/exifSubmission.ts"
    ).read_text(encoding="utf-8")
    workflow_markers = [
        "verifyWritablePermission(directoryHandle)",
        "/api/artifacts/prepare-exif-file",
        "getFileHandle(target.fileName, { create: true })",
        "createWritable()",
        "removeEntry(target.originalFileName)",
        "/api/artifacts/extract-exif-file",
        "/api/ingest/artifacts",
    ]
    marker_positions = [exif_submission.find(marker) for marker in workflow_markers]
    require(
        all(position >= 0 for position in marker_positions)
        and marker_positions == sorted(marker_positions),
        "quick entry order must remain permission -> prepare EXIF -> rename/write -> verify EXIF -> cloud upload",
    )
    require(
        '"X-Quick-Entry-Token": cloudIngestToken' in exif_submission,
        "quick entry direct cloud upload must use the dedicated browser token",
    )

    vercel = json.loads((ROOT / "frontend/vercel.json").read_text(encoding="utf-8"))
    require(
        "api.aituring.xyz" in vercel.get("$comment", "")
        and "quick-entry" in vercel.get("$comment", ""),
        "Vercel config must document direct production API access and the quick-entry rewrite exception",
    )
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
        "Vercel quick-entry route must serve the EXIF quick-entry page",
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
