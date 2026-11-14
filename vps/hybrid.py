"""Bounded, deterministic hybrid wire bundles. Never apply to a live tree."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
import unicodedata
import uuid

SMALL_LIMIT = 3 * 1024 * 1024
BUNDLE_LIMIT = 16 * 1024 * 1024
FILE_LIMIT = 2000
HEADER_LIMIT = 1024 * 1024
MAGIC = b'TSHYB001'
PROTOCOL = 'hybrid-v2'


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def digest(value):
    return hashlib.sha256(canonical(value).encode('utf-8')).hexdigest()


def check(value, message):
    if not value:
        raise ValueError(message)


def safe_path(name):
    check(isinstance(name, str) and 0 < len(name) <= 220 and '\\' not in name, 'invalid path')
    for part in name.split('/'):
        check(part and part not in ('.', '..', '.tavernsyn-partial', '__proto__', 'prototype', 'constructor') and len(part) <= 120
              and not re.search(r'[<>:"|?*\x00-\x1f\x7f]', part) and not part.endswith(('.', ' '))
              and not re.match(r'^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)', part, re.I), 'invalid path')
    return name


def validate_manifest(manifest):
    check(isinstance(manifest, dict) and manifest.get('format') == 1 and isinstance(manifest.get('files'), list) and len(manifest['files']) <= 200000, 'invalid manifest')
    seen = set()
    for f in manifest['files']:
        name = safe_path(f['path'])
        key = unicodedata.normalize('NFC', name).lower()
        check(key not in seen and type(f.get('size')) is int and 0 <= f['size'] <= 9007199254740991 and type(f.get('mtime')) is int and abs(f['mtime']) <= 9007199254740991 and re.fullmatch(r'[a-f0-9]{64}', f.get('sha256', '')), 'invalid manifest entry')
        seen.add(key)
    files = sorted(manifest['files'], key=lambda f: f['path'].encode('utf-8'))
    check(digest([{k: f[k] for k in ('path', 'size', 'sha256')} for f in files]) == manifest.get('digest') and sum(f['size'] for f in files) == manifest.get('bytes'), 'invalid manifest digest')


def create_plan(binding, manifest, changed):
    validate_manifest(manifest)
    check(all(isinstance(binding.get(k), str) and re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', binding[k]) for k in ('job', 'dataset', 'generation')) and (binding.get('base') is None or re.fullmatch(r'[a-f0-9]{64}', binding['base'])) and (binding.get('scope') is None or isinstance(binding['scope'], list)), 'invalid binding')
    scope = binding.get('scope')
    check(scope is None or (scope and scope == sorted(set(scope)) and all(x in ('chats', 'characters', 'worlds') for x in scope)), 'invalid scope')
    check(isinstance(changed, list) and len(changed) == len(set(changed)), 'invalid changes')
    selected = set(changed)
    files = [f for f in sorted(manifest['files'], key=lambda f: f['path'].encode('utf-8')) if f['path'] in selected]
    check(len(files) == len(selected), 'changes outside manifest')
    groups, large, group, size = [], [], [], 0
    for f in files:
        if f['size'] > SMALL_LIMIT:
            large.append(f['path'])
            continue
        if group and (len(group) == FILE_LIMIT or size + f['size'] > BUNDLE_LIMIT):
            groups.append(group)
            group, size = [], 0
        group.append({k: f[k] for k in ('path', 'size', 'sha256', 'mtime')})
        size += f['size']
    if group:
        groups.append(group)
    plan = dict(format=1, protocol=PROTOCOL, job=binding['job'], dataset=binding['dataset'], generation=binding['generation'], base=binding.get('base'), scope=binding.get('scope'), manifestDigest=manifest['digest'], groups=groups, large=large)
    return dict(plan, digest=digest(plan))


def validate_plan(plan, manifest):
    validate_manifest(manifest)
    check(isinstance(plan, dict) and plan.get('format') == 1 and plan.get('protocol') == PROTOCOL and plan.get('manifestDigest') == manifest['digest'] and isinstance(plan.get('groups'), list) and isinstance(plan.get('large'), list), 'invalid plan')
    body = {k: v for k, v in plan.items() if k != 'digest'}
    check(plan.get('digest') == digest(body), 'plan digest mismatch')
    names = [f['path'] for group in plan['groups'] for f in group] + plan['large']
    check(canonical(create_plan(plan, manifest, names)) == canonical(plan), 'plan does not match manifest')
    return plan


def no_links(file):
    file = Path(file).absolute()
    current = Path(file.anchor)
    for part in file.parts[1:]:
        current = current / part
        try:
            check(not stat.S_ISLNK(current.lstat().st_mode), 'symlink rejected')
        except FileNotFoundError:
            break
    return file


def regular(file):
    s = no_links(file).lstat()
    check(stat.S_ISREG(s.st_mode), 'not a regular file')
    return s


def header(plan, index):
    check(type(index) is int and 0 <= index < len(plan['groups']), 'invalid bundle index')
    return dict(format=1, planDigest=plan['digest'], index=index, files=plan['groups'][index])


def create_bundle(root, target, plan, manifest, index):
    validate_plan(plan, manifest)
    head = canonical(header(plan, index)).encode('utf-8')
    check(len(head) <= HEADER_LIMIT, 'header too large')
    chunks = []
    for f in plan['groups'][index]:
        p = no_links(Path(root).joinpath(*f['path'].split('/')))
        before = regular(p)
        data = p.read_bytes()
        after = regular(p)
        check(before.st_size == after.st_size == f['size'] and before.st_mtime_ns == after.st_mtime_ns and before.st_ctime_ns == after.st_ctime_ns and hashlib.sha256(data).hexdigest() == f['sha256'], 'source changed')
        chunks.append(data)
    data = MAGIC + struct.pack('>I', len(head)) + head + b''.join(chunks)
    target = no_links(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    no_links(target)
    temp = target.with_name(target.name + '.' + str(uuid.uuid4()) + '.tmp')
    try:
        with open(temp, 'xb') as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        if target.exists():
            regular(target)
            if hashlib.sha256(target.read_bytes()).digest() != hashlib.sha256(data).digest():
                os.replace(temp, target)
        else:
            os.rename(temp, target)
    finally:
        temp.unlink(missing_ok=True)
    return dict(size=len(data), sha256=hashlib.sha256(data).hexdigest())


def verify_bundle(file, plan, manifest, index, expected_hash):
    validate_plan(plan, manifest)
    check(re.fullmatch(r'[a-f0-9]{64}', expected_hash or ''), 'invalid bundle hash')
    size = regular(file).st_size
    check(size <= 12 + HEADER_LIMIT + BUNDLE_LIMIT, 'bundle too large')
    data = Path(file).read_bytes()
    check(hashlib.sha256(data).hexdigest() == expected_hash and len(data) >= 12 and data[:8] == MAGIC, 'invalid bundle hash or magic')
    length = struct.unpack('>I', data[8:12])[0]
    check(length <= HEADER_LIMIT and 12 + length <= len(data) and data[12:12+length] == canonical(header(plan, index)).encode('utf-8'), 'invalid bundle header')
    offset, entries = 12 + length, []
    for f in plan['groups'][index]:
        end = offset + f['size']
        chunk = data[offset:end]
        check(end <= len(data) and hashlib.sha256(chunk).hexdigest() == f['sha256'], 'bundle file corrupt')
        entries.append((f, chunk))
        offset = end
    check(offset == len(data), 'bundle trailing bytes')
    return entries


def apply_bundle(file, root, plan, manifest, index, expected_hash):
    entries = verify_bundle(file, plan, manifest, index, expected_hash)
    root = no_links(root)
    root.mkdir(parents=True, exist_ok=True)
    for f, data in entries:
        target = no_links(root.joinpath(*f['path'].split('/')))
        target.parent.mkdir(parents=True, exist_ok=True)
        no_links(target)
        temp = target.with_name(target.name + '.' + str(uuid.uuid4()) + '.tmp')
        try:
            with open(temp, 'xb') as out:
                out.write(data)
                out.flush()
                os.fsync(out.fileno())
            os.utime(temp, (f['mtime'], f['mtime']))
            no_links(target)
            os.replace(temp, target)
        finally:
            temp.unlink(missing_ok=True)
