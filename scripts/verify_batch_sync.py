#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""修改77 验证：班级管理「批量同步账号」按钮的后端接口
覆盖：勾选式（names）/ 筛选式（grade）/ 无岗位人员班级 / 幂等 / 多班关联 / 失效班级名
"""
import json, random, string, urllib.parse, urllib.request

BASE = 'http://127.0.0.1:3100'
TOKEN = ''
SFX = ''.join(random.choices(string.digits, k=6))
GRADE = f'20{SFX[:2]}级'
CA, CB, CC = f'批量A{SFX}班', f'批量B{SFX}班', f'批量C{SFX}班'
T1, T2 = f'TB{SFX}1', f'TB{SFX}2'
SID = f'SB{SFX}1'


def req(method, path, body=None):
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method)
    r.add_header('Content-Type', 'application/json')
    if TOKEN:
        r.add_header('X-Auth-Token', TOKEN)
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

# ---------- 准备：A/B 两个完整岗位班级（同一班主任 T1），C 班无岗位人员 ----------
st, d = req('POST', '/api/classes', {'name': CA, 'grade': GRADE, 'headTeacher': {'name': '批量老师甲', 'staffId': T1},
                                     'counselor': {'name': '批量老师乙', 'staffId': T2}, 'disciplineMember': {'name': '批量学生丙', 'studentId': SID}})
assert st == 200, d
st, d = req('POST', '/api/classes', {'name': CB, 'grade': GRADE, 'headTeacher': {'name': '批量老师甲', 'staffId': T1},
                                     'counselor': {'name': '批量老师乙', 'staffId': T2}, 'disciplineMember': {'name': '', 'studentId': ''}})
assert st == 200, d
st, d = req('POST', '/api/classes', {'name': CC, 'grade': GRADE})
assert st == 200, d
req('POST', '/api/students/import', {'rows': [{'年级': GRADE, '班级': CA, '姓名': '批量学生丙', '学号': SID}]})

st, d = req('GET', '/api/accounts?pageSize=500')
U0 = len(d.get('list', []))

# ================= 1：勾选式批量同步（names） =================
print('\n[1] 批量同步 3 个班级（names 模式，含 1 个无岗位人员的班级）')
st, d = req('POST', '/api/classes/sync-account-batch', {'names': [CA, CB, CC]})
s = d.get('summary', {})
print('  summary:', s, '| total:', d.get('total'))
for c in d.get('classes', []):
    print('   -', c['name'], 'empty' if c.get('empty') else c['summary'])
ok &= chk(d.get('total') == 3, '1 返回覆盖 3 个班级')
ok &= chk(s.get('created') == 3 and s.get('failed') == 0, '1 汇总：新建 3 个账号（T1/T2/学号，T1 跨两班只建一个）', s)
clsmap = {c['name']: c for c in d.get('classes', [])}
ok &= chk(clsmap[CC].get('empty') is True, '1 C 班无岗位人员 → 标记 empty 跳过（不报错）')
ok &= chk(clsmap[CA]['summary']['created'] == 3, '1 A 班新建 3 个账号')
ok &= chk(clsmap[CB]['summary']['created'] == 0 and clsmap[CB]['summary']['linked'] == 2,
          '1 B 班复用已有账号（linked=2，不重复建号）', clsmap[CB]['summary'])
st, d = req('GET', '/api/accounts?pageSize=500')
ok &= chk(len(d.get('list', [])) == U0 + 3, '1 账号总数只增加 3（唯一性）', f"{U0} -> {len(d.get('list', []))}")
st, d = req('GET', f'/api/accounts?pageSize=500&q={q(T1)}')
u = [x for x in d.get('list', []) if x.get('username') == T1]
ok &= chk(len(u) == 1 and set(u[0].get('classes') or []) >= {CA, CB}, '1 同一工号一个账号、关联两个班级', u[0].get('classes') if u else None)

# ================= 2：幂等 =================
print('\n[2] 再次批量同步（幂等）')
st, d = req('POST', '/api/classes/sync-account-batch', {'names': [CA, CB]})
s = d.get('summary', {})
print('  summary:', s)
ok &= chk(s.get('created') == 0 and s.get('linked') == 0, '2 二次同步 created=0 / linked=0（全部为无需处理）')
ok &= chk(s.get('skipped') == 5, '2 skipped=5（A 班 3 项 + B 班 2 项）', s)
st, d = req('GET', '/api/accounts?pageSize=500')
ok &= chk(len(d.get('list', [])) == U0 + 3, '2 账号数未增长')

# ================= 3：筛选式批量同步（无 names，按年级） =================
print('\n[3] 筛选式批量同步（无 names，按年级过滤）')
st, d = req('POST', '/api/classes/sync-account-batch', {'grade': GRADE})
print('  total:', d.get('total'), '| summary:', d.get('summary'))
ok &= chk(d.get('total') == 3, '3 年级筛选命中 3 个测试班级（A/B/C）')
st, d = req('POST', '/api/classes/sync-account-batch', {'q': f'批量A{SFX}'})
print('  q 过滤 total:', d.get('total'), '| summary:', d.get('summary'))
ok &= chk(d.get('total') == 1 and d['classes'][0]['name'] == CA, '3 关键词筛选只命中 A 班')
st, d = req('POST', '/api/classes/sync-account-batch', {'grade': '不存在的年级999'})
ok &= chk(st == 400 and '没有可同步的班级' in json.dumps(d, ensure_ascii=False), '3 筛选无命中 → 400 明确提示', f'{st} {d}')

# ================= 4：已失效班级名 =================
print('\n[4] names 含不存在班级')
st, d = req('POST', '/api/classes/sync-account-batch', {'names': [CA, f'已删除{SFX}班']})
ok &= chk(d.get('total') == 1 and d.get('missingNames') == [f'已删除{SFX}班'], '4 跳过失效班级并回传 missingNames', d.get('missingNames'))
st, d = req('POST', '/api/classes/sync-account-batch', {'names': [f'全失效{SFX}班']})
ok &= chk(st == 400, '4 全部失效 → 400 提示刷新重试', f'{st} {d}')

# ================= 5：单班接口回归（抽函数后不回归） =================
print('\n[5] 单班级接口回归')
st, d = req('POST', f'/api/classes/{q(CA)}/sync-account', {})
ok &= chk(st == 200 and d.get('summary', {}).get('skipped') == 3, '5 单班同步仍返回 summary/results', d.get('summary'))
st, d = req('POST', f'/api/classes/{q(CC)}/sync-account', {})
ok &= chk(st == 400 and '尚未维护' in json.dumps(d, ensure_ascii=False), '5 无岗位人员的单班同步仍报 400', f'{st} {d}')

# ================= 清理 =================
print('\n[清理]')
req('POST', '/api/students/clear', {})
st, d = req('GET', '/api/accounts?pageSize=500')
for x in d.get('list', []):
    if x.get('username') in (T1, T2, SID):
        req('DELETE', f"/api/accounts/{x['id']}")
st, d = req('GET', '/api/staffs')
for x in d.get('list', []):
    if x.get('staffId') in (T1, T2):
        req('DELETE', f"/api/staffs/{x['id']}")
for nm in (CA, CB, CC):
    st2, _ = req('DELETE', f'/api/classes/{q(nm)}')
    print(f'  删除班级 {nm}: {st2}')
st, d = req('GET', '/api/accounts?pageSize=500')
ok &= chk(len(d.get('list', [])) == U0, '清理后账号数复原', f"{len(d.get('list', []))} vs {U0}")

print('\n===== 结论:', '全部断言通过' if ok else '存在失败项', '=====')
