"""Verify/extract a generated release, then run it in an isolated environment."""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path


def main():
    archive = Path(sys.argv[1]).resolve()
    node = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else Path(shutil.which('node')).resolve()
    # Keep extraction in the explicit writable artifact directory. Windows
    # sandbox TEMP aliases can permit the first mkdir yet deny nested writes.
    extraction_parent = Path(sys.argv[3]).resolve() if len(sys.argv) > 3 else archive.parent
    extraction_parent.mkdir(parents=True, exist_ok=True)
    target = Path(tempfile.mkdtemp(prefix='verify 中文 ', dir=extraction_parent)).resolve()
    if archive.suffix == '.zip':
        with zipfile.ZipFile(archive) as source:
            for entry in source.namelist():
                if not (target / entry).resolve().is_relative_to(target):
                    raise ValueError('Unsafe archive entry')
            source.extractall(target)
        root = target / 'dsh-mcu51'
    else:
        with tarfile.open(archive) as source:
            source.extractall(target, filter='data')
        root = target / 'package'
    release_manifest = json.loads(archive.with_suffix('.json').read_text(encoding='utf-8'))
    expected_archive = next(item for item in release_manifest['artifacts'] if Path(item['path']).name == archive.name)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != expected_archive['sha256']:
        raise ValueError('Release archive hash differs from manifest')
    actual_files = {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob('*') if p.is_file()}
    if actual_files != release_manifest['files']:
        raise ValueError('Extracted package file set/hash differs from release manifest')
    runtime = root / 'runtime' / 'win32-x64'
    manifest = json.loads((runtime / 'manifest.json').read_text(encoding='utf-8'))
    for relative, expected in manifest['files'].items():
        if hashlib.sha256((runtime / relative).read_bytes()).hexdigest() != expected:
            raise ValueError('Extracted runtime hash mismatch: ' + relative)
    env = dict(os.environ, PATH='', PYTHONHOME=str(target / 'invalid'), PYTHONPATH=str(target / 'invalid'), DSH_MCU51_DATA=str(target / 'user data'))
    checks = [
        [str(node), 'test/smoke.mjs'],
        [str(node), '--test', *[p.relative_to(root).as_posix() for p in sorted((root / 'test').glob('*.test.mjs'))]],
        [str(runtime / 'python.exe'), '-I', '-B', '-m', 'unittest', 'discover', '-s', 'test', '-p', 'test_*.py', '-v'],
    ]
    results = []
    for command in checks:
        result = subprocess.run(command, cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, encoding='utf-8', errors='replace', timeout=60)
        results.append({'command': command[1:], 'exitCode': result.returncode, 'output': result.stdout})
        if result.returncode:
            print(result.stdout)
            raise RuntimeError('Extracted release check failed')
    report = {'archive': str(archive), 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(), 'extractedTo': str(root), 'packageFilesVerified': len(actual_files), 'runtimeFilesVerified': len(manifest['files']), 'hardwareAccess': False, 'allPassed': True, 'checks': results}
    report_path = archive.with_name(archive.name + '.verified.json')
    with report_path.open('x', encoding='utf-8') as output:
        output.write(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps({'archive': str(archive), 'allPassed': True, 'runtimeFilesVerified': len(manifest['files']), 'report': str(report_path)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
