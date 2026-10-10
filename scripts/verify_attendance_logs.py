#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""修改81 验证：点名详情「修改日志」模块的后端链路
覆盖：create 日志（发起人+初始概况）/ 假单自动校正 system 日志 / update 日志（前后值对比）/
confirm 日志 / 特权角色明文 vs 只读角色脱敏 / 越权 403 / 删除清理 / 灾备包登记
"""
import json, random, string, time, urllib.parse, urllib.request

BASE = 'http://127.0.0.1:3100'
TOKEN = ''
SFX = ''.join(random.choices(string.digits, k=6))
GRADE = f'20{SFX[:2]}级'
CA = f'日志A{SFX}班'
SID1, SID2, SID3 = f'LG{SFX}1', f'LG{SFX}2', f'LG{SFX}3'
N1, N2, N3 = '张三', '李四', '王五'
D_USER, D_OUT = f'lgd{SFX}a', f'lgd{SFX}b'  # 本班纪律委员 / 无关纪律委员
D_PWD, D_PWD2 = 'Test123456', 'Test123456x'
TODAY = time.strftime('%Y-%m-%d')


def req(method, path, body=None, token=None):
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method)
    r.add_header('Content-Type', 'application/json')
    tk = token if token is not None else TOKEN
    if tk:
        r.add_header('X-Auth-Token', tk)
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {'raw': raw}


def q(s):
    return urllib.parse.quote(s)


def chk(cond, msg, extra=''):
    print(('  OK  : ' if cond else '  FAIL: ') + msg + ((' | ' + str(extra)) if extra else ''))
    return bool(cond)


ok = True
st, d = req('POST', '/api/auth/login', {'username': 'admin', 'password': 'admin123'})
TOKEN = d.get('token', '')
print('登录:', '成功' if TOKEN else '失败', '| 测试后缀:', SFX)

# ---------- 准备：登记班级 + 导入 3 名学生 ----------
st, d = req('POST', '/api/classes', {'name': CA, 'grade': GRADE})
assert st == 200, d
st, d = req('POST', '/api/students/import', {'rows': [
    {'年级': GRADE, '班级': CA, '姓名': N1, '学号': SID1},
    {'年级': GRADE, '班级': CA, '姓名': N2, '学号': SID2},
    {'年级': GRADE, '班级': CA, '姓名': N3, '学号': SID3},
]})
assert st == 200 and d.get('inserted') == 3, d

# ================= 1：创建日志（create）+ 假单自动校正（system） =================
print('\n[1] 发起点名：3 人（1 请假无假单 → 应触发系统改判）')
st, d = req('POST', '/api/attendance', {
    'className': CA, 'date': TODAY, 'periods': ['1-2节'], 'courseName': '验证课程', 'teacher': '验证老师',
    'items': [
        {'studentId': SID1, 'status': '出勤', 'note': ''},
        {'studentId': SID2, 'status': '请假', 'note': ''},
        {'studentId': SID3, 'status': '缺勤', 'note': ''},
    ],
})
ok &= chk(st == 200, '1 点名创建成功', f'{st} {d}')
SID = d['session']['id']
st, d = req('GET', f'/api/attendance/{SID}/logs')
ok &= chk(st == 200 and d.get('masked') is False, '1 管理员查看：masked=false（账号明文）', d.get('masked'))
logs = d.get('logs', [])
acts = [l['action'] for l in logs]
ok &= chk(acts == ['system', 'create'], '1 倒序：最新在前 → [system, create]', acts)
create = next((l for l in logs if l['action'] == 'create'), None)
ok &= chk(bool(create), '1 存在 create 日志')
if create:
    op = create.get('operator', {})
    ok &= chk(op.get('username') == 'admin' and op.get('name') == '系统管理员', '1 create 修改人=发起账号（admin）', op)
    ok &= chk('admin' in (op.get('roles') or []), '1 create 快照含角色', op.get('roles'))
    sm = create.get('summary') or {}
    ok &= chk(sm.get('total') == 3 and sm.get('counts', {}).get('出勤') == 1
              and sm.get('counts', {}).get('请假') == 1 and sm.get('counts', {}).get('缺勤') == 1,
              '1 create 初始概况（复核前口径）：出勤1/缺勤1/请假1', sm)
    ok &= chk(not create.get('changes'), '1 create 无字段级 changes（概况型条目）')
sysl = next((l for l in logs if l['action'] == 'system'), None)
ok &= chk(bool(sysl), '1 存在 system 日志（请假无假单被改判）')
if sysl:
    sop = sysl.get('operator', {})
    ok &= chk(sop.get('system') is True and sop.get('name') == '假单自动校正', '1 system 操作人=假单自动校正', sop)
    chg = sysl.get('changes') or []
    st_chg = next((c for c in chg if c.get('studentId') == SID2 and c.get('field') == 'status'), None)
    ok &= chk(bool(st_chg) and st_chg.get('before') == '请假' and st_chg.get('after') == '缺勤',
              '1 system 含 李四 请假→缺勤 改判明细', chg)
    ok &= chk(any(c.get('studentId') == SID2 and c.get('field') == 'note' for c in chg), '1 system 同时记录备注改写', chg)

# ================= 2：更新日志（update，字段级前后值） =================
print('\n[2] 更正考勤：王五 缺勤→出勤+备注，张三 补备注')
st, d = req('GET', f'/api/attendance/{SID}')
cur = d['session']['items']
items = []
for it in cur:
    nit = {'studentId': it['studentId'], 'status': it['status'], 'note': it.get('note') or ''}
    if it['studentId'] == SID3:
        nit['status'], nit['note'] = '出勤', '临时回校'
    if it['studentId'] == SID1:
        nit['note'] = '正常'
    items.append(nit)
st, d = req('PUT', f'/api/attendance/{SID}', {'items': items})
ok &= chk(st == 200, '2 更新成功', f'{st} {d}')
st, d = req('GET', f'/api/attendance/{SID}/logs')
logs = d.get('logs', [])
ok &= chk([l['action'] for l in logs][:1] == ['update'], '2 最新日志为 update', [l['action'] for l in logs])
upd = next((l for l in logs if l['action'] == 'update'), None)
if upd:
    ok &= chk(upd.get('operator', {}).get('username') == 'admin', '2 update 修改人=admin', upd.get('operator'))
    chg = upd.get('changes') or []
    ok &= chk(len(chg) == 3, '2 恰好 3 条字段级变更（李四未被重复计入）', chg)
    s3 = next((c for c in chg if c.get('studentId') == SID3 and c.get('field') == 'status'), None)
    ok &= chk(bool(s3) and s3.get('before') == '缺勤' and s3.get('after') == '出勤', '2 王五 状态 缺勤→出勤', s3)
    n3 = next((c for c in chg if c.get('studentId') == SID3 and c.get('field') == 'note'), None)
    ok &= chk(bool(n3) and n3.get('before') == '' and n3.get('after') == '临时回校', '2 王五 备注 （空）→临时回校', n3)
    n1 = next((c for c in chg if c.get('studentId') == SID1 and c.get('field') == 'note'), None)
    ok &= chk(bool(n1) and n1.get('after') == '正常', '2 张三 备注变更', n1)
else:
    ok &= chk(False, '2 存在 update 日志')

# ================= 3：确认日志（confirm，免登录外部确认人） =================
print('\n[3] 任课老师签字确认 → confirm 日志')
st, d = req('GET', f'/api/attendance/{SID}')
CTK = d['session']['confirmToken']
st, d = req('POST', f'/api/confirm/{CTK}', {'name': '验证任课老师', 'signature': 'data:image/png;base64,iVBORw0KGgo='})
ok &= chk(st == 200, '3 签字确认成功', f'{st} {d}')
st, d = req('GET', f'/api/attendance/{SID}/logs')
cf = next((l for l in d.get('logs', []) if l['action'] == 'confirm'), None)
ok &= chk(bool(cf), '3 存在 confirm 日志')
if cf:
    op = cf.get('operator', {})
    ok &= chk(op.get('external') is True and op.get('name') == '验证任课老师' and not op.get('username'),
              '3 confirm 操作人=外部确认人（无账号）', op)
    c0 = (cf.get('changes') or [{}])[0]
    ok &= chk(c0.get('field') == 'confirmStatus' and c0.get('before') == '待确认' and c0.get('after') == '已确认',
              '3 confirm 变更：待确认→已确认', c0)

# ================= 4：只读角色脱敏 + 越权 403 =================
print('\n[4] 纪律委员查看：账号脱敏；无关班级纪律委员：403')
for uname in (D_USER, D_OUT):
    st, d = req('POST', '/api/accounts', {'username': uname, 'password': D_PWD, 'name': f'纪律{uname[-2:]}',
                                          'roles': ['discipline'], 'classes': [CA] if uname == D_USER else []})
    assert st == 200, (uname, d)
st, d = req('POST', '/api/auth/login', {'username': D_USER, 'password': D_PWD})
DTOK = d.get('token', '')
assert DTOK, d
req('PUT', '/api/auth/password', {'oldPassword': D_PWD, 'newPassword': D_PWD2}, token=DTOK)
st, d = req('GET', f'/api/attendance/{SID}/logs', token=DTOK)
ok &= chk(st == 200 and d.get('masked') is True, '4 本班纪律委员可查看且 masked=true', (st, d.get('masked')))
mx = next((l for l in d.get('logs', []) if l['action'] == 'create'), None)
if mx:
    op = mx.get('operator', {})
    ok &= chk(op.get('username') != 'admin' and '*' in str(op.get('username')) and not str(op.get('username')).startswith('adm'),
              '4 修改人账号已脱敏', op.get('username'))
    ok &= chk(op.get('id') is None, '4 只读视图不回传操作人 id', op.get('id'))
    ok &= chk(op.get('name') == '系统管理员', '4 修改人姓名保留（与详情页发起人口径一致）', op.get('name'))
    sm = mx.get('summary') or {}
    ok &= chk(sm.get('total') == 3, '4 初始概况正常可见', sm)
u2 = next((l for l in d.get('logs', []) if l['action'] == 'update'), None)
if u2:
    chg = u2.get('changes') or []
    s3 = next((c for c in chg if c.get('studentId') == SID3), None)
    ok &= chk(bool(s3) and s3.get('studentId') == SID3 and s3.get('name') == N3,
              '4 学生学号/姓名与详情表明细同口径，不打星', s3)
st, d = req('POST', '/api/auth/login', {'username': D_OUT, 'password': D_PWD})
OTOK = d.get('token', '')
assert OTOK, d
req('PUT', '/api/auth/password', {'oldPassword': D_PWD, 'newPassword': D_PWD2}, token=OTOK)
st, d = req('GET', f'/api/attendance/{SID}/logs', token=OTOK)
ok &= chk(st == 403, '4 无关班级纪律委员 → 403', st)

# ================= 5：灾备包登记（ARRAY_KEYS） =================
print('\n[5] 备份包包含 attendanceLogs 集合')
st, d = req('POST', '/api/data/backup', {'label': f'日志验证{SFX}'})
BID = (d.get('meta') or {}).get('id')
ok &= chk(st == 200 and BID, '5 创建备份成功', BID)
st, raw = req('GET', f'/api/data/bundles/{BID}/download')
bundle = raw if isinstance(raw, dict) else {}
cols = bundle.get('collections') or {}
ok &= chk('attendanceLogs' in cols and isinstance(cols.get('attendanceLogs'), list),
          '5 collections 含 attendanceLogs（ARRAY_KEYS 已登记）')
mf = (bundle.get('manifest') or {}).get('attendanceLogs') or {}
ok &= chk(mf.get('count') == len(cols.get('attendanceLogs', [])), '5 manifest 计数一致', mf)

# ================= 6：删除点名记录 → 关联日志同步清理 =================
print('\n[6] 删除记录 → 日志清理')
st, d = req('GET', f'/api/attendance/{SID}/logs')
n_before = len(d.get('logs', []))
st, d = req('GET', '/api/data/overview')
ov = {c['key']: c['count'] for c in d.get('collections', [])}
cnt_before = ov.get('attendanceLogs')
st, d = req('DELETE', f'/api/attendance/{SID}')
ok &= chk(st == 200, '6 删除点名记录成功', st)
st, d = req('GET', '/api/data/overview')
ov2 = {c['key']: c['count'] for c in d.get('collections', [])}
ok &= chk(ov2.get('attendanceLogs') == cnt_before - n_before,
          '6 attendanceLogs 总数精确回落（清理无残留）', f"{cnt_before} - {n_before} -> {ov2.get('attendanceLogs')}")
st, d = req('GET', f'/api/attendance/{SID}/logs')
ok &= chk(st == 404, '6 记录删除后 logs 接口 404', st)

# ================= 清理 =================
print('\n[清理]')
st, d = req('POST', '/api/students/clear', {})
st, d = req('GET', '/api/accounts?pageSize=500')
for x in d.get('list', []):
    if x.get('username') in (D_USER, D_OUT):
        st2, _ = req('DELETE', f"/api/accounts/{x['id']}")
        print(f"  删除账号 {x['username']}: {st2}")
st, d = req('GET', '/api/accounts?pageSize=500')
ok &= chk(not any(x.get('username') in (D_USER, D_OUT) for x in d.get('list', [])), '清理后测试账号已移除')
st, d = req('DELETE', f'/api/classes/{q(CA)}')
print(f'  删除班级 {CA}: {st}')
st, d = req('POST', '/api/students/clear', {})

print('\n===== 结论:', '全部断言通过' if ok else '存在失败项', '=====')
