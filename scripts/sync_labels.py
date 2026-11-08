"""Synchronise repository labels with .github/labels.yml.

Uses the GitHub REST API directly so label management does not depend on a
third-party action. Only labels defined in the file are touched; unknown labels
already present in the repository are left alone.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
LABELS_FILE = ROOT / ".github" / "labels.yml"
API_ROOT = "https://api.github.com"


def load_definitions(path: Path) -> list[dict[str, str]]:
    """Parse and validate the label definitions file."""
    try:
        import yaml  # type: ignore[import-not-found]
    except ImportError:
        raise SystemExit("PyYAML is required to sync labels") from None

    with path.open(encoding="utf-8") as handle:
        definitions = yaml.safe_load(handle) or []

    if not isinstance(definitions, list):
        raise SystemExit("labels.yml must contain a list")

    labels: list[dict[str, str]] = []
    for entry in definitions:
        if not isinstance(entry, dict) or not entry.get("name"):
            raise SystemExit("every label requires a name")
        color = str(entry.get("color", "")).lstrip("#")
        if len(color) != 6 or any(char not in "0123456789abcdefABCDEF" for char in color):
            raise SystemExit(f"invalid colour for label {entry['name']!r}")
        labels.append({
            "name": str(entry["name"]),
            "color": color.lower(),
            "description": str(entry.get("description", "")),
        })
    return labels


def request(method: str, url: str, token: str, payload: Any = None) -> tuple[int, Any]:
    """Perform one authenticated API call, returning status and decoded body."""
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "User-Agent": "html-email-parser-label-sync",
    }
    body = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(payload).encode("utf-8")

    call = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(call, timeout=30) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        return error.code, {}


def existing_labels(repo: str, token: str) -> dict[str, dict[str, str]]:
    """Read all labels, including pagination beyond the first page."""
    labels: dict[str, dict[str, str]] = {}
    page = 1
    while True:
        url = f"{API_ROOT}/repos/{repo}/labels?per_page=100&page={page}"
        status, body = request("GET", url, token)
        if status != 200 or not isinstance(body, list):
            raise SystemExit(f"failed to list labels (HTTP {status})")
        for label in body:
            labels[str(label["name"]).lower()] = {
                "color": str(label.get("color", "")).lower(),
                "description": str(label.get("description") or ""),
            }
        if len(body) < 100:
            return labels
        page += 1


def main() -> int:
    repo = os.environ.get("REPOSITORY") or os.environ.get("GITHUB_REPOSITORY", "")
    token = os.environ.get("GITHUB_TOKEN", "")
    if not repo or not token:
        print("REPOSITORY and GITHUB_TOKEN are required", file=sys.stderr)
        return 2

    definitions = load_definitions(LABELS_FILE)
    current = existing_labels(repo, token)
    created = updated = unchanged = 0

    for label in definitions:
        name = label["name"]
        existing = current.get(name.lower())
        if existing is None:
            status, _ = request("POST", f"{API_ROOT}/repos/{repo}/labels", token, label)
            if status not in (200, 201):
                raise SystemExit(f"failed to create label {name!r} (HTTP {status})")
            created += 1
        elif existing["color"] == label["color"] and existing["description"] == label["description"]:
            unchanged += 1
        else:
            quoted = urllib.parse.quote(name, safe="")
            url = f"{API_ROOT}/repos/{repo}/labels/{quoted}"
            status, _ = request("PATCH", url, token, label)
            if status != 200:
                raise SystemExit(f"failed to update label {name!r} (HTTP {status})")
            updated += 1

    print(f"Labels: {created} created, {updated} updated, {unchanged} unchanged")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
