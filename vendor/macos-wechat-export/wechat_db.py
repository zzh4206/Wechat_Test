#!/usr/bin/env python3
"""Read-only WeChat 4.x CLI. No sending, key extraction, or remote service."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import time
from sqlcipher_probe import DB, load_key, verify


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def literal(text):
    return "CAST(x'" + text.encode().hex() + "' AS TEXT)"


def private_write(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    # Atomic replacement; no readable intermediate plaintext file.
    import tempfile
    fd, tmp = tempfile.mkstemp(prefix='.state-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(data, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def root_for(value=None):
    if value:
        return Path(value).resolve(strict=True)
    roots = list((Path.home()/'Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files').glob('*/db_storage'))
    if len(roots) != 1:
        raise RuntimeError('select_account_with_--db-root')
    return roots[0].resolve()


class Reader:
    def __init__(self, root, key_file):
        self.root, self.keys = Path(root), Path(key_file)

    def open(self, path):
        return DB(path, load_key(self.keys, path))

    def resolve(self, name):
        with self.open(self.root/'contact/contact.db') as db:
            rows = db.query('SELECT username,nick_name,remark FROM contact WHERE '
                            f'username={literal(name)} OR nick_name={literal(name)} OR remark={literal(name)}')
        # Never select the first of multiple same-name contacts.
        return rows

    def paths(self, chat):
        table = 'Msg_' + hashlib.md5(chat.encode()).hexdigest()
        found = []
        paths = sorted((self.root/'message').glob('message_*.db'))
        if not paths:
            raise RuntimeError('message_databases_missing')
        for path in paths:
            with self.open(path) as db:
                if db.query(f"SELECT 1 FROM sqlite_master WHERE name='{table}' AND type='table'"):
                    found.append((path, table))
        if not found:
            raise RuntimeError('conversation_has_no_local_message_table')
        return found

    def snapshot(self, chat):
        cursor, salts = {}, {}
        for path, table in self.paths(chat):
            with self.open(path) as db:
                cursor[path.name] = int(db.query(f'SELECT coalesce(max(local_id),0) AS n FROM "{table}"')[0]['n'])
            with path.open('rb') as f:
                salts[path.name] = f.read(16).hex()
        return {'cursor':cursor, 'salts':salts}

    def read(self, chat, limit=20, after=None, self_id=None, before_id=None):
        # --before-id 向前翻页（T1.5 追赶补读）：读 local_id 严格小于该值的最新 limit 条。
        # local_id 是分库局部 id，只在单个 message_*.db 内可比；这里按各库分别过滤后再
        # 聚合取最新 limit 条（与 after=None 的多库聚合语义一致），绝不跨库比较大小。
        if after is not None and before_id is not None:
            raise RuntimeError('after_and_before_id_are_mutually_exclusive')
        result = []
        for path, table in self.paths(chat):
            with self.open(path) as db:
                if self_id and len(db.query(f'SELECT rowid FROM Name2Id WHERE user_name={literal(self_id)}')) != 1:
                    raise RuntimeError('self_id_not_found_in_message_database')
                if after is not None:
                    clause = f'WHERE local_id>{int(after.get(path.name, 0))}'
                elif before_id is not None:
                    clause = f'WHERE local_id<{int(before_id)}'
                else:
                    clause = ''
                order = 'DESC' if after is None else 'ASC'
                rows = db.query('SELECT local_id,server_id,local_type,create_time,real_sender_id,'
                                'hex(message_content) AS body FROM "'+table+'" '+clause+
                                f' ORDER BY local_id {order} LIMIT {int(limit)}')
                for row in rows:
                    sender = db.query('SELECT user_name FROM Name2Id WHERE rowid='+str(int(row['real_sender_id'])))
                    sender_id = sender[0]['user_name'] if len(sender) == 1 else None
                    raw = bytes.fromhex(row.pop('body'))
                    row.update(database=path.name, sender_id=sender_id,
                               from_self=(sender_id == self_id) if sender_id is not None and self_id is not None else None)
                    row['text'] = None
                    if int(row['local_type']) == 1:
                        if raw.startswith(b'\x28\xb5\x2f\xfd'):
                            from compression import zstd
                            raw = zstd.decompress(raw)
                        body = raw.decode('utf8', 'strict')
                        # Group received text includes sender prefix; preserve text following it.
                        if chat.endswith('@chatroom') and sender_id and body.startswith(sender_id+':\n'):
                            body = body[len(sender_id)+2:]
                        row['text'] = body
                    else:
                        row['omitted'] = 'non_text_message; XML/media credentials are not exported'
                    result.append(row)
        result.sort(key=lambda r:(int(r['create_time']), r['database'], int(r['local_id'])))
        return result[-limit:] if after is None else result

    # File-attachment message type (appmsg type=6), same constant as media_pipeline.
    FILE_MESSAGE = 6 << 32 | 49

    @staticmethod
    def _content_bytes(hex_body):
        raw = bytes.fromhex(hex_body)
        if raw.startswith(b'\x28\xb5\x2f\xfd'):
            from compression import zstd
            raw = zstd.decompress(raw)
        return raw

    @staticmethod
    def _attachment_info(raw):
        """Parse attachment metadata from appmsg XML: (name, size, md5) or None."""
        import re
        import xml.etree.ElementTree as ET
        begin = raw.find(b'<')
        if begin < 0:
            return None
        try:
            root = ET.fromstring(raw[begin:])
        except ET.ParseError:
            return None
        if root.findtext('.//appmsg/type') != '6':
            return None
        name = root.findtext('.//appmsg/title') or ''
        size = int(root.findtext('.//appattach/totallen') or '0')
        digest = (root.findtext('.//appattach/md5') or root.findtext('.//md5') or '').lower()
        if not name or name in ('.', '..') or any(c in name for c in ('/', '\\', '\x00')) or len(name) > 255:
            return None
        if not 0 < size <= 200 * 1024 * 1024 or not re.fullmatch('[0-9a-f]{32}', digest):
            return None
        return name, size, digest

    def files(self, chat, limit=20):
        """List file-attachment messages of a conversation with their local storage paths.

        Read-only; mirrors media_pipeline.attachment_path locating logic (month folder
        under msg/file, validated by size AND content digest). Entries whose file is
        missing/changed come back with available=false and path=null.
        """
        rows = []
        from datetime import datetime
        for path, table in self.paths(chat):
            with self.open(path) as db:
                found = db.query(
                    'SELECT local_id,server_id,create_time,hex(message_content) AS body FROM "'
                    + table + '" WHERE local_type=' + str(self.FILE_MESSAGE))
                for row in found:
                    row['database'] = path.name
                    rows.append(row)
        rows.sort(key=lambda r: (int(r['create_time']), r['database'], int(r['local_id'])))
        rows = rows[-int(limit):]
        result = []
        for row in rows:
            entry = {'msg_id': str(row['server_id']), 'name': None, 'path': None, 'available': False}
            try:
                info = self._attachment_info(self._content_bytes(row['body']))
            except Exception:
                info = None
            if info is None:
                result.append(entry)
                continue
            name, size, digest = info
            entry['name'] = name
            month = datetime.fromtimestamp(int(row['create_time'])).strftime('%Y-%m')
            folder = (self.root.parent / 'msg/file' / month).resolve()
            path = folder / name
            if not path.is_file() or path.is_symlink() or path.resolve().parent != folder \
                    or path.stat().st_size != size:
                result.append(entry)  # not downloaded (or renamed): available stays false
                continue
            with path.open('rb') as f:
                if hashlib.file_digest(f, 'md5').hexdigest() != digest:
                    result.append(entry)  # content changed on disk: do not report a path
                    continue
            entry['path'] = str(path)
            entry['available'] = True
            result.append(entry)
        return result

    def init_state(self, chat, self_id):
        value = self.snapshot(chat)
        value.update(version=1, chat_id=chat, self_id=self_id,
                     root_hash=hashlib.sha256(str(self.root.resolve()).encode()).hexdigest())
        return value

    def check(self, state, limit=200):
        if state['root_hash'] != hashlib.sha256(str(self.root.resolve()).encode()).hexdigest():
            raise RuntimeError('state_account_mismatch')
        now = self.snapshot(state['chat_id'])
        for name, salt in state['salts'].items():
            if now['salts'].get(name) != salt or now['cursor'].get(name, -1) < state['cursor'].get(name,0):
                raise RuntimeError('database_replaced_or_cursor_regressed; inspect before reinitializing')
        rows = self.read(state['chat_id'], limit, state['cursor'], state['self_id'])
        cursor = dict(state['cursor'])
        for row in rows:
            cursor[row['database']] = max(cursor.get(row['database'],0), int(row['local_id']))
        if any(r['from_self'] is None for r in rows):
            raise RuntimeError('unknown_sender_identity; do not automatically reply')
        return {'new_messages':rows, 'incoming_count':sum(not r['from_self'] for r in rows),
                'ack_cursor':cursor, 'salts':now['salts']}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--db-root', type=Path)
    ap.add_argument('--key-file', type=Path, default=Path('.wechat-local/keys.json'))
    sub = ap.add_subparsers(dest='command', required=True)
    sub.add_parser('verify')
    resolve = sub.add_parser('resolve')
    resolve.add_argument('name')
    read = sub.add_parser('read')
    read.add_argument('--chat-id', required=True)
    read.add_argument('--self-id')
    read.add_argument('--limit', type=int, default=20)
    read.add_argument('--before-id', type=int, default=None,
                      help='向前翻页：只读 local_id 严格小于该值的最新 limit 条（缺省 = 现行为不变）')
    files = sub.add_parser('files')
    files.add_argument('--chat-id', required=True)
    files.add_argument('--limit', type=int, default=20,
                       help='最多返回最近多少条文件类消息（1..200，默认 20）')
    init = sub.add_parser('init')
    init.add_argument('--chat-id', required=True)
    init.add_argument('--self-id', required=True)
    init.add_argument('--state', type=Path, required=True)
    for name in ('check','ack','watch'):
        cmd = sub.add_parser(name)
        cmd.add_argument('--state', type=Path, required=True)
        if name == 'ack':
            cmd.add_argument('--cursor', required=True, help='JSON ack_cursor from the reviewed check')
        if name == 'watch':
            cmd.add_argument('--seconds', type=float, default=30)
            cmd.add_argument('--interval', type=float, default=1)
    args = ap.parse_args()
    reader = Reader(root_for(args.db_root), args.key_file)
    if args.command == 'verify':
        results = []
        for path in sorted(reader.root.rglob('*.db')):
            try:
                result = verify(path, args.key_file)
            except Exception as error:
                result = {'verified':False, 'error':str(error)}
            results.append(dict(database=str(path.relative_to(reader.root)), **result))
        emit({'databases':results, 'verified_count':sum(r['verified'] for r in results)})
        return 0 if results and all(r['verified'] for r in results) else 2
    if args.command == 'resolve':
        rows = reader.resolve(args.name)
        emit({'matches':rows, 'unique':len(rows)==1})
        return 0 if len(rows)==1 else 2
    if args.command == 'read':
        if not 1 <= args.limit <= 200:
            ap.error('--limit must be 1..200')
        emit({'messages':reader.read(args.chat_id,args.limit,self_id=args.self_id,before_id=args.before_id)})
        return 0
    if args.command == 'files':
        if not 1 <= args.limit <= 200:
            ap.error('--limit must be 1..200')
        emit({'chat_id': args.chat_id, 'files': reader.files(args.chat_id, args.limit)})
        return 0
    if args.command == 'init':
        if args.state.exists():
            raise RuntimeError('state_exists; choose a new state file')
        # Caller must determine their own sender_id from a known self-sent test message.
        state = reader.init_state(args.chat_id,args.self_id)
        private_write(args.state,state)
        emit({'type':'baseline', 'cursor':state['cursor'], 'old_messages_are_not_new':True})
        return 0
    state = json.loads(args.state.read_text())
    if args.command == 'ack':
        requested = json.loads(args.cursor)
        batch = reader.check(state)
        if not isinstance(requested,dict) or not requested:
            raise RuntimeError('invalid_ack_cursor')
        for name,value in requested.items():
            if not isinstance(value,int) or name not in batch['ack_cursor'] or not state['cursor'].get(name,0) <= value <= batch['ack_cursor'][name]:
                raise RuntimeError('ack_outside_current_batch')
        state['cursor'].update(requested)
        state['salts'] = batch['salts']
        private_write(args.state,state)
        emit({'type':'acknowledged'})
        return 0
    if args.command == 'check':
        emit(reader.check(state))
        return 0
    if not (0.25 <= args.interval <= 60 and 1 <= args.seconds <= 86400):
        ap.error('watch requires interval .25..60 and seconds 1..86400')
    # Deliberately does NOT acknowledge on output. Consumer must ack after handling.
    # Same pending batch may repeat; downstream must deduplicate by database/local_id.
    deadline = time.monotonic()+args.seconds
    last = None
    while time.monotonic() < deadline:
        state = json.loads(args.state.read_text())
        batch = reader.check(state)
        signature = json.dumps(batch['ack_cursor'],sort_keys=True)
        if batch['new_messages'] and signature != last:
            emit(batch)
            last = signature
        time.sleep(min(args.interval,max(0,deadline-time.monotonic())))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except BrokenPipeError:
        sys.exit(0)
    except Exception as error:
        emit({'type':'error', 'reason':str(error)})
        sys.exit(2)
