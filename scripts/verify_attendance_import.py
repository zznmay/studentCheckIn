#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""修改82 验证：批量导入点名记录（线下纸质点名表数字化）
场景：A1 正常导入 / A2 重复跳过 / A3 覆盖更新 / A4 已签字拒绝覆盖 / A5 名单缺人默认出勤 /
     A6 学号匹配三级 / A7 状态别名 / A8 行级错误 / A9 同场次重复行 / A10 来源筛选与统计等权 /
     P1 Excel 全链路（手工构造 xlsx → parse → import）
约定：需先在 3100 端口启动本项目服务（node server/index.js）。
"""
import base64
import io
import json
import random
import string
import urllib.parse
import urllib.request
import zipfile

BASE = 'http://127.0.0.1:3100'
TOKEN = ''
SFX = ''.join(random.choices(string.digits, k=6))
CLS = f'点名测试{SFX}班'
GRADE = '2031级'
T1, T2 = f'T{SFX}1', f'T{SFX}2'
SID1, SID2, SID3, SIDBAD = f'S{SFX}1', f'S{SFX}2', f'S{SFX}3', f'X{SFX}9'
N1, N2, N3 = '学生甲', '学生乙', '学生丙'
D1, D2, D3, D4, D5, D7, D8 = '2031-05-01', '2031-05-02', '2031-05-03', '2031-05-04', '2031-05-05', '2031-05-06', '2031-05-08'
PNG_1PX = ('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUl'
           'EQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==')


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


def make_row(date, periods, sid, name, status, note='', course='高等数学', teacher='教师甲', cls=CLS, row=None):
    d = {'date': date, 'periods': periods, 'className': cls, 'courseName': course,
         'teacher': teacher, 'sid': sid, 'name': name, 'status': status, 'note': note}
    if row is not None:
        d['_row'] = row
    return d


def sessions_of(cls=CLS, source=''):
    p = f'/api/attendance?className={q(cls)}&pageSize=50'
    if source:
        p += f'&source={source}'
    st, d = req('GET', p)
    return d


def session_detail(sid_):
    st, d = req('GET', f'/api/attendance/{sid_}')
    return d.get('session', {})


def session_logs(sid_):
    st, d = req('GET', f'/api/attendance/{sid_}/logs')
    return d.get('logs', [])


ok = True
st, d = req('POST', '/api/auth/login', {'username': 'admin', 'password': 'admin123'})
TOKEN = d.get('token', '')
print('登录:', '成功' if TOKEN else '失败')
assert TOKEN, '登录失败'

# ---------- 准备：班级 + 名单（3 名学生） ----------
st, d = req('POST', '/api/classes', {'name': CLS, 'grade': GRADE, 'major': '测试专业',
                                     'headTeacher': {'name': '测试班主任', 'staffId': T1},
                                     'counselor': {'name': '测试辅导员', 'staffId': T2},
                                     'disciplineMember': {'name': '', 'studentId': ''}})
assert st == 200, d
st, d = req('POST', '/api/students/import', {'rows': [
    {'年级': GRADE, '班级': CLS, '姓名': N1, '学号': SID1},
    {'年级': GRADE, '班级': CLS, '姓名': N2, '学号': SID2},
    {'年级': GRADE, '班级': CLS, '姓名': N3, '学号': SID3},
]})
assert st == 200 and d.get('inserted') == 3, d
print(f'准备完成：班级 {CLS}，学生 {SID1}/{SID2}/{SID3}')

# ================= A1 正常导入 =================
print('\n[A1] 正常导入：2 场 3 行（D1 1-2节 2 行 + D2 3-4节 1 行）')
ROWS_MAIN = [
    make_row(D1, ['1-2节'], SID1, N1, '出勤', row=2),
    make_row(D1, ['1-2节'], SID2, N2, '缺勤', '无故缺席', row=3),
    make_row(D2, ['3-4节'], SID1, N1, '迟到', course='大学英语', teacher='教师乙', row=4),
]
st, d = req('POST', '/api/attendance/import', {'rows': ROWS_MAIN})
print('  返回:', {k: d.get(k) for k in ('total', 'createdSessions', 'importedRows', 'skippedRows', 'errorsCount', 'noticesCount')})
ok &= chk(st == 200 and d.get('createdSessions') == 2 and d.get('importedRows') == 3 and d.get('skippedRows') == 0,
          'A1 createdSessions=2 / importedRows=3 / 无跳过', d)
ok &= chk(d.get('noticesCount') == 2 and '未出现在表中' in (d.get('notices') or [{}])[0].get('message', ''),
          'A1 两场各出一条「未出现在表中，已按出勤计入」notice', d.get('notices'))

lst = sessions_of().get('list', [])
ok &= chk(len(lst) == 2 and all(s.get('source') == 'import' for s in lst), 'A1 列表 2 条且 source=import', [(s['date'], s.get('source')) for s in lst])
s_d1 = next((s for s in lst if s['date'] == D1), {})
s_d2 = next((s for s in lst if s['date'] == D2), {})
det = session_detail(s_d1.get('id', ''))
ok &= chk(len(det.get('items', [])) == 3, 'A1 场1 items 恒等于全量名单（3 人）', len(det.get('items', [])))
it3 = next((it for it in det.get('items', []) if it['studentId'] == SID3), {})
ok &= chk(it3.get('status') == '出勤' and not it3.get('note'), 'A1 名单缺人默认出勤且备注为空', it3)
c = det.get('counts', {})
ok &= chk(c.get('出勤') == 2 and c.get('缺勤') == 1 and c.get('迟到') == 0 and c.get('请假') == 0,
          'A1 场1 counts = 出勤2/缺勤1', c)
it2 = next((it for it in det.get('items', []) if it['studentId'] == SID2), {})
ok &= chk(it2.get('note') == '无故缺席', 'A1 备注原样入库', it2.get('note'))
logs = session_logs(s_d1.get('id', ''))
cre = [x for x in logs if x.get('action') == 'create']
ok &= chk(len(cre) == 1 and (cre[0].get('via') == '批量导入') and cre[0].get('summary', {}).get('total') == 3,
          'A1 create 日志存在（via=批量导入，summary.total=3）', cre)

# ================= A2 重复导入跳过 =================
print('\n[A2] 重复导入同批（不勾选覆盖）')
st, d = req('POST', '/api/attendance/import', {'rows': ROWS_MAIN})
print('  返回:', {k: d.get(k) for k in ('createdSessions', 'skippedSessions', 'skippedRows', 'errorsCount')})
ok &= chk(d.get('createdSessions') == 0 and d.get('skippedSessions') == 2 and d.get('skippedRows') == 3,
          'A2 两场全部跳过（skippedSessions=2 / skippedRows=3）', d)
ok &= chk('已存在相同时段' in ((d.get('errors') or [{}])[0].get('message', '')) and '覆盖已有记录' in ((d.get('errors') or [{}])[0].get('message', '')),
          'A2 错误文案含「已存在相同时段」与「覆盖已有记录」指引', (d.get('errors') or [{}]))
ok &= chk(len(sessions_of().get('list', [])) == 2, 'A2 库中仍 2 条，未重复建档')

# ================= A3 覆盖更新 =================
print('\n[A3] overwrite=true 覆盖未签字记录（场1 全变 + 场2 原样）')
ROWS_COVER = [
    make_row(D1, ['1-2节'], SID1, N1, '迟到', row=2),
    make_row(D1, ['1-2节'], SID2, N2, '出勤', row=3),
    make_row(D1, ['1-2节'], SID3, N3, '缺勤', '外出比赛', row=4),
    make_row(D2, ['3-4节'], SID1, N1, '迟到', course='大学英语', teacher='教师乙', row=5),
]
st, d = req('POST', '/api/attendance/import', {'rows': ROWS_COVER, 'overwrite': True})
print('  返回:', {k: d.get(k) for k in ('createdSessions', 'updatedSessions', 'unchangedSessions', 'unchangedRows')})
ok &= chk(d.get('updatedSessions') == 1 and d.get('unchangedSessions') == 1 and d.get('unchangedRows') == 1 and d.get('createdSessions') == 0,
          'A3 updatedSessions=1 / unchangedSessions=1 / unchangedRows=1（无双重计数）', d)
det = session_detail(s_d1.get('id', ''))
m = {it['studentId']: it for it in det.get('items', [])}
ok &= chk(m[SID1]['status'] == '迟到' and m[SID2]['status'] == '出勤' and m[SID3]['status'] == '缺勤',
          'A3 场1 三名学生状态已覆盖', {k: v['status'] for k, v in m.items()})
ok &= chk(m[SID3]['note'] == '外出比赛', 'A3 覆盖备注同步更新', m[SID3]['note'])
ok &= chk(det.get('updatedBy') == '管理员' or det.get('updatedBy'), 'A3 updatedBy 已刷新', det.get('updatedBy'))
logs = session_logs(s_d1.get('id', ''))
upd = [x for x in logs if x.get('action') == 'update']
# changes 为字段级明细：SID1 status + SID2 status/note + SID3 status/note = 5 条
ok &= chk(len(upd) == 1 and upd[0].get('via') == '批量导入覆盖' and len(upd[0].get('changes', [])) == 5,
          'A3 update 日志 via=批量导入覆盖，字段级 changes=5 条', upd)

# ================= A4 已签字记录拒绝覆盖 =================
print('\n[A4] 任课老师签字后覆盖被硬拒绝')
token_ = s_d1.get('confirmToken', '')
st, d = req('POST', f'/api/confirm/{token_}', {'name': '任课老师甲', 'signature': PNG_1PX})
ok &= chk(st == 200, 'A4 免登录签字确认成功', d)
det = session_detail(s_d1.get('id', ''))
ok &= chk(det.get('confirmStatus') == 'confirmed', 'A4 confirmStatus=confirmed', det.get('confirmStatus'))
st, d = req('POST', '/api/attendance/import', {'rows': [
    make_row(D1, ['1-2节'], SID1, N1, '缺勤', row=2),
], 'overwrite': True})
ok &= chk(d.get('skippedSessions') == 1 and '不允许覆盖' in ((d.get('errors') or [{}])[0].get('message', '')),
          'A4 已签字记录覆盖被拒绝（文案含「不允许覆盖」）', d.get('errors'))
det = session_detail(s_d1.get('id', ''))
m = {it['studentId']: it for it in det.get('items', [])}
ok &= chk(m[SID1]['status'] == '迟到', 'A4 已签字数据未被改动（SID1 仍为迟到）', m[SID1]['status'])

# ================= A6 学号匹配三级 =================
print('\n[A6] 学号匹配：名单外报错 / 学号-姓名不匹配报错 / 同班同名兜底')
st, d = req('POST', '/api/attendance/import', {'rows': [
    make_row(D5, ['1-2节'], SIDBAD, '不存在的学生' + SFX, '出勤', row=2),
]})
ok &= chk(d.get('createdSessions') == 0 and '未在班级' in ((d.get('errors') or [{}])[0].get('message', '')) and SIDBAD in ((d.get('errors') or [{}])[0].get('message', '')),
          'A6a 学号与姓名均不在名单 → 报错且含学号', d.get('errors'))
st, d = req('POST', '/api/attendance/import', {'rows': [
    make_row(D5, ['1-2节'], SID2, N1, '出勤', row=2),
]})
ok &= chk(d.get('createdSessions') == 0 and '不匹配' in ((d.get('errors') or [{}])[0].get('message', '')),
          'A6b 学号与姓名不匹配报错', d.get('errors'))
st, d = req('POST', '/api/attendance/import', {'rows': [
    make_row(D5, ['1-2节'], 'WRONG-ID', N1, '出勤', row=2),
]})
notices_c = d.get('notices') or []
ok &= chk(d.get('createdSessions') == 1 and notices_c and '同班同名' in notices_c[0].get('message', ''),
          'A6c 同班同名唯一命中 → 视为学号更正并 notice（另有缺人 notice）', {'created': d.get('createdSessions'), 'notices': notices_c})
lst = sessions_of().get('list', [])
s_d5 = next((s for s in lst if s['date'] == D5), {})
det = session_detail(s_d5.get('id', ''))
m = {it['studentId']: it for it in det.get('items', [])}
ok &= chk(m.get(SID1, {}).get('status') == '出勤', 'A6c 兜底命中后按名单学号入库', list(m.keys()))
ok &= chk(all(k in (SID1, SID2, SID3) for k in m), 'A6c 未产生名单外学号的条目', list(m.keys()))

# ================= A7 状态别名归一（含假单联动） =================
print('\n[A7a] 先导入 D3 病假假单（全天覆盖），别名场中的「病假」应保留为请假')
LV_ROWS = [{'班级': CLS, '姓名': N3, '学号': SID3, '请假开始日期': D3, '请假结束日期': D3,
            '请假开始时间': '00:00', '请假结束时间': '23:59', '假别': '病假', '事由': '测试病假'}]
st, d = req('POST', '/api/leaves/import', {'rows': LV_ROWS})
ok &= chk(st == 200, 'A7a 假单导入成功', d)
st, d = req('POST', '/api/attendance/import', {'rows': [
    make_row(D3, ['早自习'], SID1, N1, '√', row=2),
    make_row(D3, ['早自习'], SID2, N2, '旷课', row=3),
    make_row(D3, ['早自习'], SID3, N3, '病假', '感冒', row=4),
]})
ok &= chk(d.get('createdSessions') == 1 and d.get('errorsCount') == 0, 'A7a 别名场导入成功', d)
lst = sessions_of().get('list', [])
s_d3 = next((s for s in lst if s['date'] == D3), {})
c = s_d3.get('counts', {})
ok &= chk(c.get('出勤') == 1 and c.get('缺勤') == 1 and c.get('请假') == 1, 'A7a counts：出勤1/缺勤1/请假1（√/旷课/病假 均归一）', c)
det = session_detail(s_d3.get('id', ''))
m = {it['studentId']: it for it in det.get('items', [])}
ok &= chk(m[SID3]['status'] == '请假' and '假单·病假' in m[SID3]['note'],
          'A7a 有假单覆盖时请假保留，备注由假单对账生成（与线上点名一致）', m[SID3])

print('\n[A7b] 无假单覆盖时「病假」被假单对账改判缺勤（与线上点名行为等权）')
st, d = req('POST', '/api/attendance/import', {'rows': [
    make_row(D8, ['早自习'], SID1, N1, '√', row=2),
    make_row(D8, ['早自习'], SID2, N2, '出勤', row=3),
    make_row(D8, ['早自习'], SID3, N3, '病假', '感冒', row=4),
]})
ok &= chk(d.get('createdSessions') == 1, 'A7b 导入成功', d.get('createdSessions'))
lst = sessions_of().get('list', [])
s_d8 = next((s for s in lst if s['date'] == D8), {})
det = session_detail(s_d8.get('id', ''))
m = {it['studentId']: it for it in det.get('items', [])}
ok &= chk(m[SID3]['status'] == '缺勤' and '改判缺勤' in m[SID3]['note'],
          'A7b 无假单的请假被改判缺勤（与 POST /api/attendance 保存后行为一致）', m[SID3])
logs = session_logs(s_d8.get('id', ''))
sysl = [x for x in logs if x.get('action') == 'system']
ok &= chk(len(sysl) == 1, 'A7b 对账改判落「假单自动校正」system 日志', [x.get('action') for x in logs])

print('\n[A5] 名单缺人：D4 晚自习仅 1 行（2 名学生未出现）')
st, d = req('POST', '/api/attendance/import', {'rows': [
    make_row(D4, ['晚自习'], SID1, N1, '出勤', row=2),
]})
ok &= chk(d.get('createdSessions') == 1 and '2 名学生未出现在表中' in ((d.get('notices') or [{}])[0].get('message', '')),
          'A5 notice 含「2 名学生未出现在表中」', d.get('notices'))
lst = sessions_of().get('list', [])
s_d4 = next((s for s in lst if s['date'] == D4), {})
ok &= chk(len(session_detail(s_d4.get('id', '')).get('items', [])) == 3, 'A5 缺席学生按出勤计入（items=3）')

# ================= A8 行级错误 =================
print('\n[A8] 行级错误：必填缺失 / 状态非法 / 日期非法 / 班级未登记')
ROWS_BAD = [
    make_row(D7, ['1-2节'], '', N1, '出勤', row=2),                                   # 缺学号
    make_row(D7, ['1-2节'], SID1, N1, '睡觉', row=3),                                 # 状态非法
    make_row('2031-05-32', ['1-2节'], SID1, N1, '出勤', row=4),                       # 日期非法
    make_row(D7, ['1-2节'], SID1, N1, '出勤', course='', row=5),                      # 缺课程
    make_row(D7, ['1-2节'], SID1, N1, '出勤', cls='不存在的班' + SFX, row=6),          # 班级未登记
]
st, d = req('POST', '/api/attendance/import', {'rows': ROWS_BAD})
errs = d.get('errors', [])
print('  errors:', [e.get('message') for e in errs])
ok &= chk(d.get('createdSessions') == 0 and d.get('errorsCount') == 5 and d.get('skippedRows') == 5,
          'A8 5 行全部报错跳过（errorsCount=5）', {k: d.get(k) for k in ('createdSessions', 'errorsCount', 'skippedRows')})
ok &= chk(any('学号为必填' in e['message'] for e in errs), 'A8a 缺学号文案')
ok &= chk(any('无法识别' in e['message'] and '睡觉' in e['message'] for e in errs), 'A8b 状态非法文案含原值')
ok &= chk(any('无法识别' in e['message'] and '日期' in e['message'] for e in errs), 'A8c 日期非法文案')
ok &= chk(any('课程为必填' in e['message'] for e in errs), 'A8d 缺课程文案')
ok &= chk(any('班级' in e['message'] and '登记' in e['message'] for e in errs), 'A8e 班级未登记文案')

# ================= A9 同场次重复行 =================
print('\n[A9] 同场次同学号重复行（保留首行）')
st, d = req('POST', '/api/attendance/import', {'rows': [
    make_row(D7, ['1-2节'], SID1, N1, '出勤', row=2),
    make_row(D7, ['1-2节'], SID1, N1, '迟到', row=3),
    make_row(D7, ['1-2节'], SID2, N2, '出勤', row=4),
]})
ok &= chk(d.get('createdSessions') == 1 and d.get('errorsCount') == 1 and '出现多行' in ((d.get('errors') or [{}])[0].get('message', '')),
          'A9 重复行报错（保留首行）', d.get('errors'))
lst = sessions_of().get('list', [])
s_d7 = next((s for s in lst if s['date'] == D7), {})
m = {it['studentId']: it for it in session_detail(s_d7.get('id', '')).get('items', [])}
ok &= chk(m[SID1]['status'] == '出勤' and m[SID2]['status'] == '出勤', 'A9 库中为首行状态', {k: v['status'] for k, v in m.items()})

# ================= A10 来源筛选与统计等权 =================
# A10 时点共 7 场（D1/D2/D3/D4/D5/D7/D8）。items 恒等全量名单 → 每生应到 = 场次数。
# 终态：SID1 迟到2（D1/D2）；SID2 缺勤1（D3 旷课）；SID3 缺勤2（D1/D8 改判）+ 请假1（D3 假单覆盖）。
print('\n[A10] 来源筛选 / 统计等权（导入记录与线上点名同口径计入）')
imp = sessions_of(source='import')
onl = sessions_of(source='online')
ok &= chk(imp.get('total') == 7 and all(s.get('source') == 'import' for s in imp.get('list', [])),
          'A10 source=import 筛出全部 7 场导入记录', imp.get('total'))
ok &= chk(onl.get('total') == 0, 'A10 source=online 为空（本测试无线上记录）', onl.get('total'))
st, d = req('GET', f'/api/stats?className={q(CLS)}')
byst = {(x['studentId']): x for x in d.get('byStudent', [])}
ok &= chk(byst.get(SID1, {}).get('should') == 7 and byst.get(SID2, {}).get('should') == 7 and byst.get(SID3, {}).get('should') == 7,
          'A10 应到人次 = 场次数（items 恒等全量名单，导入记录等权计入）', {k: v.get('should') for k, v in byst.items()})
ok &= chk(byst.get(SID2, {}).get('缺勤') == 1 and byst.get(SID3, {}).get('缺勤') == 2 and byst.get(SID3, {}).get('请假') == 1,
          'A10 缺勤/请假计数与导入终态一致（含覆盖更新与假单改判）', {k: (v.get('缺勤'), v.get('请假')) for k, v in byst.items()})
ok &= chk(byst.get(SID1, {}).get('迟到') == 2, 'A10 迟到计数=2（D1/D2 各一次）', byst.get(SID1))

# ================= P1 Excel 全链路 =================
print('\n[P1] 手工构造 xlsx（含前导说明行）→ parse → import 全链路')


def build_xlsx(headers, rows):
    """照 server/xlsx.js buildXlsx 的骨架：STORED zip + inlineStr 单元格。"""
    def esc(s):
        return str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

    def col_ref(i):
        s = ''
        i += 1
        while i > 0:
            s = chr(65 + (i - 1) % 26) + s
            i //= 26
        return s

    all_rows = [headers] + rows
    sheet = ''.join(
        f'<row r="{ri + 1}">' + ''.join(
            f'<c r="{col_ref(ci)}{ri + 1}" t="inlineStr"><is><t xml:space="preserve">{esc(v)}</t></is></c>'
            for ci, v in enumerate(row)
        ) + '</row>'
        for ri, row in enumerate(all_rows)
    )
    files = {
        '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
        '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
        'xl/styles.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>',
        'xl/worksheets/sheet1.xml': f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>{sheet}</sheetData></worksheet>',
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_STORED) as z:
        for name, content in files.items():
            z.writestr(name, content)
    return buf.getvalue()


HEADERS = ['日期', '节次', '班级', '课程', '教师', '学号', '姓名', '状态', '备注']
XLSX_ROWS = [
    ['（说明行：本表为线下纸质点名表数字化，以下为示例数据）', '', '', '', '', '', '', '', ''],
    ['2031-05-07', '5-6节', CLS, '数据结构', '教师丙', SID1, N1, '√', ''],
    ['2031-05-07', '5-6节', CLS, '数据结构', '教师丙', SID2, N2, '事假', '家里有事'],
]
xlsx_bytes = build_xlsx(HEADERS, XLSX_ROWS)
st, d = req('POST', '/api/attendance/import/parse', {'dataBase64': base64.b64encode(xlsx_bytes).decode()})
rows_p = d.get('rows', [])
print('  parse 返回:', d.get('total'), [r.get('_row') for r in rows_p])
ok &= chk(st == 200 and d.get('total') == 2 and [r.get('_row') for r in rows_p] == [3, 4],
          'P1a parse 跳过说明行，_row=3/4', d)
ok &= chk(rows_p and rows_p[0].get('status') == '√' and rows_p[1].get('status') == '事假' and rows_p[0].get('date') == '2031-05-07',
          'P1b parse 保留原始状态值与日期', rows_p[:1])
st, d = req('POST', '/api/attendance/import', {'rows': rows_p})
ok &= chk(d.get('createdSessions') == 1 and d.get('importedRows') == 2 and d.get('skippedRows') == 0 and d.get('errorsCount') == 0,
          'P1c 导入成功（说明行已在 parse 静默跳过，归并为 1 场 2 行）', d)
lst = sessions_of().get('list', [])
s_x = next((s for s in lst if s['date'] == '2031-05-07'), {})
det = session_detail(s_x.get('id', ''))
m = {it['studentId']: it for it in det.get('items', [])}
ok &= chk(m.get(SID1, {}).get('status') == '出勤' and m.get(SID2, {}).get('status') == '缺勤' and '改判缺勤' in m.get(SID2, {}).get('note', ''),
          'P1d √→出勤；事假→请假后被假单对账改判缺勤（无假单，与线上点名一致）', {k: (v['status'], v['note']) for k, v in m.items()})

print('\n[P2] 错表头 → 400 明确文案')
bad = build_xlsx(['AAA', 'BBB'], [['1', '2']])
st, d = req('POST', '/api/attendance/import/parse', {'dataBase64': base64.b64encode(bad).decode()})
ok &= chk(st == 400 and '表头' in d.get('message', ''), 'P2 错表头返回 400', {'status': st, 'message': d.get('message')})

# ================= 清理 =================
print('\n[清理] 删除假单 / 点名记录 / 学生 / 账号 / 教职工 / 班级')
st, d = req('GET', f'/api/leaves?pageSize=50&classNames={q(CLS)}')
for x in d.get('list', []):
    if x.get('studentId') == SID3:
        st2, _ = req('DELETE', f"/api/leaves/{x['id']}")
        print('  删除假单:', st2)
ids = [s['id'] for s in sessions_of().get('list', [])]
if ids:
    st, d = req('POST', '/api/attendance/batch-delete', {'ids': ids})
    print('  删除点名记录:', d.get('deleted'))
req('POST', '/api/students/clear', {'className': CLS})
st, d = req('GET', '/api/accounts?pageSize=500')
for x in d.get('list', []):
    if x.get('username') in (T1, T2, SID1):
        req('DELETE', f"/api/accounts/{x['id']}")
st, d = req('GET', '/api/staffs')
for x in d.get('list', []):
    if x.get('staffId') in (T1, T2):
        req('DELETE', f"/api/staffs/{x['id']}")
st, d = req('DELETE', f'/api/classes/{q(CLS)}')
print('  删除班级:', st)
ok &= chk(len(sessions_of().get('list', [])) == 0, '清理后无残留点名记录')

print('\n===== 结论:', '全部断言通过' if ok else '存在失败项', '=====')
