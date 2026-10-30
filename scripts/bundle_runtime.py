"""Build an offline Windows runtime from a licensed CPython installation.

Maintainer-only: python scripts/bundle_runtime.py
The resulting plugin needs neither Python nor pip on the target computer.
No proprietary executables, user configuration or credentials are copied.
"""
import hashlib
import importlib.metadata
import json
import platform
import shutil
import sys
import sysconfig
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGES = {"pyserial": "serial", "stcgal": "stcgal", "Pillow": "PIL", "tqdm": "tqdm", "colorama": "colorama"}
VERSIONS = {"pyserial": "3.5", "stcgal": "1.10", "Pillow": "12.3.0", "tqdm": "4.70.1", "colorama": "0.4.6"}
# Only the DLLs used by the toolbox and its offline tests. CPython's built-in
# hashlib provides SHA256; networking/TLS, Tcl/Tk and CPython test DLLs are not
# part of this runtime. Corresponding notices are retained in LICENSE.txt.
NATIVE_FILES = {"_asyncio.pyd", "_ctypes.pyd", "libffi-8.dll", "_decimal.pyd", "_elementtree.pyd", "_multiprocessing.pyd", "_overlapped.pyd", "_queue.pyd", "_socket.pyd", "_uuid.pyd", "_wmi.pyd", "_zoneinfo.pyd", "pyexpat.pyd", "select.pyd", "unicodedata.pyd"}


def build():
    if sys.platform != "win32" or sysconfig.get_platform() != "win-amd64":
        raise RuntimeError("Build with Windows x64 CPython")
    target = ROOT / "runtime" / "win32-x64"
    if target.exists():
        raise RuntimeError(f"Refusing to overwrite an existing runtime: {target}")
    # Validate all inputs before creating an incomplete runtime.
    distributions = {name: importlib.metadata.distribution(name) for name in PACKAGES}
    for name, dist in distributions.items():
        if dist.version != VERSIONS[name]:
            raise RuntimeError(f"{name}: expected {VERSIONS[name]}, got {dist.version}")
    source = Path(sys.base_prefix)
    target.mkdir(parents=True)
    version_tag = f"python{sys.version_info.major}{sys.version_info.minor}"
    for name in ("python.exe", "python3.dll", f"{version_tag}.dll", "vcruntime140.dll", "vcruntime140_1.dll", "LICENSE.txt"):
        shutil.copy2(source / name, target / name)
    (target / "DLLs").mkdir()
    for name in sorted(NATIVE_FILES):
        shutil.copy2(source / "DLLs" / name, target / "DLLs" / name)
    # zipimport provides the standard library. Exclude unrelated applications,
    # build tools and third-party packages; no registry/site/PATH lookup is used.
    stdlib = Path(sysconfig.get_path("stdlib"))
    skip = {"site-packages", "__pycache__", "test", "tests", "idlelib", "tkinter", "turtledemo", "ensurepip"}
    with zipfile.ZipFile(target / f"{version_tag}.zip", "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(stdlib.rglob("*.py")):
            relative = path.relative_to(stdlib)
            if any(part in skip for part in relative.parts):
                continue
            archive.write(path, relative.as_posix())
    packages_dir = target / "Lib" / "site-packages"
    packages_dir.mkdir(parents=True)
    packages = []
    for name, module in PACKAGES.items():
        dist = distributions[name]
        shutil.copytree(dist.locate_file(module), packages_dir / module, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        metadata_dir = Path(dist._path)
        shutil.copytree(metadata_dir, packages_dir / metadata_dir.name)
        packages.append({"name": name, "version": dist.version, "license": dist.metadata.get("License-Expression") or dist.metadata.get("License"), "source": dist.metadata.get("Home-page")})
    # ._pth puts Windows CPython in isolated mode and ignores user site packages,
    # PYTHONPATH and the registry. Do not add 'import site'.
    (target / f"{version_tag}._pth").write_text(f"{version_tag}.zip\nDLLs\nLib/site-packages\n.\n", encoding="utf-8")
    files = {}
    for path in sorted(target.rglob("*")):
        if path.is_file():
            files[path.relative_to(target).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    manifest = {"format": 1, "platform": "win32-x64", "python": platform.python_version(), "executable": "python.exe", "packages": packages, "files": files}
    (target / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"runtime": str(target), "files": len(files), "bytes": sum(p.stat().st_size for p in target.rglob("*") if p.is_file()), "packages": VERSIONS}))


def prune_existing():
    target = ROOT / "runtime" / "win32-x64"
    # Single-directory, nonrecursive removal within the fixed generated runtime.
    for path in (target / "DLLs").iterdir():
        if path.is_file() and path.name not in NATIVE_FILES:
            path.unlink()
    manifest_path = target / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["files"] = {p.relative_to(target).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(target.rglob("*")) if p.is_file() and p != manifest_path}
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"files": len(manifest["files"]), "bytes": sum(p.stat().st_size for p in target.rglob("*") if p.is_file())}))


if __name__ == "__main__":
    prune_existing() if sys.argv[1:] == ["--prune"] else build()
