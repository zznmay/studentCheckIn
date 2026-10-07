#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""班级名单批量导入缺陷修复验证（修改73）
场景：A 重复导入更新 / 统计口径；B 班级名不匹配整批中止
"""
import json, urllib.parse, urllib.request

BASE = 'http://127.0.0.1:3100'
TOKEN = ''


def req(method, path, body=None):
    url = BASE + path
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
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


def q(name):
    return urllib.parse.quote(name)


def chk(cond, msg, extra=''):
    print(('  OK  : ' if cond else '  FAIL: ') + msg + ((' | ' + str(extra)) if extra else ''))
    return cond


ok = True

# ---------- 登录 ----------
st, d = req('POST', '/api/auth/login', {'username': 'admin', 'password': 'admin123'})
TOKEN = d.get('token', '')
print('登录:', '成功' if TOKEN else '失败', '' if TOKEN else d)

# ---------- 准备：班级管理中登记两个班级 ----------
for nm, ht, co, dm in [('软件2301班', '张老师', '王老师', '李同学'), ('软件2302班', '赵老师', '孙老师', '周同学')]:
    st, d = req('POST', '/api/classes', {
        'name': nm, 'grade': '2023级', 'major': '软件工程',
        'headTeacher': {'name': ht, 'staffId': ''},
        'counselor': {'name': co, 'staffId': ''},
        'disciplineMember': {'name': dm, 'studentId': ''},
    })
    print(f'建档 {nm}:', st)

st, d = req('GET', '/api/classes')
print('班级管理现有班级:', [c['name'] for c in d['list']])

BASE_ROWS = [
    {'年级': '2023级', '班级': '软件2301班', '姓名': '王雨轩', '学号': '202301001'},
    {'年级': '2023级', '班级': '软件2301班', '姓名': '刘诗琪', '学号': '202301002'},
    {'年级': '2023级', '班级': '软件2302班', '姓名': '杨梦琪', '学号': '202302001'},
]

# ================= 场景 A1：首次导入 =================
print('\n[A1] 首次导入 3 条（全部为已登记班级）')
st, d = req('POST', '/api/students/import', {'rows': BASE_ROWS})
print('  返回:', {k: d.get(k) for k in ('aborted', 'total', 'inserted', 'updated', 'unchanged', 'failed')})
ok &= chk(d.get('inserted') == 3 and d.get('updated') == 0 and d.get('unchanged') == 0, 'A1 新增 3 / 更新 0 / 无变化 0')

st, d = req('GET', '/api/students?pageSize=50')
print('  库中人数:', d.get('total'))
s1 = [s for s in d['list'] if s['studentId'] == '202301001'][0]
ok &= chk(s1['classTeacher'] == '张老师' and s1['counselor'] == '王老师' and s1['disciplineMember'] == '李同学',
          'A1 三岗位已按班级管理权威源写入', f"{s1['classTeacher']}/{s1['counselor']}/{s1['disciplineMember']}")

# ================= 场景 A2：完全重复导入 =================
print('\n[A2] 重复导入同一份（内容未变）')
st, d = req('POST', '/api/students/import', {'rows': BASE_ROWS})
print('  返回:', {k: d.get(k) for k in ('aborted', 'total', 'inserted', 'updated', 'unchanged', 'failed')})
ok &= chk(d.get('inserted') == 0 and d.get('updated') == 0 and d.get('unchanged') == 3,
          'A2 新增 0 / 更新 0 / 无变化 3（统计与真实写库一致，不再虚报"更新 N 条"）')

# ================= 场景 A3：改动 1 条 + 新增 1 条 =================
print('\n[A3] 改动 1 条姓名与年级 + 新增 1 条')
rows3 = json.loads(json.dumps(BASE_ROWS, ensure_ascii=False))
rows3[0]['姓名'] = '王雨轩（改名）'
rows3[0]['年级'] = '2024级'
rows3.append({'年级': '2023级', '班级': '软件2302班', '姓名': '陈思远', '学号': '202302002'})
st, d = req('POST', '/api/students/import', {'rows': rows3})
print('  返回:', {k: d.get(k) for k in ('aborted', 'total', 'inserted', 'updated', 'unchanged', 'failed')})
ok &= chk(d.get('inserted') == 1 and d.get('updated') == 1 and d.get('unchanged') == 2,
          'A3 新增 1 / 更新 1 / 无变化 2')

st, d = req('GET', '/api/students?pageSize=50')
s1b = [s for s in d['list'] if s['studentId'] == '202301001'][0]
ok &= chk(s1b['name'] == '王雨轩（改名）' and s1b['grade'] == '2024级',
          'A3 变更字段已真正写库', f"姓名={s1b['name']} 年级={s1b['grade']}")
s2b = [s for s in d['list'] if s['studentId'] == '202301002'][0]
ok &= chk(s2b['name'] == '刘诗琪' and s2b['grade'] == '2023级' and s2b['classTeacher'] == '张老师',
          'A3 未变动记录字段保持不变', f"姓名={s2b['name']} 年级={s2b['grade']} 班主任={s2b['classTeacher']}")

# ================= 场景 A4：字段留空不应清空库中已有值 =================
print('\n[A4] 年级列留空导入（应保持库中原有年级）')
rows4 = [{'年级': '', '班级': '软件2301班', '姓名': '王雨轩（改名）', '学号': '202301001'}]
st, d = req('POST', '/api/students/import', {'rows': rows4})
print('  返回:', {k: d.get(k) for k in ('inserted', 'updated', 'unchanged', 'failed')})
st, d = req('GET', '/api/students?pageSize=50')
s1c = [s for s in d['list'] if s['studentId'] == '202301001'][0]
ok &= chk(s1c['grade'] == '2024级', 'A4 留空字段未清空库中已有值', f"年级={s1c['grade']}")

# ================= 场景 A5：学号更正（防重复插入，修改75） =================
print('\n[A5] 名单中学号更正（202301001 → 202301009），应按同班同名更新而非新增')
before_total = req('GET', '/api/students?pageSize=50')[1].get('total')
rows5 = [{'年级': '2024级', '班级': '软件2301班', '姓名': '王雨轩（改名）', '学号': '202301009'}]
st, d = req('POST', '/api/students/import', {'rows': rows5})
print('  返回:', {k: d.get(k) for k in ('inserted', 'updated', 'unchanged', 'skippedRows', 'failed')})
print('  notices:', json.dumps(d.get('notices'), ensure_ascii=False)[:300])
ok &= chk(d.get('inserted') == 0 and d.get('updated') == 1, 'A5 更新 1 条而非新增（不再产生一人两条）')
after_total = req('GET', '/api/students?pageSize=50')[1].get('total')
ok &= chk(after_total == before_total, 'A5 学生总数不变', f'{before_total} -> {after_total}')
st, d = req('GET', '/api/students?pageSize=50')
hit = [s for s in d['list'] if s['studentId'] == '202301009']
old_gone = not any(s['studentId'] == '202301001' for s in d['list'])
ok &= chk(len(hit) == 1 and old_gone and hit[0]['name'] == '王雨轩（改名）',
          'A5 旧学号已更正为新学号且字段保留', f"{hit[0]['studentId']}/{hit[0]['name']}" if hit else '未找到')
st, d = req('POST', '/api/students/import', {'rows': rows5})
ok &= chk(d.get('unchanged') == 1 and d.get('inserted') == 0, 'A5 更正后的名单再次导入 → 无变化（不重复插入）')

# ================= 场景 A6：同班同名多条 → 无法唯一判定，跳过 =================
print('\n[A6] 同班同名多条（导入无法唯一判定更新目标，应跳过并提示）')
for sid in ['202302101', '202302102']:
    st, d = req('POST', '/api/students', {'className': '软件2302班', 'name': '重名同学', 'studentId': sid, 'grade': '2023级'})
rows6 = [{'年级': '2023级', '班级': '软件2302班', '姓名': '重名同学', '学号': '202302999'}]
st, d = req('POST', '/api/students/import', {'rows': rows6})
print('  返回:', {k: d.get(k) for k in ('inserted', 'updated', 'skippedRows', 'failed')})
print('  errors:', json.dumps(d.get('errors'), ensure_ascii=False)[:300])
ok &= chk(d.get('skippedRows') == 1 and d.get('inserted') == 0, 'A6 同名多条时跳过该行（不盲目插入/更新）')
ok &= chk('同名记录' in json.dumps(d.get('errors'), ensure_ascii=False), 'A6 错误提示说明存在同名记录')

# ================= 场景 B：班级名不匹配（逐条跳过，不中止整批） =================
print('\n[B1] 全部为未登记班级（2 条，应全部跳过、零写入）')
before_total = req('GET', '/api/students?pageSize=50')[1].get('total')
before_classes = [c['name'] for c in req('GET', '/api/classes')[1]['list']]
rows_b = [
    {'年级': '2023级', '班级': '软件2399班', '姓名': '新同学B', '学号': '202399001'},
    {'年级': '2023级', '班级': '软件 2398班', '姓名': '新同学C', '学号': '202398001'},
]
st, d = req('POST', '/api/students/import', {'rows': rows_b})
print('  返回:', {k: d.get(k) for k in ('total', 'inserted', 'updated', 'unchanged', 'skippedRows', 'failed')})
print('  errors:', json.dumps(d.get('errors'), ensure_ascii=False))
ok &= chk(d.get('aborted') is None, 'B1 不再整批中止（无 aborted 标记）')
ok &= chk(d.get('skippedRows') == 2 and d.get('failed') == 2, 'B1 跳过条数 = 2')
ok &= chk(d.get('inserted') == 0 and d.get('updated') == 0, 'B1 未写入任何新增/更新')
err_txt = json.dumps(d.get('errors'), ensure_ascii=False)
ok &= chk('班级不存在或未匹配' in err_txt, 'B1 跳过原因文案为「班级不存在或未匹配」')
errs = d.get('errors') or []
ok &= chk(any(e.get('row') == 2 for e in errs) and '软件2399班' in err_txt,
          'B1 汇总含行号(row=2)与班级名', [(e.get('row'), e.get('message')) for e in errs][:2])
after_total = req('GET', '/api/students?pageSize=50')[1].get('total')
after_classes = [c['name'] for c in req('GET', '/api/classes')[1]['list']]
ok &= chk(after_total == before_total, 'B1 学生表未新增任何记录', f'{before_total} -> {after_total}')
ok &= chk(after_classes == before_classes, 'B1 班级管理中未自动建档', f'{before_classes} -> {after_classes}')

print('\n[B2] 单条新增未登记班级（仍直接拒绝）')
st, d = req('POST', '/api/students', {'className': '软件2399班', 'name': '新同学D', 'studentId': '202399002', 'grade': '2023级'})
ok &= chk(st == 400 and '不一致' in json.dumps(d, ensure_ascii=False), 'B2 单条新增同样拒绝未登记班级', f'{st} {d}')

print('\n[B3] 混合导入：1 条匹配 + 2 条不匹配 → 跳过不匹配行，其余照常导入')
before_total = req('GET', '/api/students?pageSize=50')[1].get('total')
rows_m = [
    {'年级': '2023级', '班级': '软件2301班', '姓名': '新同学E', '学号': '202301102'},
    {'年级': '2023级', '班级': '软件2399班', '姓名': '新同学F', '学号': '202399003'},
    {'年级': '2023级', '班级': '软件2398班', '姓名': '新同学G', '学号': '202398003'},
]
st, d = req('POST', '/api/students/import', {'rows': rows_m})
print('  返回:', {k: d.get(k) for k in ('total', 'inserted', 'updated', 'unchanged', 'skippedRows', 'failed')})
ok &= chk(d.get('inserted') == 1 and d.get('skippedRows') == 2 and d.get('failed') == 2,
          'B3 匹配行导入 1 条，不匹配 2 条跳过')
after_total = req('GET', '/api/students?pageSize=50')[1].get('total')
ok &= chk(after_total == before_total + 1, 'B3 学生表新增 1 条', f'{before_total} -> {after_total}')
st, d = req('GET', '/api/students?pageSize=50')
new_s = [s for s in d['list'] if s['studentId'] == '202301102']
ok &= chk(len(new_s) == 1 and new_s[0]['classTeacher'] == '张老师',
          'B3 匹配行正常写库（含班级管理岗位镜像）', f"{new_s[0]['name']}/{new_s[0]['classTeacher']}" if new_s else '未找到')
if new_s:
    req('DELETE', f"/api/students/{new_s[0]['id']}")

# ================= 清理测试数据 =================
print('\n[清理] 删除测试学生与班级')
st, d = req('GET', '/api/students?pageSize=200')
for s in d['list']:
    req('DELETE', f"/api/students/{s['id']}")
for nm in ['软件2301班', '软件2302班']:
    st2, d2 = req('DELETE', f'/api/classes/{q(nm)}')
    print(f'  删除班级 {nm}:', st2, d2 if st2 != 200 else '')
st, d = req('GET', '/api/students?pageSize=50')
st, d2 = req('GET', '/api/classes')
print('清理后 学生数:', d.get('total'), '班级数:', [c['name'] for c in d2['list']])

print('\n===== 结论:', '全部断言通过' if ok else '存在失败项', '=====')
