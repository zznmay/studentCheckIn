#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""修改76 验证：清空名单数据 / 同步账号自动补建（幂等）/ 账号唯一性与多班关联"""
import json, random, string, urllib.parse, urllib.request

BASE = 'http://127.0.0.1:3100'
TOKEN = ''
SFX = ''.join(random.choices(string.digits, k=6))
CLSA, CLSB = f'测试A{SFX}班', f'测试B{SFX}班'
T1, T2 = f'T{SFX}1', f'T{SFX}2'
SID1, SID2, SID3, SIDBAD = f'S{SFX}1', f'S{SFX}2', f'S{SFX}3', f'S{SFX}9'
N1, N2, N3 = '李老师甲', '王老师乙', '学生丙'


def req(method, path, body=None):
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method)
    r.add_header('Content-Type', 'application/json')
    if TOKEN:
        r.add_header('X-Auth-Token', TOKEN)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
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
print('登录:', '成功' if TOKEN else '失败')

# ---------- 准备：两个班级 + 名单 ----------
for nm, ht, co, dm in [
    (CLSA, {'name': N1, 'staffId': T1}, {'name': N2, 'staffId': T2}, {'name': N3, 'studentId': SID1}),
    (CLSB, {'name': N1, 'staffId': T1}, {'name': N2, 'staffId': T2}, {'name': '', 'studentId': ''}),
]:
    st, d = req('POST', '/api/classes', {'name': nm, 'grade': '2030级', 'major': '测试专业',
                                         'headTeacher': ht, 'counselor': co, 'disciplineMember': dm})
    assert st == 200, d

ROWS_A = [{'年级': '2030级', '班级': CLSA, '姓名': N3, '学号': SID1},
          {'年级': '2030级', '班级': CLSA, '姓名': '学生丁', '学号': SID2}]
ROWS_B = [{'年级': '2030级', '班级': CLSB, '姓名': '学生戊', '学号': SID3}]
req('POST', '/api/students/import', {'rows': ROWS_A + ROWS_B})


def users_of(username_part):
    st, d = req('GET', f'/api/accounts?pageSize=500&q={q(username_part)}')
    return d.get('list', d.get('users', []))


st, d = req('GET', '/api/accounts?pageSize=500')
U0 = len(d.get('list', []))
st, d = req('GET', '/api/staffs')
ST0 = len(d.get('list', []))

# ================= 场景 1：清空名单数据 =================
print('\n[1a] 按班级清空（A 班 2 名学生）')
st, d = req('POST', '/api/students/clear', {'className': CLSA})
print('  返回:', d)
ok &= chk(d.get('deleted') == 2 and d.get('scope') == CLSA, '1a 按班级清空 deleted=2')
st, d = req('GET', '/api/students?pageSize=50')
ok &= chk(d.get('total') == 1, '1a 仅剩 B 班 1 名学生', f"total={d.get('total')}")
st, d = req('GET', '/api/accounts?pageSize=500')
ok &= chk(len(d.get('list', [])) == U0, '1a 登录账号数量未变化', f"{U0}")
print('\n[1b] 重复清空（幂等）')
st, d = req('POST', '/api/students/clear', {'className': CLSA})
ok &= chk(d.get('deleted') == 0, '1b 名单已空时 clear 幂等返回 0')
print('\n[1c] 全部清空')
st, d = req('POST', '/api/students/clear', {})
ok &= chk(d.get('deleted') == 1 and d.get('scope') == '全部班级', '1c 未筛选时清空全部名单')
st, d = req('GET', '/api/accounts?pageSize=500')
ok &= chk(len(d.get('list', [])) == U0, '1c 账号体系不受影响')

# ================= 场景 2：同步账号自动补建 =================
print('\n[2] 重新导入名单后执行同步（应自动补建 3 个账号）')
req('POST', '/api/students/import', {'rows': ROWS_A + ROWS_B})
st, d = req('POST', f'/api/classes/{q(CLSA)}/sync-account', {})
s = d.get('summary', {})
print('  summary:', s)
for x in d.get('results', []):
    print('   -', x.get('action'), x.get('post'), x.get('name'), x.get('id'), x.get('initialPassword', ''))
ok &= chk(s.get('created') == 3 and s.get('failed') == 0, '2 自动补建 3 个账号（班主任/辅导员/纪律委员）')
acts = {x['post']: x for x in d.get('results', [])}
ok &= chk(acts.get('班主任', {}).get('initialPassword') == f'Hzpt@{T1}', '2 教师初始密码 = Hzpt@工号')
ok &= chk(acts.get('纪律委员', {}).get('initialPassword') == f'Hzpt@{SID1[-6:]}', '2 学生初始密码 = Hzpt@学号后六位')
st, d = req('GET', f'/api/accounts?pageSize=500&q={q(T1)}')
lst = d.get('list', [])
u1 = [x for x in lst if x.get('username') == T1]
ok &= chk(len(u1) == 1 and u1[0]['role'] == 'headTeacher' and CLSA in (u1[0].get('classes') or []),
          '2 班主任账号按工号创建并关联班级', [(x.get('username'), x.get('role'), x.get('classes')) for x in lst])
st, d = req('GET', f'/api/accounts?pageSize=500&q={q(SID1)}')
u3 = [x for x in d.get('list', []) if x.get('username') == SID1]
ok &= chk(len(u3) == 1 and u3[0]['role'] == 'discipline' and u3[0]['name'] == N3 and u3[0].get('classes') == [CLSA],
          '2 纪律委员账号按学号创建（姓名取自名单）')
st, d = req('GET', '/api/staffs')
stf = [x for x in d.get('list', []) if x.get('staffId') in (T1, T2)]
ok &= chk(len(stf) == 2 and all(CLSA in (x.get('classes') or []) for x in stf),
          '2 教职工名单同步补齐（type/classes 正确）', [(x.get('staffId'), x.get('type'), x.get('classes')) for x in stf])

print('\n[3] 幂等：再次同步同一班级')
st, d = req('POST', f'/api/classes/{q(CLSA)}/sync-account', {})
s = d.get('summary', {})
ok &= chk(s.get('created') == 0 and s.get('skipped') == 3, '3 二次同步 created=0 / skipped=3（不重复创建）')
st, d = req('GET', '/api/accounts?pageSize=500')
ok &= chk(len(d.get('list', [])) == U0 + 3, '3 账号总数未增长', f"期望 {U0 + 3}")

print('\n[4] 多班关联（同一教师带两个班 → 唯一账号，只追加班级）')
st, d = req('POST', f'/api/classes/{q(CLSB)}/sync-account', {})
s = d.get('summary', {})
print('  summary:', s)
ok &= chk(s.get('created') == 0 and s.get('linked') == 2, '4 B 班同步：已存在账号只关联（linked=2，不新建）')
st, d = req('GET', f'/api/accounts?pageSize=500&q={q(T1)}')
u1 = [x for x in d.get('list', []) if x.get('username') == T1]
ok &= chk(len(u1) == 1 and set(u1[0].get('classes') or []) >= {CLSA, CLSB},
          '4 同一工号仅一个账号，可点名班级含 A、B 两班', [(x.get('username'), x.get('classes')) for x in u1])

print('\n[5] 纪律委员学号匹配不到学生 → 失败并提示，不创建账号')
st, d = req('PUT', f'/api/classes/{q(CLSB)}', {'disciplineMember': {'name': '不存在的人', 'studentId': SIDBAD}})
assert st == 200, d
st, d = req('POST', f'/api/classes/{q(CLSB)}/sync-account', {'which': 'disciplineMember'})
s = d.get('summary', {})
r0 = (d.get('results') or [{}])[0]
print('  summary:', s, '| message:', r0.get('message', ''))
ok &= chk(s.get('failed') == 1 and s.get('created') == 0, '5 匹配不到学生 → failed=1，未创建账号')
ok &= chk('未能' in (r0.get('message') or '') and SIDBAD in (r0.get('message') or ''), '5 失败原因含学号与说明')
st, d = req('GET', f'/api/accounts?pageSize=500&q={q(SIDBAD)}')
ok &= chk(not [x for x in d.get('list', []) if x.get('username') == SIDBAD], '5 未产生孤儿账号')

print('\n[6] 账号唯一：同一工号被设为另一角色（B 班辅导员 = T1）→ 不新建，仅关联')
st, d = req('PUT', f'/api/classes/{q(CLSB)}', {'counselor': {'name': N1, 'staffId': T1}})
assert st == 200, d
st, d = req('POST', f'/api/classes/{q(CLSB)}/sync-account', {'which': 'counselor'})
s = d.get('summary', {})
r0 = (d.get('results') or [{}])[0]
print('  summary:', s, '| action:', r0.get('action'), '| message:', r0.get('message', ''))
ok &= chk(s.get('created') == 0 and r0.get('action') in ('linked', 'skipped'),
          '6 已存在账号不重复创建（角色保持首次创建值），仅幂等关联班级（不重复追加）')
st, d = req('GET', f'/api/accounts?pageSize=500&q={q(T1)}')
u1 = [x for x in d.get('list', []) if x.get('username') == T1]
ok &= chk(len(u1) == 1 and u1[0]['role'] == 'headTeacher', '6 账号唯一且角色未被改写')

# ================= 清理 =================
print('\n[清理] 删除测试学生 / 账号 / 教职工 / 班级')
req('POST', '/api/students/clear', {})
st, d = req('GET', '/api/accounts?pageSize=500')
for x in d.get('list', []):
    if x.get('username') in (T1, T2, SID1, SIDBAD):
        req('DELETE', f"/api/accounts/{x['id']}")
st, d = req('GET', '/api/staffs')
for x in d.get('list', []):
    if x.get('staffId') in (T1, T2):
        req('DELETE', f"/api/staffs/{x['id']}")
for nm in (CLSA, CLSB):
    st2, d2 = req('DELETE', f'/api/classes/{q(nm)}')
    print(f'  删除班级 {nm}:', st2)
st, d = req('GET', '/api/accounts?pageSize=500')
print('  剩余账号数:', len(d.get('list', [])), '（应与测试前一致:', U0, '）')
ok &= chk(len(d.get('list', [])) == U0, '清理后账号数量复原')

print('\n===== 结论:', '全部断言通过' if ok else '存在失败项', '=====')
