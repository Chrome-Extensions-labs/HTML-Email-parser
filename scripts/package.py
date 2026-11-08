"""Build a reproducible ZIP archive of the unpacked Chrome extension.

Only runtime assets are included. Timestamps, ordering and file modes are fixed
so that two builds from the same tree produce byte-identical archives.
"""
from __future__ import annotations

import argparse
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

TOP_LEVEL_FILES = (
    "manifest.json",
    "popup.html",
    "styles.css",
    "content.js",
    "popup.js",
    "LICENSE",
    "README.md",
)
SOURCE_DIRECTORIES = ("shared", "content", "popup", "icons")
ALLOWED_SUFFIXES = frozenset({".js", ".css", ".html", ".png", ".svg", ".json"})


def collect_files() -> list[Path]:
    """Return the sorted, de-duplicated set of files shipped to the store."""
    candidates = {Path(name) for name in TOP_LEVEL_FILES}
    for directory in SOURCE_DIRECTORIES:
        for path in (ROOT / directory).rglob("*"):
            if path.is_file() and path.suffix.lower() in ALLOWED_SUFFIXES:
                candidates.add(path.relative_to(ROOT))
    return sorted(candidates, key=lambda path: path.as_posix())


def validate(files: list[Path]) -> list[str]:
    """Check that top-level assets and every manifest reference are present."""
    problems = [
        path.as_posix()
        for path in files
        if not (ROOT / path).is_file()
    ]
    if problems:
        return [f"missing file: {name}" for name in problems]

    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    references = [
        manifest["action"]["default_popup"],
        manifest["action"]["default_icon"]["128"],
        manifest["icons"]["128"],
    ]
    if manifest.get("background", {}).get("service_worker"):
        references.append(manifest["background"]["service_worker"])

    return [
        f"manifest references a missing file: {reference}"
        for reference in references
        if not (ROOT / reference).is_file()
    ]


def build(output: Path, files: list[Path]) -> None:
    """Write the archive using fixed metadata for deterministic output."""
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in files:
            info = zipfile.ZipInfo(path.as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
            info.external_attr = 0o644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, (ROOT / path).read_bytes())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "extension.zip",
        help="destination archive (default: ./extension.zip)",
    )
    args = parser.parse_args()

    files = collect_files()
    problems = validate(files)
    if problems:
        for problem in problems:
            print(problem)
        return 1

    build(args.output, files)
    print(f"Packaged {len(files)} files into {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
