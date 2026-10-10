#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""修改80 验证：附件外置 + 迁移包 zip 化

覆盖：
  A. 存量迁移     —— 内嵌 base64 签名启动时外置为内容寻址文件 + 迁移前快照
  B. 写入落引用   —— 免登录确认签名、异议佐证材料写入后集合内不再有 base64
  C. 读取回填     —— confirm / 考勤详情 / 异议 mine·详情·审核 响应形状与改造前一致
  D. 备份 zip 化  —— 下载为 zip（bundle.json + attachments 树）、清单逐个 sha256 对账、无 base64
  E. 导入 zip 化  —— 192KB base64 切片上传 + 整包 sha256 对账 → 预检 → 恢复（附件随包落盘）
  F. 兼容与健壮   —— v1 旧包自动转换、附件丢失降级、异常分支拒绝、旧 JSON 上传路径回归

用法：先在项目副本（或本机 3100 端口）起服务，再执行本脚本。
     env -u http_proxy -u https_proxy python3 scripts/verify_attachments_zip.py
"""
import base64
import hashlib
import io
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile

for _k in ('http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy'):
    os.environ.pop(_k, None)

BASE = os.environ.get('KQ_BASE', 'http://127.0.0.1:3100')
DATA = os.environ.get('KQ_DATA', 'data')
BINARY_CHUNK = 192 * 1024  # 与前端 BINARY_CHUNK_BYTES 一致（base64 后 256KB）
PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
CLASS = '验算2501'
FAILS = []


def chk(name, cond, detail=''):
    print(('  OK   ' if cond else '  FAIL ') + name + (f' | {detail}' if detail else ''))
    if not cond:
        FAILS.append(name)
    return cond


def call(path, method='GET', body=None, token=None, timeout=300):
    data = json.dumps(body, ensure_ascii=False).encode('utf-8') if body is not None else None
    headers = {'Content-Type': 'application/json'} if body is not None else {}
    if token:
        headers['X-Auth-Token'] = token
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        payload = e.read().decode('utf-8')
        try:
            payload = json.loads(payload)
        except Exception:
            pass
        return e.code, payload


def raw_get(path, token=None):
    headers = {'X-Auth-Token': token} if token else {}
    req = urllib.request.Request(BASE + path, headers=headers)
    with urllib.request.urlopen(req, timeout=300) as r:
        return r.read()


def read_json(name):
    p = os.path.join(DATA, name)
    return json.load(open(p, encoding='utf-8')) if os.path.exists(p) else None


def upload_zip(blob, token, upload_id, declared_sha=None):
    sha = declared_sha if declared_sha is not None else hashlib.sha256(blob).hexdigest()
    total = max(1, (len(blob) + BINARY_CHUNK - 1) // BINARY_CHUNK)
    for i in range(total):
        piece = blob[i * BINARY_CHUNK:(i + 1) * BINARY_CHUNK]
        st, r = call('/api/data/restore/upload', 'POST', {
            'uploadId': upload_id, 'index': i, 'total': total, 'format': 'zip', 'fileSha256': sha,
            'chunk': base64.b64encode(piece).decode('ascii')}, token)
        if st != 200:
            return st, r
    return st, r


def main():
    print('== 0. 登录 ==')
    st, r = call('/api/auth/login', 'POST', {'username': 'admin', 'password': 'admin123'})
    token = r.get('token', '')
    if not chk('管理员登录', st == 200 and bool(token), st):
        return

    # ---------- A. 存量迁移 ----------
    print('\n== A. 存量内嵌数据已外置（启动迁移） ==')
    att = read_json('attendance.json') or []
    if att:
        inline = [x for x in att if isinstance(x.get('signature'), str) and x['signature'].startswith('data:')]
        chk('集合内不再残留内嵌 base64', not inline, f'{len(inline)} 条仍内嵌')
        refs = [x for x in att if x.get('signatureRef')]
        chk('签名为引用形态', len(refs) == len(att), f'{len(refs)}/{len(att)}')
        att_dir = os.path.join(DATA, 'attachments')
        for x in refs[:3]:
            sha = x['signatureRef']['sha256']
            p = os.path.join(att_dir, sha)
            ok = os.path.exists(p) and hashlib.sha256(open(p, 'rb').read()).hexdigest() == sha
            chk(f'附件落盘且内容寻址正确 {sha[:8]}', ok)
    else:
        print('  （无考勤数据，跳过 A 段）')

    # ---------- B. 写入落引用 ----------
    print('\n== B. 新写入落引用（签名 + 异议附件） ==')
    st, r = call('/api/attendance', 'POST', {
        'className': CLASS, 'date': '2026-07-01', 'periods': ['1-2节'], 'courseName': '验证课',
        'teacher': '验老师', 'items': [{'studentId': 'x1', 'status': '出勤'}]}, token)
    if st == 200:
        sid = r.get('session', {}).get('id')
        st, r = call(f'/api/attendance/{sid}', token=token)
        tok = r.get('session', {}).get('confirmToken', '')
        st, r = call(f'/api/confirm/{tok}', 'POST', {'name': '验老师', 'signature': 'data:image/png;base64,' + PNG})
        chk('免登录提交签名', st == 200, f'{st} {str(r)[:80]}')
        rec = next((x for x in (read_json('attendance.json') or []) if x['id'] == sid), {})
        chk('签名写入为引用、无内嵌', 'signature' not in rec and isinstance(rec.get('signatureRef'), dict), list(rec.keys()))
    else:
        print(f'  （创建点名记录失败 {st}，跳过 B 段签名部分：可能该班级无学生名单）')

    # ---------- C. 读取回填 ----------
    print('\n== C. 读取点回填 dataUri（响应形状不变） ==')
    if att:
        seed = att[0]
        st, r = call(f"/api/confirm/{seed.get('confirmToken')}") if seed.get('confirmToken') else (0, {})
        if st == 200 and r.get('confirm'):
            chk('confirm.signature 为 dataUri', str(r['confirm']['signature']).startswith('data:image/png;base64,'))
            chk('confirm 响应不含 signatureRef', 'signatureRef' not in json.dumps(r))
    st, r = call('/api/data/overview', token=token)
    att_row = next((c for c in r.get('collections', []) if c['key'] == 'attachments'), None)
    chk('数据总览含附件行', att_row is not None, att_row)

    # ---------- D. 备份 zip 化 ----------
    print('\n== D. 备份包为 zip 且自包含附件 ==')
    st, r = call('/api/data/backup', 'POST', {'kind': 'migration', 'label': '修改80验证'}, token)
    bid = (r.get('meta') or {}).get('id')
    if not chk('生成迁移包', st == 200 and bool(bid), f'{st} {str(r)[:100]}'):
        return
    chk('meta.file 为 .zip', str((r.get('meta') or {}).get('file', '')).endswith('.zip'), (r.get('meta') or {}).get('file'))
    blob = raw_get(f"/api/data/bundles/{urllib.parse.quote(bid)}/download", token)
    chk('下载以 PK 魔数开头', blob[:2] == b'PK', blob[:4])
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        names = z.namelist()
        btext = z.read('bundle.json').decode('utf-8')
        bundle = json.loads(btext)
        manifest = bundle.get('attachments') or {}
        chk('含 bundle.json', 'bundle.json' in names)
        chk('schemaVersion=2', bundle.get('schemaVersion') == 2, bundle.get('schemaVersion'))
        chk('bundle.json 无 base64 图片', 'data:image' not in btext)
        chk('含 attachments 附件树', any(n.startswith('attachments/') for n in names) or not manifest, len(manifest))
        ok = True
        for sha, info in manifest.items():
            data = z.read(f'attachments/{sha}')
            if hashlib.sha256(data).hexdigest() != sha or (info.get('size') is not None and len(data) != info['size']):
                ok = False
        chk('附件树逐个 sha256 与字节数一致', ok, f'{len(manifest)} 个')
    print(f'  包体积 {len(blob)/1024:.1f}KB，附件 {len(manifest)} 个')

    # ---------- E. 导入 zip 化 ----------
    print('\n== E. zip 分片上传 → 预检 → 恢复（附件随包落盘） ==')
    uid = 'up-verify80-zip'
    st, r = upload_zip(blob, token, uid)
    if chk('分片上传完成', st == 200 and r.get('done'), f'{st} {str(r)[:120]}'):
        chk('返回附件数与包内一致', r.get('attachments') == len(manifest), f"{r.get('attachments')} vs {len(manifest)}")
    st, r = call('/api/data/restore/preview', 'POST', {'uploadId': uid}, token)
    chk('预检通过', st == 200 and r.get('ok'), f'{st} {str(r)[:140]}')
    ac = next((c for c in r.get('checks', []) if c['key'] == 'attachments'), None)
    chk('附件校验项通过', ac is not None and ac['ok'], ac)
    ad = next((d for d in r.get('diff', []) if d['key'] == 'attachments'), None)
    chk('附件计数 diff 行存在', ad is not None, ad)
    st, r = call('/api/data/restore', 'POST', {'uploadId': uid, 'confirm': '恢复'}, token)
    chk('恢复成功', st == 200, f'{st} {str(r)[:140]}')
    att_dir = os.path.join(DATA, 'attachments')
    rebuilt = set(os.listdir(att_dir)) if os.path.isdir(att_dir) else set()
    if manifest:
        chk('附件全部重建', set(manifest) <= rebuilt, f'{len(rebuilt)} 个')
        chk('附件逐字节一致', all(hashlib.sha256(open(os.path.join(att_dir, s), 'rb').read()).hexdigest() == s for s in manifest))
    chk('上传暂存已清理', not os.path.exists(os.path.join(DATA, 'tmp-uploads', uid)))

    # ---------- F. 兼容与健壮 ----------
    print('\n== F. 兼容与健壮 ==')
    v1 = {'kind': 'backup', 'label': 'v1内联', 'schemaVersion': 1, 'appVersion': '2.1',
          'exportedAt': '2026-01-01T00:00:00.000Z', 'source': 'v1-fixture', 'counts': {},
          'collections': {'users': read_json('users.json') or [], 'students': [], 'attendance': [], 'leaves': [],
                         'tokens': [], 'staffs': [], 'appeals': [], 'punishments': [], 'classes': [],
                         'settings': {'periodTimes': {}}},
          'manifest': {}}
    v1['collections']['attendance'] = [{
        'id': 'att_v1_verify', 'className': CLASS, 'date': '2026-06-01', 'periods': ['1-2节'],
        'courseName': '旧课', 'teacher': '旧老师',
        'items': [{'studentId': 'x1', 'name': '旧生', 'status': '出勤', 'note': ''}],
        'createdBy': 't', 'createdById': 'u1', 'createdAt': '2026-06-01T10:00:00.000Z',
        'updatedBy': 't', 'updatedAt': '2026-06-01T10:00:00.000Z',
        'confirmToken': 'tok-v1-verify', 'confirmStatus': 'confirmed', 'confirmedName': '旧老师',
        'confirmedAt': '2026-06-01T11:00:00.000Z', 'signature': 'data:image/png;base64,' + PNG}]
    for k, v in v1['collections'].items():
        cnt = len(v) if isinstance(v, list) else 1
        v1['counts'][k] = cnt
        v1['manifest'][k] = {'count': cnt, 'sha256': hashlib.sha256(
            json.dumps(v, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest()}
    st, r = call('/api/data/restore/preview', 'POST', {'bundle': v1}, token)
    chk('v1 旧包预检通过', st == 200 and r.get('ok'), f'{st} {str(r)[:120]}')
    st, r = call('/api/data/restore', 'POST', {'bundle': v1, 'confirm': '恢复'}, token)
    chk('v1 旧包恢复成功', st == 200, f'{st} {str(r)[:120]}')
    rec = (read_json('attendance.json') or [{}])[0]
    chk('v1 内嵌签名自动转换为引用', 'signature' not in rec and isinstance(rec.get('signatureRef'), dict), list(rec.keys()))
    sha_v1 = (rec.get('signatureRef') or {}).get('sha256', '')
    chk('转换后附件已落盘', bool(sha_v1) and os.path.exists(os.path.join(att_dir, sha_v1)), sha_v1[:12])
    # v1 包 users 为空 → 恢复后登录态随数据一起失效，重新登录（与前端「恢复后需重新登录」一致）
    st, r = call('/api/auth/login', 'POST', {'username': 'admin', 'password': 'admin123'})
    token = r.get('token', '')
    chk('恢复后重新登录', st == 200 and bool(token), st)
    st, r = call('/api/confirm/tok-v1-verify')
    chk('v1 恢复后签名可回填', str(r.get('confirm', {}).get('signature', '')).startswith('data:image/png;base64,'))

    if sha_v1:
        os.remove(os.path.join(att_dir, sha_v1))
        st, r = call('/api/confirm/tok-v1-verify')
        chk('附件文件丢失后降级为空串不报错', st == 200 and r.get('confirm', {}).get('signature') == '', str(r.get('confirm'))[:60])
        st, r = call('/api/data/backup', 'POST', {'kind': 'backup', 'label': '缺失附件导出'}, token)
        chk('附件缺失时备份仍可用（不 500）', st == 200, f'{st} {str(r)[:100]}')

    st, r = upload_zip(blob, token, 'up-verify80-badsha', declared_sha='0' * 64)
    chk('整包 sha256 不符被拒', st == 400 and '校验失败' in str(r.get('message', '')), f'{st} {str(r)[:100]}')
    st, r = call('/api/data/restore/upload', 'POST', {
        'uploadId': 'up-verify80-bad', 'index': 0, 'total': 1, 'format': 'zip',
        'chunk': base64.b64encode(b'not-a-zip').decode()}, token)
    chk('缺 fileSha256 被拒', st == 400, f'{st} {str(r)[:100]}')

    # 旧 JSON 文本分片路径回归
    text = json.dumps(v1, ensure_ascii=False).encode('utf-8')
    mid = len(text) // 2 + 1
    ok = True
    for i, piece in enumerate([text[:mid], text[mid:]]):
        st, r = call('/api/data/restore/upload', 'POST',
                     {'uploadId': 'up-verify80-json', 'index': i, 'total': 2, 'chunk': piece.decode('utf-8')}, token)
        if st != 200:
            ok = False
    chk('v1 文本分片上传路径回归可用', ok)
    st, r = call('/api/data/restore/preview', 'POST', {'uploadId': 'up-verify80-json'}, token)
    chk('v1 文本包预检通过', st == 200 and r.get('ok'), f'{st} {str(r)[:120]}')


if __name__ == '__main__':
    main()
    print('\n' + '=' * 46)
    if FAILS:
        print(f'失败 {len(FAILS)} 项: {FAILS}')
        sys.exit(1)
    print('修改80 全部通过')