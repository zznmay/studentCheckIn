# -*- coding: utf-8 -*-
"""生成《学生考勤工作台 2.1 用户操作手册》Word 文档。"""
from docx import Document
from docx.shared import Pt, RGBColor, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

CN_FONT = "Microsoft YaHei"

doc = Document()

# ---------- 全局字体（中英文均用雅黑，避免乱码）----------
def set_run_font(run, size=10.5, bold=False, color=None):
    run.font.name = CN_FONT
    run.font.size = Pt(size)
    run.bold = bold
    if color is not None:
        run.font.color.rgb = color
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn('w:rFonts'))
    if rfonts is None:
        rfonts = OxmlElement('w:rFonts')
        rpr.append(rfonts)
    rfonts.set(qn('w:eastAsia'), CN_FONT)
    rfonts.set(qn('w:ascii'), CN_FONT)
    rfonts.set(qn('w:hAnsi'), CN_FONT)

# 正文字体
style = doc.styles['Normal']
style.font.name = CN_FONT
style.font.size = Pt(10.5)
style.element.rPr.rFonts.set(qn('w:eastAsia'), CN_FONT)

# ---------- 辅助函数 ----------
def heading(text, level=1):
    h = doc.add_heading(level=level)
    run = h.add_run(text)
    set_run_font(run, size=15 if level == 1 else (13 if level == 2 else 11.5), bold=True,
                 color=RGBColor(0x1F, 0x4E, 0x79))
    return h

def para(text, bold=False, size=10.5, color=None, align=None, space_after=6):
    p = doc.add_paragraph()
    run = p.add_run(text)
    set_run_font(run, size=size, bold=bold, color=color)
    if align is not None:
        p.alignment = align
    p.paragraph_format.space_after = Pt(space_after)
    return p

def bullet(text, level=0):
    p = doc.add_paragraph(style='List Bullet')
    if level:
        p.paragraph_format.left_indent = Cm(0.75 * (level + 1))
    run = p.add_run(text)
    set_run_font(run, size=10.5)
    p.paragraph_format.space_after = Pt(3)
    return p

def numbered(text):
    p = doc.add_paragraph(style='List Number')
    run = p.add_run(text)
    set_run_font(run, size=10.5)
    p.paragraph_format.space_after = Pt(3)
    return p

def make_table(headers, rows, col_widths=None):
    table = doc.add_table(rows=1, cols=len(headers))
    table.style = 'Light Grid Accent 1'
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    hdr = table.rows[0].cells
    for i, h in enumerate(headers):
        hdr[i].text = ''
        run = hdr[i].paragraphs[0].add_run(h)
        set_run_font(run, size=10, bold=True, color=RGBColor(0xFF, 0xFF, 0xFF))
        shade_cell(hdr[i], '1F4E79')
    for row in rows:
        cells = table.add_row().cells
        for i, val in enumerate(row):
            cells[i].text = ''
            run = cells[i].paragraphs[0].add_run(str(val))
            set_run_font(run, size=9.5)
    if col_widths:
        for i, w in enumerate(col_widths):
            for r in table.rows:
                r.cells[i].width = Cm(w)
    return table

def shade_cell(cell, hex_color):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement('w:shd')
    shd.set(qn('w:val'), 'clear')
    shd.set(qn('w:color'), 'auto')
    shd.set(qn('w:fill'), hex_color)
    tcPr.append(shd)

def callout(text, fill='FDECEA', title='注意'):
    table = doc.add_table(rows=1, cols=1)
    table.style = 'Table Grid'
    cell = table.rows[0].cells[0]
    cell.text = ''
    p = cell.paragraphs[0]
    r1 = p.add_run(f'【{title}】 ')
    set_run_font(r1, size=10, bold=True, color=RGBColor(0xC0, 0x39, 0x2B))
    r2 = p.add_run(text)
    set_run_font(r2, size=10)
    shade_cell(cell, fill)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)
    return table

# ===================== 封面 =====================
title = doc.add_paragraph()
title.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = title.add_run('学生考勤工作台 2.1')
set_run_font(r, size=26, bold=True, color=RGBColor(0x1F, 0x4E, 0x79))
sub = doc.add_paragraph()
sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = sub.add_run('用户操作手册')
set_run_font(r, size=18, bold=True, color=RGBColor(0x2E, 0x86, 0xC1))
doc.add_paragraph()
meta = doc.add_paragraph()
meta.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = meta.add_run('适用对象：纪律委员 · 权益部 · 班主任 · 辅导员 · 学院考勤负责老师\n'
                 '版本：2.1（生产模式）\n'
                 '编制日期：2026-09-25\n'
                 '文档状态：正式发布')
set_run_font(r, size=11)

# 封面分隔
doc.add_paragraph()
callout('本手册所述功能均依据 2.1 版本实际代码权限配置编写。平台当前为「生产模式」：'
        '系统中仅预置管理员账号，演示数据已全部清空，使用前须先导入班级名单并生成各角色账号。',
        fill='EAF2F8', title='阅读提示')

doc.add_page_break()

# ===================== 目录式说明 =====================
heading('一、平台简介', 1)
para('学生考勤工作台是一款面向高校班级考勤管理的 Web 应用，用于记录每节课的出勤、迟到、缺勤、'
     '请假情况，并支持任课老师免登录在线签字确认、假单（公假/病假/事假/其他）批量导入与自动对账、'
     '多维度考勤统计与 Excel 导出。')
para('平台采用账号 + 角色权限体系，不同角色看到的菜单与可执行的操作各不相同。本手册按角色分别说明其'
     '登录方式、日常操作流程及注意事项。')

heading('二、角色与权限总览', 1)
para('系统共设 6 种角色，权限矩阵如下（✓ 表示可执行 / 可见，— 表示无权限）：', bold=True)
make_table(
    ['功能模块', '管理员', '权益部', '纪律委员', '班主任', '辅导员', '学院考勤负责老师'],
    [
        ['工作台（概览）', '✓', '✓', '✓', '✓', '✓', '✓'],
        ['账号管理（建账号/教职工名单）', '✓', '—', '—', '—', '—', '✓*'],
        ['班级名单（导入/维护）', '✓', '✓', '—', '—', '—', '✓'],
        ['考勤点名（新建并提交）', '✓', '✓', '✓（仅本班）', '仅查看', '仅查看', '✓（全院）'],
        ['考勤点名（修改考勤状态）', '✓', '✓', '—（锁定）', '—（只读）', '—（只读）', '✓（全院）'],
        ['考勤点名（删除记录）', '✓', '—', '—', '—', '—', '—'],
        ['假单管理（导入/生效/删除）', '✓', '✓', '—', '—', '—', '✓'],
        ['上课时间段设置', '✓', '✓', '—', '—', '—', '✓'],
        ['数据统计（含 Excel 导出）', '✓', '✓', '—', '✓', '✓', '✓'],
        ['数据管理（备份/恢复/迁移）', '✓', '—', '—', '—', '—', '—'],
    ],
    col_widths=[6.2, 1.6, 1.6, 2.0, 1.6, 1.6, 2.2],
)
callout('纪律委员提交点名后，该条记录即锁定为只读（仅可查看），考勤状态更正须由权益部或管理员完成，'
        '或经假单导入自动对账；班主任、辅导员为只读角色，不能修改或删除任何考勤记录。',
        fill='FDECEA', title='权限要点')
para('学院考勤负责老师：面向学院层面负责考勤督办的老师（可由辅导员兼任），权限接近管理员——可查看并操作'
     '全院各模块数据（班级名单、考勤点名、假单管理、数据统计、账号管理）。系统限制其：不能删除点名记录；'
     '不能进入数据管理模块（备份/恢复/迁移）；不能创建、修改、删除「管理员」和「学院考勤负责老师」账号，'
     '也不能把任何账号改为这两类角色（防越权）。账号仅可由管理员创建。')
para('多角色支持：同一账号可关联多个角色（在「账号管理 → 编辑」中勾选），实际权限按所分配角色合并生效——'
     '任一角色授予的功能即可使用，可见范围取各角色中的最大范围。例如"权益部 + 辅导员"账号可维护全院名单、'
     '导入假单，同时保留辅导员身份。角色变更即时生效，并记录操作日志以便追溯。')

# ===================== 三、首次启用 =====================
heading('三、首次启用（管理员必做）', 1)
para('平台初次上线后只有管理员一个账号，班级名单、考勤、假单均为空。管理员需依次完成以下初始化，'
     '之后各角色才能正常使用。', bold=True)

heading('3.1 登录并修改初始密码', 2)
numbered('打开平台网址，在登录页输入管理员账号：用户名 admin，初始密码 admin123。')
numbered('登录后系统强制要求修改密码（此后所有由管理员生成的账号首次登录也需改密）。请设置一个强度较高的新密码并妥善保管。')
bullet('登录页已移除演示账号快捷填充模块；输入密码时，可点击密码框右侧的眼睛图标切换明文/密文显示。')
callout('初始管理员密码为通用弱密码，务必在首次登录后立即修改，并建议后续在「账号管理」中再次复核。',
        fill='FDECEA')

heading('3.2 导入班级名单（权益部协助）', 2)
para('纪律委员要能正常点名，前提是系统中已有对应班级的学生名单。操作步骤如下（管理员或权益部均可）：')
numbered('进入左侧菜单「班级名单」。')
numbered('点击「下载导入模板」，按模板填写：学号、姓名、班级、年级（年级可留空，系统会按学号前 4 位自动推导，如 202301001 → 2023级）。')
numbered('点击「导入」，上传填好的 Excel，系统逐行校验并写入。导入前建议先在系统内清空或确认无重复班级。')
callout('若某班级尚未导入名单，纪律委员在「考勤点名」中提交该班点名时会提示"该班级暂无学生名单，请先在班级名单中导入"。',
        fill='FDECEA')

heading('3.3 维护教职工名单（生成班主任/辅导员账号前置）', 2)
para('班主任、辅导员账号需先将其录入「教职工名单」，方可一键生成登录账号。仅管理员可维护：')
numbered('进入「账号管理 → 教职工名单」，点击「新增教职工」。')
numbered('填写：工号、姓名、岗位（仅可选"班主任"或"辅导员"）、所带班级（可多选，决定该角色登录后可见的数据范围）。')
numbered('保存后，该教职工即出现在名单中，可用于生成账号。')

heading('3.4 生成各角色账号', 2)
para('账号统一由管理员在「账号管理」中生成，生成后把账号与初始密码告知本人，对方首次登录会被引导修改密码。')
para('（1）纪律委员 / 权益部账号（账号=学号，从学生名单中选取）：', bold=True)
bullet('在「账号管理 → 生成学生账号」中，选择角色（纪律委员或权益部）、班级、对应学生。')
bullet('系统自动带出姓名；初始密码规则为：Hzpt@ ＋ 学号后六位。')
bullet('纪律委员账号会自动绑定其所在班级，登录后只能看到并处理本班考勤。')
para('（2）班主任 / 辅导员账号（账号=工号，从教职工名单中选取）：', bold=True)
bullet('在「账号管理 → 生成教职工账号」中，选择角色（班主任或辅导员）、工号。')
bullet('系统自动校验该工号的"岗位"是否与所选角色一致，并带入姓名与所带班级；初始密码规则为：Hzpt@ ＋ 工号。')
callout('一个学号 / 工号只能生成一次账号，重复生成会报错。若需重置密码，可在「账号管理」中编辑该账号。',
        fill='FDECEA')

heading('3.5 设置上课时间段', 2)
para('系统默认节次为 1-2节、3-4节、5-6节、7-8节，并预置了建议起止时间。管理员或权益部可在'
     '「假单管理 → 上课时间段设置」中按本校实际课表调整各节次的开始/结束时间，保存后立即生效。')

# ===================== 四、纪律委员 =====================
heading('四、纪律委员操作指南', 1)
para('纪律委员负责每节课的课堂点名，仅能处理自己所在班级。可使用的菜单：工作台、考勤点名。', bold=True)
heading('4.1 新建并提交点名', 2)
numbered('进入「考勤点名」，点击「新建点名」。')
numbered('选择班级（仅显示你所在的班级）、上课日期、节次（可多选，如同时点 1-2节 和 3-4节）、课程名称、任课老师。')
numbered('系统自动载入该班全体学生，默认状态为"出勤"。逐一对迟到/缺勤/请假学生点击切换状态，可填写备注。')
numbered('确认无误后点击「提交」。同一班级、同一日期、同一时段若已存在记录，系统会提示直接编辑，避免重复。')
heading('4.2 生成并发送任课老师确认链接', 2)
numbered('提交后，在「考勤点名」列表或详情页，找到该记录的"复制链接"按钮。')
numbered('点击后链接已复制到剪贴板（如环境不支持自动复制，可手动选取复制），通过微信等方式发给任课老师。')
numbered('链接形如：平台网址/#/confirm/（一串令牌），老师无需登录即可打开。')
callout('纪律委员提交后记录即锁定为只读，不能再修改考勤状态；若需更正，须由权益部或管理员处理，'
        '或由假单导入自动覆盖。考勤记录被修改（含状态更正、假单对账）后，任课老师已有的签字确认仍然有效，无需重新确认。', fill='FDECEA')
heading('4.3 查看与核对', 2)
bullet('在「考勤点名」列表中可查看本班所有点名记录、各状态人数统计及确认状态（已确认/待确认）。')
bullet('「工作台」提供本班的当日/近期考勤概览，便于快速掌握异常。')

# ===================== 五、权益部 =====================
heading('五、权益部操作指南', 1)
para('权益部是考勤数据的"总控"角色，负责班级名单维护、假单管理、异常考勤更正、时间段设置，'
     '并可与管理员一样新建点名。可使用的菜单：工作台、班级名单、考勤点名、假单管理、数据统计。', bold=True)
heading('5.1 班级名单维护', 2)
bullet('在「班级名单」中导入、新增、编辑、删除学生信息（详见 3.2）。')
heading('5.2 新建 / 更正点名', 2)
bullet('可像纪律委员一样为任意班级新建点名（不受班级限制）。')
bullet('对纪律委员已提交的记录，若发现状态有误，可在「考勤点名 → 详情」中单独修改某学生的考勤状态或备注；'
       '修改后该记录会重新进入"待确认"状态。')
bullet('注意：只有管理员能删除点名记录，权益部无删除权限。')
heading('5.3 假单管理（导入 / 生效 / 删除）', 2)
numbered('进入「假单管理」，点击「下载导入模板」，按模板填写请假信息（学生、班级、请假类型、起止日期/时间等）。')
numbered('点击「导入」，系统逐行校验并创建假单，状态初始为"待生效"。')
numbered('对需生效的假单，点击「生效」：系统会自动将该生对应日期/节次的"缺勤"改为"请假"，实现考勤对账。')
numbered('也可使用「导入系统请假数据」对接外部系统导出的 Excel（仅导入"审核状态=已通过"的记录）。')
numbered('误导入或学生销假时，可「删除」假单，删除后系统会把失去假单覆盖的"请假"自动改回"缺勤"并对账。')
callout('假单生效/删除会实时影响考勤统计中的"请假/缺勤"计数，请务必在统计前完成对账。', fill='FDECEA')
heading('5.4 上课时间段设置', 2)
bullet('见 3.5，按本校课表维护节次时间。')

# ===================== 六、班主任 =====================
heading('六、班主任操作指南', 1)
para('班主任为只读角色，负责查看所带班级的考勤与统计，不参与点名与修改。可见数据仅限"所带班级"。'
     '可使用的菜单：工作台、考勤点名（仅查看）、数据统计。', bold=True)
heading('6.1 查看考勤记录', 2)
bullet('进入「考勤点名」，列表与详情仅展示你所带班级的点名记录及异常名单，可核对确认状态与任课老师签名。')
bullet('班主任不能新建、修改或删除任何考勤记录；如需更正，请联系权益部或管理员。')
heading('6.2 查看数据统计', 2)
bullet('进入「数据统计」，可查看所带班级的考勤汇总、缺勤排名、按日期/班级筛选，并支持导出 Excel 用于存档或上报。')

# ===================== 七、辅导员 =====================
heading('七、辅导员操作指南', 1)
para('辅导员权限与班主任一致（只读、数据范围=所带班级），常用于掌握所负责年级/专业的整体考勤动向。'
     '可使用的菜单：工作台、考勤点名（仅查看）、数据统计。', bold=True)
bullet('在「考勤点名」中查看所辖班级的异常考勤与确认情况。')
bullet('在「数据统计」中导出所带范围的考勤报表，辅助谈心谈话与学业预警。')

# ===================== 八、任课老师签字 =====================
heading('八、任课老师免登录签字确认流程', 1)
para('为减轻任课老师负担，平台提供免登录确认链接，老师无需注册账号即可核对并签名。', bold=True)
numbered('纪律委员/权益部将「复制链接」得到的确认链接通过微信等发送给任课老师。')
numbered('老师点击链接打开确认页（公开页面，自动带入任课老师姓名，可手动修改）。')
numbered('页面仅展示本节课的异常考勤名单：缺勤同学、迟到同学、请假同学（不展示全班明细），顶部显示班级/日期/节次/课程等统计。')
numbered('老师核对无误后，在签名区手写签名，点击「确认提交」。')
numbered('提交后记录状态变为"已确认"，并留存确认人姓名、时间与手写签名图片，可在「考勤点名」详情中查看。')
callout('任课老师只需在下课后签字确认一次，确认后无论考勤记录后续是否被修改（含权益部更正状态、假单自动对账），'
        '签字确认均保持有效，无需重复签名。确认链接永久有效且不变，可随时重新打开查看或转发同一老师。', fill='FDECEA')

# ===================== 九、常见问题 =====================
heading('九、常见问题与注意事项', 1)
faqs = [
    ('忘记管理员密码怎么办？', '管理员密码由系统管理员掌握。如遗忘，需由部署方重置 data/users.json 中对应账号的密码哈希，或重新初始化（会清空数据，请谨慎）。'),
    ('纪律委员能看到其他班吗？', '不能。纪律委员账号仅绑定本班，登录后只能看到并处理自己班级的考勤。'),
    ('学院考勤负责老师和管理员有什么区别？', '学院考勤负责老师权限接近管理员，可管理全院名单、点名、假单、统计和普通账号；但不能删除点名记录、不能使用数据管理（备份/恢复/迁移），也不能创建、修改或删除管理员及学院考勤负责老师账号。该角色账号仅能由管理员创建。'),
    ('一个账号可以有多个角色吗？', '可以。在「账号管理 → 编辑」中勾选多个角色即可赋予多重身份（如"权益部 + 辅导员"），实际权限按所分配角色合并生效；角色变更保存后即时生效，无需重新登录。每次角色变更都会记录在「数据管理 → 操作日志」中以便追溯。'),
    ('班主任/辅导员能看到全部班级吗？', '仅能看到管理员为其账号配置的"所带班级"。若账号未配置班级，则不做限制（可见全部），建议管理员在生成账号时正确填写所带班级。'),
    ('点名提交后还能改吗？', '纪律委员提交后锁定为只读；权益部/管理员可修改状态；班主任/辅导员始终只读。记录被修改后，任课老师已有的签字确认依然有效，无需重新确认。'),
    ('假单怎么影响考勤？', '假单"生效"后，系统自动把对应学生该日期/节次的"缺勤"改为"请假"；删除假单则反向改回，并重新对账。'),
    ('任课老师打开确认链接是空白页？', '请确认使用的是最新部署版本，且链接完整（含 #/confirm/ 及令牌）。确认页为公开路由，任何人都可打开，无需登录。'),
    ('数据保存在哪里？', '当前版本采用服务端 JSON 文件存储（data/ 目录），部署在应用服务器沙箱中。'),
]
for q, a in faqs:
    p = doc.add_paragraph()
    r = p.add_run('Q：' + q)
    set_run_font(r, size=10.5, bold=True, color=RGBColor(0x1F, 0x4E, 0x79))
    p.paragraph_format.space_after = Pt(1)
    p2 = doc.add_paragraph()
    r2 = p2.add_run('A：' + a)
    set_run_font(r2, size=10.5)
    p2.paragraph_format.space_after = Pt(6)

# ===================== 十、数据安全 =====================
heading('十、数据安全与备份提示', 1)
callout('重新部署（覆盖发布）会用本地 data/ 目录覆盖线上运行数据，可能造成考勤记录丢失。'
        '在重新部署前，请务必先备份线上 data/ 目录（users / students / attendance / leaves / tokens / settings / staffs 等 JSON 文件）。',
        fill='FDECEA', title='重要')
bullet('建议定期导出「数据统计」中的 Excel 报表作为离线备份。')
bullet('账号密码、手写签名等敏感信息仅保存在服务端，请勿在公共设备保存登录状态。')
bullet('初始密码（Hzpt@学号后六位 / Hzpt@工号 / admin123）均为弱密码，相关人员首次登录后须立即修改。')

# 页脚
section = doc.sections[0]
footer = section.footer
fp = footer.paragraphs[0]
fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = fp.add_run('学生考勤工作台 2.1 · 用户操作手册 · 第 页（共 页）')
set_run_font(r, size=9, color=RGBColor(0x88, 0x88, 0x88))

out1 = '/Users/zhouzhennan/Desktop/AI测试/AI应用/学生考勤平台2.0/用户操作手册.docx'
out2 = '/Users/zhouzhennan/Desktop/AI测试/AI应用/学生考勤工作台2.1/用户操作手册.docx'
doc.save(out1)
# 同时保存到 2.1 版本快照目录
import os
os.makedirs(os.path.dirname(out2), exist_ok=True)
doc.save(out2)
print('SAVED:', out1)
print('SAVED:', out2)
