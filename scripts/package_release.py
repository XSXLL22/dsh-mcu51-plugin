"""Verify the bundled runtime, then build offline ZIP and DSH npm tarball."""
import gzip
import hashlib
import io
import json
import tarfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT.parents[1] / "out" / "mcu51" / "release"


def main():
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    runtime = ROOT / "runtime" / "win32-x64"
    manifest = json.loads((runtime / "manifest.json").read_text(encoding="utf-8"))
    actual = {p.relative_to(runtime).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in runtime.rglob("*") if p.is_file() and p.name != "manifest.json"}
    if manifest["files"] != actual:
        raise RuntimeError("Runtime file set/hash differs from manifest; refusing to package")
    source = runtime / "Lib" / "site-packages" / "stcgal" / "protocols.py"
    header = source.read_text(encoding="utf-8").split("import serial", 1)[0]
    (ROOT / "licenses" / "stcgal-1.10-MIT.txt").write_text("\n".join(line.removeprefix("# ").removeprefix("#") for line in header.splitlines()).strip() + "\n", encoding="utf-8")
    files = {ROOT / "package.json"}
    for entry in package["files"]:
        path = ROOT / entry
        if not path.exists():
            raise RuntimeError(f"Missing required package entry: {entry}")
        files.update(p for p in path.rglob("*") if p.is_file()) if path.is_dir() else files.add(path)
    files = sorted(p for p in files if "__pycache__" not in p.parts and ".tmp" not in p.parts and p.suffix != ".pyc")
    OUT.mkdir(parents=True, exist_ok=True)
    stem = f"{package['name']}-{package['version']}-win32-x64"
    zip_path = OUT / f"{stem}.zip"
    tgz_path = OUT / f"{stem}.tgz"
    for path in (zip_path, tgz_path):
        if path.exists():
            raise RuntimeError(f"Refusing to overwrite release artifact: {path}")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            archive.write(path, package["name"] + "/" + path.relative_to(ROOT).as_posix())
    with tarfile.open(tgz_path, "w:gz") as archive:
        for path in files:
            archive.add(path, "package/" + path.relative_to(ROOT).as_posix(), recursive=False)
    result = {"version": package["version"], "runtimeFilesVerified": len(actual), "packageFiles": len(files),
              "files": {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in files},
              "artifacts": [{"path": str(p), "bytes": p.stat().st_size, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in (zip_path, tgz_path)]}
    (OUT / (stem + ".json")).write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
