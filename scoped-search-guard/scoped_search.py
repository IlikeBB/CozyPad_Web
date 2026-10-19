"""Bounded local filename/literal-text search; standard library only."""
import argparse
import fnmatch
import json
import os
from pathlib import Path

EXCLUDED = {'.git', 'node_modules', '.venv', 'venv', '__pycache__',
            '.pytest_cache', '.cache', 'dist', 'build', 'logs', 'runs',
            'outputs', '.token-guard'}
PRIVATE = {'.env', '.aws', '.ssh', 'credentials', 'id_rsa', 'id_ed25519'}


def positive(value):
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError('must be positive')
    return number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True)
    parser.add_argument('--glob', required=True, help='filename pattern')
    parser.add_argument('--text', help='case-sensitive literal text')
    parser.add_argument('--max-depth', type=positive, default=4)
    parser.add_argument('--max-entries', type=positive, default=5000)
    parser.add_argument('--max-files', type=positive, default=2000)
    parser.add_argument('--max-results', type=positive, default=50)
    parser.add_argument('--max-bytes', type=positive, default=1048576)
    args = parser.parse_args()
    root = Path(args.root).resolve()
    if not root.is_dir():
        parser.error('root must be an existing directory')
    if root == Path(root.anchor) or root == Path.home().resolve():
        parser.error('disk/filesystem root and user home are forbidden')
    results, notices = [], set()
    counts = {'entries': 0, 'candidate_files': 0}
    stack = [(root, 0)]
    stop = False
    while stack and not stop:
        directory, depth = stack.pop()
        try:
            with os.scandir(directory) as entries:
                for entry in entries:
                    if counts['entries'] >= args.max_entries:
                        notices.add('max_entries'); stop = True; break
                    counts['entries'] += 1
                    path = Path(entry.path)
                    try:
                        if entry.is_symlink() or getattr(os.path, 'isjunction', lambda p: False)(entry.path):
                            notices.add('links_skipped'); continue
                        resolved = path.resolve()
                        if not resolved.is_relative_to(root):
                            notices.add('outside_root_skipped'); continue
                        name = entry.name.lower()
                        if name in PRIVATE or name.startswith('.env.') or path.suffix.lower() in {'.pem', '.key', '.pfx', '.p12'}:
                            notices.add('private_names_skipped'); continue
                        if entry.is_dir(follow_symlinks=False):
                            if name in EXCLUDED:
                                notices.add('excluded_directories'); continue
                            if depth >= args.max_depth:
                                notices.add('max_depth'); continue
                            stack.append((path, depth + 1))
                            continue
                        if not entry.is_file(follow_symlinks=False) or not fnmatch.fnmatch(entry.name, args.glob):
                            continue
                        if counts['candidate_files'] >= args.max_files:
                            notices.add('max_files'); stop = True; break
                        counts['candidate_files'] += 1
                        if args.text is None:
                            results.append({'path': str(path)})
                        else:
                            with path.open('rb') as source:
                                raw = source.read(args.max_bytes + 1)
                            if len(raw) > args.max_bytes:
                                notices.add('large_files_skipped'); continue
                            if b'\x00' in raw:
                                notices.add('binary_files_skipped'); continue
                            try:
                                content = raw.decode('utf-8-sig')
                            except UnicodeDecodeError:
                                notices.add('non_utf8_files_skipped'); continue
                            for line_number, line in enumerate(content.splitlines(), 1):
                                if args.text in line:
                                    results.append({'path': str(path), 'line': line_number,
                                                    'excerpt': line[:240]})
                                    if len(results) >= args.max_results:
                                        break
                        if len(results) >= args.max_results:
                            notices.add('max_results'); stop = True; break
                    except OSError:
                        notices.add('entry_read_error')
        except OSError:
            notices.add('directory_read_error')
    print(json.dumps({'root': str(root), 'complete': not notices,
                      'counts': counts, 'limitations': sorted(notices),
                      'results': results}, ensure_ascii=True, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
