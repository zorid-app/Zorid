#!/usr/bin/env python3
"""Extract shipped Obsidian resources without running or changing Obsidian."""
import argparse
import hashlib
import json
import struct
from pathlib import Path


def extract(archive, destination):
    archive = archive.resolve(strict=True)
    destination = destination.resolve()
    entries = []
    archive_size = archive.stat().st_size
    with archive.open('rb') as stream:
        prefix = stream.read(16)
        if len(prefix) != 16:
            raise ValueError('Truncated ASAR header')
        _, header_size, _, json_size = struct.unpack('<4I', prefix)
        if not 0 < json_size <= header_size <= archive_size - 8:
            raise ValueError('Invalid ASAR header size')
        header = json.loads(stream.read(json_size))
        data_start = 8 + header_size

        def visit(files, parent=Path()):
            for name, entry in files.items():
                if name in ('', '.', '..') or '/' in name or '\\' in name:
                    raise ValueError(f'Unsafe archive name: {name!r}')
                relative = parent / name
                target = (destination / relative).resolve()
                if not target.is_relative_to(destination):
                    raise ValueError(f'Path escapes destination: {relative}')
                if 'files' in entry:
                    visit(entry['files'], relative)
                    continue
                if 'link' in entry:
                    raise ValueError(f'Archive links are not supported: {relative}')
                size = int(entry['size'])
                if entry.get('unpacked'):
                    unpacked = Path(str(archive) + '.unpacked').resolve()
                    source = (unpacked / relative).resolve(strict=True)
                    if not source.is_relative_to(unpacked):
                        raise ValueError('Unpacked file escapes companion directory')
                    content = source.read_bytes()
                else:
                    offset = data_start + int(entry['offset'])
                    if size < 0 or offset < data_start or offset + size > archive_size:
                        raise ValueError(f'Invalid byte range: {relative}')
                    stream.seek(offset)
                    content = stream.read(size)
                # App signing/universal merging can change external native binaries
                # after the ASAR header was created. Preserve the installed bytes.
                if len(content) != size and not entry.get('unpacked'):
                    raise ValueError(f'Size mismatch: {relative}')
                digest = hashlib.sha256(content).hexdigest()
                integrity = entry.get('integrity', {})
                integrity_matches = (integrity.get('hash') == digest
                                     if integrity.get('algorithm') == 'SHA256' else None)
                if integrity_matches is False and not entry.get('unpacked'):
                    raise ValueError(f'Integrity mismatch: {relative}')
                target.parent.mkdir(parents=True, exist_ok=True)
                # Never overwrite an edited recovery file on a subsequent run.
                if target.exists():
                    if target.read_bytes() != content:
                        raise FileExistsError(f'Refusing to overwrite changed file: {target}')
                else:
                    target.write_bytes(content)
                entries.append({'path': relative.as_posix(), 'size': len(content),
                                'archive_declared_size': size, 'unpacked': bool(entry.get('unpacked')),
                                'archive_integrity_matches': integrity_matches, 'sha256': digest})

        visit(header['files'])
    manifest = {
        'source': str(archive),
        'archive_sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
        'file_count': len(entries),
        'files': entries,
    }
    (destination / '_recovery-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'{len(entries)} files extracted with SHA-256 manifest in {destination}')
    mismatches = [e['path'] for e in entries if e['archive_integrity_matches'] is False]
    if mismatches:
        print('Installed external binaries differ from archive metadata: ' + ', '.join(mismatches))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    extract(args.archive, args.destination)
