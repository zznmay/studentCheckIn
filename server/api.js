'use strict';
const crypto = require('crypto');
const store = require('./store');
// 修改80：附件外置（签名 / 异议佐证材料按 sha256 落盘，记录只存引用；读取点回填 dataUri）
const attachments = require('./attachments');
const xlsx = require('./xlsx');
const {
  PERIODS,
  PERIOD_JIE,
  LATE_JIE,
  jieSumOf,
  STATUSES,
  ROLE_NAMES,
  PRIVILEGED_ROLES,
  PUNISHMENT_LEVELS,
  punishmentIndexOf,
  uid,
  nowISO,
  fmtDate,
  hashPassword,
  verifyPassword,
  json,
  readBody,
  normDate,
  normGrade, // 修改69：年级归一化（与前端 gradeClassCascade.js 的 normGrade 同规则）
  normTime,
  normPeriods,
  normLeaveType,
  schoolYearOf,
  defaultTerms,
  paginate,
} = require('./utils');

// 可查看数据统计与导出 Excel 的角色（学院考勤负责老师为全院只读+受限管理；班主任 / 辅导员为只读查看）
const VIEW_ROLES = ['admin', 'rights', 'headTeacher', 'counselor', 'collegeOfficer'];

// 处分管理可查看角色（修改30）：需求指定 5 类角色；纪律委员不在其中
const PUNISH_VIEW_ROLES = ['admin', 'rights', 'headTeacher', 'counselor', 'collegeOfficer'];

// ==================== 路由框架 ====================
const routes = [];
function route(method, pattern, opts, handler) {
  if (typeof opts === 'function') {
    handler = opts;
    opts = {};
  }
  const keys = [];
  const regex = new RegExp(
    '^' +
      pattern.replace(/:[^/]+/g, (m) => {
        keys.push(m.slice(1));
        return '([^/]+)';
      }) +
      '$'
  );
  routes.push({ method, regex, keys, opts, handler });
}

function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  throw e;
}

// ==================== 多角色助手 ====================
// 账号的实际角色集合：优先 roles 数组（多角色），旧数据回退为 [role]
function rolesOf(u) {
  return Array.isArray(u.roles) && u.roles.length ? u.roles : (u.role ? [u.role] : []);
}
function hasRole(u, r) {
  return rolesOf(u).includes(r);
}
// 合并权限语义：任一角色授予即视为拥有
function hasAnyRole(u, list) {
  return rolesOf(u).some((r) => list.includes(r));
}
// 角色数组校验：无效角色 / 重复分配 / 空列表 均返回明确错误信息
function validateRoles(input) {
  if (!Array.isArray(input) || !input.length) return { error: '请至少选择一个角色' };
  const roles = [];
  for (const raw of input) {
    const r = String(raw || '').trim();
    if (!ROLE_NAMES[r]) return { error: `无效角色：${r || '(空)'}` };
    if (roles.includes(r)) return { error: `角色重复分配：${ROLE_NAMES[r]}` };
    roles.push(r);
  }
  return { roles };
}

// ==================== 无状态签名登录态（v2 token） ====================
// 背景：部署平台沙箱空闲时会回收/调度进程实例，内存态 tokens 表随实例丢失（或多实例内存不共享），
// 导致登录约 2 分钟无操作后被踢回登录页。改为 HMAC 签名的自包含 token：验签即可鉴权，
// 不依赖服务端内存与 tokens 表；密钥持久化于 data/secret.key，进程重启 / 多实例下登录态均有效。
const TOKEN_TTL_MS = 30 * 86400000; // 登录有效期 30 天

function signToken(userId) {
  const exp = Date.now() + TOKEN_TTL_MS;
  const payload = `v2.${userId}.${exp}`;
  const sig = crypto.createHmac('sha256', store.secret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyStatelessToken(t) {
  const parts = t.split('.');
  if (parts.length !== 4 || parts[0] !== 'v2') return null;
  const [, uidv, expStr, sig] = parts;
  const payload = `v2.${uidv}.${expStr}`;
  const expect = crypto.createHmac('sha256', store.secret()).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= Date.now()) return null;
  const u = store.db.users.find((x) => x.id === uidv);
  if (!u) return null;
  // 管理员重置密码后，重置前签发的旧登录态一并失效
  const issuedAt = exp - TOKEN_TTL_MS;
  if (u.pwdChangedAt && new Date(u.pwdChangedAt).getTime() > issuedAt) return null;
  return u;
}

function getAuthUser(req) {
  // 优先读取自定义头 X-Auth-Token（部署平台的网关会注入/覆盖 Authorization 头，导致本地 token 失效）；
  // Authorization 作为兜底，保证本地直连与旧客户端兼容。
  const candidates = [];
  const xt = String(req.headers['x-auth-token'] || '').trim();
  if (xt) candidates.push(xt);
  const m = String(req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/);
  if (m) candidates.push(m[1]);
  for (const t of candidates) {
    // v2 无状态签名 token：验签鉴权；旧随机 token：查 tokens 表（存量登录态兼容）
    let user = null;
    if (t.startsWith('v2.')) {
      user = verifyStatelessToken(t);
    } else {
      const tok = store.db.tokens[t];
      if (tok) user = store.db.users.find((u) => u.id === tok.userId);
    }
    if (user && user.enabled !== false) return user;
  }
  return null;
}

function sanitizeUser(u) {
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    role: u.role,
    roles: rolesOf(u),
    classes: u.classes || [],
    enabled: u.enabled !== false,
    mustChangePassword: u.mustChangePassword === true,
    createdAt: u.createdAt,
  };
}

async function handle(req, res, pathname, searchParams) {
  const query = Object.fromEntries(searchParams.entries());
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = pathname.match(r.regex);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    const user = getAuthUser(req);
    if (!r.opts.public && !user) return json(res, 401, { message: '未登录或登录已过期' });
    // 首次登录强制修改初始密码：除登录态查询 / 改密 / 登出外的一切接口暂不可用
    if (user && user.mustChangePassword && !['/api/auth/me', '/api/auth/password', '/api/auth/logout'].includes(pathname)) {
      return json(res, 403, { message: '首次登录请先修改初始密码', mustChangePassword: true });
    }
    if (r.opts.roles && (!user || !hasAnyRole(user, r.opts.roles))) return json(res, 403, { message: '没有权限执行此操作' });
    let body = {};
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      try {
        body = await readBody(req);
      } catch (e) {
        return json(res, 400, { message: e.message });
      }
    }
    try {
      return await r.handler({ req, res, user, params, query, body });
    } catch (e) {
      if (e.status) return json(res, e.status, { message: e.message });
      console.error(`[api] ${req.method} ${pathname}`, e);
      return json(res, 500, { message: '服务器内部错误' });
    }
  }
  json(res, 404, { message: '接口不存在' });
}

// ==================== 工具函数 ====================
/** 点名发起权限：管理员不限；纪律委员 / 权益部以账号管理中配置的"可点名班级"为准（未配置则无可点名班级） */
function canManageClass(user, className) {
  // 管理员与学院考勤负责老师为全院范围，可对任意班级点名（任一角色满足即可）
  if (hasAnyRole(user, ['admin', 'collegeOfficer'])) return true;
  const cls = user.classes || [];
  return cls.includes(className);
}
function sortPeriods(ps) {
  return [...ps].sort((a, b) => PERIODS.indexOf(a) - PERIODS.indexOf(b));
}
function sessionCounts(s) {
  const c = { 出勤: 0, 迟到: 0, 缺勤: 0, 请假: 0 };
  for (const it of s.items) if (c[it.status] != null) c[it.status]++;
  return c;
}
function sessionSummary(s) {
  return {
    id: s.id,
    className: s.className,
    date: s.date,
    periods: s.periods,
    courseName: s.courseName,
    teacher: s.teacher,
    counts: sessionCounts(s),
    total: s.items.length,
    createdBy: s.createdBy,
    createdById: s.createdById,
    createdAt: s.createdAt,
    updatedBy: s.updatedBy,
    updatedAt: s.updatedAt,
    confirmStatus: s.confirmStatus || 'pending',
    confirmedName: s.confirmedName || '',
    confirmedAt: s.confirmedAt || '',
    confirmToken: s.confirmToken || '',
  };
}

/** 假单与学生考勤条目是否指向同一学生 */
function studentMatch(lv, studentId, studentName) {
  if (lv.studentId) return lv.studentId === studentId;
  return lv.studentName === studentName;
}

/**
 * 假单导入的学生匹配（班级名称可能存在不一致表述，故不校验班级）：
 * 校验学号与姓名均存在于班级名单且指向同一名学生。
 */
// 学号规范化：去首尾与内部空白、全角数字/字母转半角，避免"看着一样其实不相等"的匹配失败
function normIdText(v) {
  return String(v ?? '')
    .replace(/\s+/g, '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
}

// 假单学生匹配（三级策略）：
// ① 学号精确匹配（原逻辑）；② 学号规范化匹配（去空格/全半角差异）；
// ③ 姓名+班级兜底匹配（请假系统导出的学号与名单不一致时仍可导入，并给出提示供核对）。
function matchLeaveStudent(sid, name, className) {
  if (!sid || !name) return { error: '学号与姓名为必填' };
  let bySid = store.db.students.filter((s) => s.studentId === sid);
  let idFormatDiff = false;
  if (!bySid.length) {
    const nSid = normIdText(sid);
    bySid = store.db.students.filter((s) => normIdText(s.studentId) === nSid);
    idFormatDiff = bySid.length > 0;
  }
  if (bySid.length) {
    const matched = bySid.find((s) => s.name === name);
    if (!matched) return { error: `学号 ${sid} 与姓名"${name}"不匹配（名单中该学号为"${bySid[0].name}"）` };
    if (idFormatDiff) return { stu: matched, notice: `学号格式差异已自动匹配：Excel 学号"${sid}" ↔ 名单学号"${matched.studentId}"（${matched.name}，${matched.className}），建议核对名单学号` };
    return { stu: matched };
  }
  // 兜底：按 姓名+班级 匹配（班级名称以名单为准，表述不一致时按仅姓名匹配）
  let cands = className ? store.db.students.filter((s) => s.name === name && s.className === className) : [];
  if (!cands.length) cands = store.db.students.filter((s) => s.name === name);
  if (cands.length === 1) {
    return { stu: cands[0], notice: `学号不一致已按姓名匹配：Excel 学号"${sid}" ↔ 名单学号"${cands[0].studentId}"（${cands[0].name}，${cands[0].className}），假单已按名单学号记录，请核对名单中学号是否正确` };
  }
  if (cands.length > 1) {
    return { error: `姓名"${name}"在名单中对应多个学号（${cands.map((s) => s.studentId).slice(0, 3).join('、')}…），且 Excel 学号 ${sid} 未匹配到名单，请先核对班级名单` };
  }
  // 诊断信息：帮助定位"明明在名单里却找不到"的真实原因
  const total = store.db.students.length;
  const sameName = store.db.students.filter((s) => s.name === name).slice(0, 3);
  const sample = store.db.students.slice(0, 2).map((s) => s.studentId).join('、');
  let hint = total ? `当前名单共 ${total} 人` : '当前班级名单为空，请先在「班级名单」中导入';
  if (sameName.length) hint += `；名单中"${name}"的学号为 ${sameName.map((s) => s.studentId).join('、')}`;
  else if (total) hint += `；名单学号样例：${sample}…，请确认名单已导入且学号与请假系统一致`;
  return { error: `学号 ${sid} 未在班级名单中找到（${hint}）` };
}

/** 假单的开始 / 结束日期（兼容旧字段 date） */
function leaveRange(lv) {
  const s = lv.startDate || lv.date;
  const e = lv.endDate || lv.date || s;
  return { s, e };
}

/** 假单在某个日期生效的时间段；该日期不在请假范围内返回 null。
 *  跨天请假为连续时间段：首日自开始时间起、中间日全天、末日至结束时间止。 */
function leaveSpanOnDate(lv, date) {
  const { s, e } = leaveRange(lv);
  if (!s || !e || date < s || date > e) return null;
  const from = date === s ? lv.timeStart || '00:00' : '00:00';
  const to = date === e ? lv.timeEnd || '23:59' : '23:59';
  return from < to ? { from, to } : null;
}

function addDays(dateStr, n) {
  return fmtDate(new Date(new Date(`${dateStr}T00:00:00`).getTime() + n * 86400000));
}

/**
 * 计算假单在某个日期覆盖的节次（连续语义）：
 * - 新数据（有起止时间）：当日生效时段需完整包含节次上课时间
 * - 旧数据（仅节次列表）：直接按指定节次
 */
function periodsCoveredByLeaveOn(lv, date, cfg) {
  const { s, e } = leaveRange(lv);
  if (!s || !e || date < s || date > e) return [];
  if (!(lv.timeStart && lv.timeEnd)) return (lv.periods || []).filter((p) => PERIODS.includes(p));
  const span = leaveSpanOnDate(lv, date);
  if (!span) return [];
  return PERIODS.filter((p) => {
    const t = cfg[p];
    return !!t && span.from <= t.start && span.to >= t.end;
  });
}

/** 假单连续请假时段的覆盖描述（供列表与处理结果展示） */
function leaveCoverageDesc(lv, cfg) {
  const { s, e } = leaveRange(lv);
  if (!s || !e) return { text: '', union: [] };
  const union = new Set();
  const segs = [];
  const first = periodsCoveredByLeaveOn(lv, s, cfg);
  first.forEach((p) => union.add(p));
  segs.push(`${s} ${lv.timeStart || '00:00'} 起覆盖：${first.length ? first.join('、') : '无'}`);
  if (e !== s) {
    const mid = addDays(s, 1);
    if (mid < e) {
      const cov = periodsCoveredByLeaveOn(lv, mid, cfg);
      cov.forEach((p) => union.add(p));
      // 中间日为连续区间（s+1 ~ e-1 每一天均全天覆盖），文案列出完整范围避免「只覆盖一天」的误解
      const midEnd = addDays(e, -1);
      const midDesc = midEnd > mid ? `${mid} ~ ${midEnd}` : mid;
      segs.push(`中间日（${midDesc}）每天全天覆盖：${cov.length ? cov.join('、') : '无'}`);
    }
    const last = periodsCoveredByLeaveOn(lv, e, cfg);
    last.forEach((p) => union.add(p));
    segs.push(`${e} 至 ${lv.timeEnd || '23:59'} 覆盖：${last.length ? last.join('、') : '无'}`);
  }
  return { text: segs.join('；'), union: PERIODS.filter((p) => union.has(p)) };
}

/**
 * 双向考勤对账（针对某学生某天）：
 * - 假单覆盖的节次：缺勤 → 请假（备注假别与事由），已是请假则补备注确认
 * - 无假单覆盖的节次：请假 → 缺勤（假单时间段未覆盖，改判缺勤）
 * 同时回写该生当天相关假单的覆盖节次、生效节次、状态与说明。
 */
function reconcileStudentDate(className, date, studentId, studentName) {
  // 修改81：日志捕获窗口内，先留存涉及会话的变更前快照（保留首帧，重复触碰不覆盖）
  if (attLogCapture) {
    for (const s of store.db.attendance) {
      if (s.date === date && s.className === className && !attLogCapture.has(s.id)) {
        attLogCapture.set(s.id, s.items.map((it) => ({ ...it })));
      }
    }
  }
  const leaves = store.db.leaves.filter((lv) => {
    const { s, e } = leaveRange(lv);
    return s && e && date >= s && date <= e && lv.className === className && studentMatch(lv, studentId, studentName);
  });
  const cfg = store.getPeriodTimes();
  // 节次 → 生效假单（多张假单覆盖同一节次时，按导入先后取先到者）
  const coveredBy = new Map();
  for (const lv of leaves) {
    lv.coveredPeriods = leaveCoverageDesc(lv, cfg).union;
    for (const p of periodsCoveredByLeaveOn(lv, date, cfg)) if (!coveredBy.has(p)) coveredBy.set(p, lv);
  }
  const justified = []; // { sessionId, period, leave, kind: applied | confirmed }
  const reverted = []; // { sessionId, period }
  const changedSessions = new Set();
  for (const s of store.db.attendance) {
    if (s.date !== date || s.className !== className) continue;
    for (const it of s.items) {
      const isTarget = studentId ? it.studentId === studentId : it.name === studentName;
      if (!isTarget) continue;
      // 一条点名记录可能含多个节次：任一节次被假单覆盖 → 整条按"请假"处理；全部未覆盖 → "请假"改判"缺勤"
      const coveredHere = s.periods.filter((p) => coveredBy.has(p));
      const partial = coveredHere.length > 0 && coveredHere.length < s.periods.length;
      if (coveredHere.length) {
        const lv = coveredBy.get(coveredHere[0]);
        const suffix = partial ? `（覆盖${coveredHere.join('/')}，未覆盖节次建议单独点名）` : '';
        if (it.status === '缺勤') {
          it.status = '请假';
          it.note = `假单·${lv.type}：${lv.reason}${suffix}`;
          for (const p of coveredHere) justified.push({ sessionId: s.id, period: p, leave: coveredBy.get(p), kind: 'applied' });
          changedSessions.add(s.id);
        } else if (it.status === '请假') {
          if (!/假单·/.test(it.note || '')) {
            it.note = `假单·${lv.type}：${lv.reason}${suffix}`;
            changedSessions.add(s.id);
          }
          for (const p of coveredHere) justified.push({ sessionId: s.id, period: p, leave: coveredBy.get(p), kind: 'confirmed' });
        }
      } else if (it.status === '请假') {
        // 诊断细化：说明「为什么没有假单覆盖」，避免老师/管理员只看到笼统提示无从排查
        let why;
        if (!leaves.length) {
          why = '该生当天无假单记录（请确认假单已导入且学号/班级/日期正确）';
        } else if (!coveredBy.size) {
          const spanDesc = leaves
            .map((lv) => {
              const { s: ls, e: le } = leaveRange(lv);
              const d = ls === le ? ls : `${ls}~${le}`;
              return `${d}${lv.timeStart && lv.timeEnd ? ` ${lv.timeStart}~${lv.timeEnd}` : `（节次：${(lv.periods || []).join('/') || '未指定'}）`}`;
            })
            .join('；');
          const t = cfg[s.periods[0]];
          why = `该生假单时段（${spanDesc}）未完整覆盖本节次上课时间${t ? `（${t.start}~${t.end}）` : ''}`;
        } else {
          why = `假单覆盖节次为${[...coveredBy.keys()].join('/')}，与本记录节次（${s.periods.join('/')}）不相交`;
        }
        it.status = '缺勤';
        it.note = `${s.periods.join('/')}由请假改判缺勤：${why}`.slice(0, 200);
        reverted.push({ sessionId: s.id, period: s.periods[0] });
        changedSessions.add(s.id);
      }
    }
  }
  // 回写每张假单的生效状态
  for (const lv of leaves) {
    const eff = justified.filter((j) => j.leave === lv).map((j) => j.period);
    const uniqEff = [...new Set(eff)];
    lv.effectivePeriods = uniqEff;
    lv.appliedCount = justified.filter((j) => j.leave === lv && j.kind === 'applied').length;
    lv.appliedTo = justified
      .filter((j) => j.leave === lv)
      .map((j) => ({ sessionId: j.sessionId, studentId: studentId || '', period: j.period }));
    const { s, e } = leaveRange(lv);
    const rangeDesc = s === e ? s : `${s} 至 ${e}`;
    const covDesc = leaveCoverageDesc(lv, cfg).text;
    const timeDesc = lv.timeStart
      ? (s === e ? ` ${lv.timeStart}~${lv.timeEnd}` : `（${lv.timeStart} 起连续至结束日 ${lv.timeEnd}）`)
      : '';
    if (uniqEff.length) {
      lv.status = '已生效';
      lv.remark = `连续请假 ${rangeDesc}${timeDesc}；${covDesc}；已生效节次：${uniqEff.join('、')}`;
    } else if (lv.coveredPeriods.length) {
      lv.status = '待生效';
      lv.remark =
        `连续请假 ${rangeDesc}${timeDesc}；${covDesc}；对应节次暂无考勤记录，点名提交后可"重新应用"` +
        (reverted.length ? `。其未覆盖节次的请假已改判缺勤` : '');
    } else {
      lv.status = '待生效';
      lv.remark =
        `连续请假 ${rangeDesc}${timeDesc}未覆盖任何节次的上课时间基准，假单无法生效` +
        (reverted.length ? `。其未覆盖节次的请假已改判缺勤` : '');
    }
  }
  for (const sid of changedSessions) {
    const s = store.db.attendance.find((x) => x.id === sid);
    s.updatedBy = '假单自动校正';
    s.updatedAt = nowISO();
    // 任课老师只需在下课后签字确认一次；假单对账自动修正考勤状态后，确认状态保持有效，无需重新确认。
  }
  if (changedSessions.size) store.save('attendance');
  if (leaves.length) store.save('leaves');
  return { applied: justified.filter((j) => j.kind === 'applied').length, reverted: reverted.length };
}

/** 跨天假单全日期对账：对 startDate..endDate 每一天逐一双向对账。
 *  修复：此前只对 startDate 单日对账——点名提交早于假单导入时，中间日（如 09-28）的缺勤永远得不到改判，
 *  「重新应用」也只刷第一天导致无效。
 *  边界：跨多天逐日对账；起止日闭区间（date>=s && date<=e）；
 *  同一学生多张假单由 reconcileStudentDate 内部 coveredBy 先到优先处理。 */
function reconcileLeaveAllDays(lv) {
  const { s, e } = leaveRange(lv);
  let applied = 0;
  let reverted = 0;
  if (s && e) {
    for (let d = s; d <= e; d = addDays(d, 1)) {
      const r = reconcileStudentDate(lv.className, d, lv.studentId, lv.studentName);
      applied += r.applied;
      reverted += r.reverted;
    }
  }
  // 状态聚合：逐天调用会互相覆盖假单状态（末天无改判会重写回待生效），任一天成功改判即视为已生效
  if (applied > 0 && lv.status !== '已生效') {
    lv.status = '已生效';
    lv.appliedCount = (lv.appliedCount || 0) + applied;
    lv.remark = `${lv.remark || ''}；跨天对账共改判 ${applied} 条考勤`.slice(0, 200);
  }
  return { applied, reverted };
}

/** 点名保存后即时套用：对该班当天已有假单的学生逐一双向对账 */
/** 点名保存 / 修改后对会话内全部学生执行双向校验：
 *  - 被已通过假单覆盖的缺勤 → 请假
 *  - 未被假单覆盖的请假（含完全无假单记录的学生）→ 缺勤 */
function reconcileLeavesForSession(session) {
  const studentsIn = new Map(session.items.map((it) => [it.studentId, it.name]));
  let touched = false;
  for (const [sid, sname] of studentsIn) {
    reconcileStudentDate(session.className, session.date, sid, sname);
    touched = true;
  }
  return touched;
}

// ==================== 修改81：考勤修改日志 ====================
/**
 * 时间线数据源：点名记录 新增 / 人工修改 / 任课老师签字确认 / 假单对账改判 / 异议改判 时写入。
 * 结构：{ id, sessionId, action, at, operator, changes?, summary?, via? }
 *   - action：create(发起点名) | update(人工修改) | system(假单自动校正) | confirm(任课老师签字)
 *   - operator：{ id, username, name, roles[], system?, external? } 操作人快照（账号删除后日志仍可读）
 *   - changes：[{ studentId, name, field: status|note|confirmStatus, before, after }] 字段级变更
 *   - summary：{ total, counts }（仅 create，初始四态概况）
 *   - via：附加来源说明（如「异议改判」），可选
 * 只记真实 diff、不存整表快照以控制集合体积；单条记录日志上限 ATT_LOG_LIMIT 条。
 */
const ATT_LOG_LIMIT = 500;

/** 操作人快照（姓名 + 账号 + 当时角色集合） */
function attendanceLogOperator(user) {
  return { id: user.id, username: user.username, name: user.name, roles: rolesOf(user) };
}
/** 系统操作人（假单对账自动改判，非人工操作） */
const ATT_LOG_SYSTEM_OPERATOR = { id: '', username: '', name: '假单自动校正', roles: [], system: true };

/** 逐字段 diff 两组考勤条目（按 studentId 对齐），返回变更明细 */
function diffAttendanceItems(before, after) {
  const prev = new Map((before || []).map((it) => [String(it.studentId), it]));
  const changes = [];
  for (const it of after || []) {
    const b = prev.get(String(it.studentId));
    if (!b) continue; // 条目集合仅在创建时生成，更新场景前后一一对应
    if (b.status !== it.status) {
      changes.push({ studentId: it.studentId, name: it.name, field: 'status', before: b.status, after: it.status });
    }
    if (String(b.note || '') !== String(it.note || '')) {
      changes.push({ studentId: it.studentId, name: it.name, field: 'note', before: String(b.note || ''), after: String(it.note || '') });
    }
  }
  return changes;
}

/** 追加一条日志；同一记录超上限时裁掉最旧（调用方随后统一 save('attendanceLogs')） */
function appendAttendanceLog(entry) {
  const logs = store.db.attendanceLogs;
  logs.push(entry);
  const same = logs.filter((l) => l.sessionId === entry.sessionId);
  if (same.length > ATT_LOG_LIMIT) {
    const drop = new Set(same.slice(0, same.length - ATT_LOG_LIMIT).map((l) => l.id));
    store.db.attendanceLogs = logs.filter((l) => !drop.has(l.id));
  }
}

/** 点名记录被删除（单删 / 批删）时清理其关联日志 */
function pruneAttendanceLogs(sessionIds) {
  const drop = new Set((sessionIds || []).filter(Boolean));
  if (!drop.size) return;
  const before = store.db.attendanceLogs.length;
  store.db.attendanceLogs = store.db.attendanceLogs.filter((l) => !drop.has(l.sessionId));
  if (store.db.attendanceLogs.length !== before) store.save('attendanceLogs');
}

/**
 * 假单对账改判的日志捕获窗口。reconcileStudentDate 被点名保存 / 假单导入 / 应用 / 删除等
 * 多个流程复用，且逐学生、逐日多次触碰同一记录——直接在其内部写日志会把一次保存拆成 N 条碎片。
 * 约定：begin 留存各会话「首帧」快照（重复触碰不覆盖），end 统一 diff，
 * 每个发生变更的会话只落一条 system 日志。begin/end 必须成对紧包 reconcile 调用，
 * 窗口内不得有 fail() 抛出路径（现有调用点均已满足）。
 */
let attLogCapture = null;
function beginAttendanceLogCapture() {
  attLogCapture = new Map();
}
function endAttendanceLogCapture() {
  const cap = attLogCapture;
  attLogCapture = null;
  if (!cap || !cap.size) return;
  let logged = false;
  for (const [sid, before] of cap) {
    const s = store.db.attendance.find((x) => x.id === sid);
    if (!s) continue;
    const changes = diffAttendanceItems(before, s.items);
    if (!changes.length) continue;
    appendAttendanceLog({ id: uid('alog'), sessionId: sid, action: 'system', at: nowISO(), operator: ATT_LOG_SYSTEM_OPERATOR, changes });
    logged = true;
  }
  if (logged) store.save('attendanceLogs');
}

/** 修改人账号脱敏（只读角色查看日志时）：保留前 4 后 2，中间打星；
 *  过短账号（<8 位）按「前4+后2」会泄露全部或大部分字符（如 admin），仅留首字符 */
function maskAccount(u) {
  const s = String(u || '');
  if (!s) return '';
  if (s.length < 8) return s[0] + '***';
  return s.slice(0, 4) + '***' + s.slice(-2);
}

// ==================== 认证 ====================
route('POST', '/api/auth/login', { public: true }, async ({ res, body }) => {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) fail(400, '请输入账号和密码');
  const user = store.db.users.find((u) => u.username === username);
  if (!user || !verifyPassword(password, user.passwordHash)) fail(400, '账号或密码错误');
  if (user.enabled === false) fail(403, '该账号已被停用，请联系管理员');
  // 无状态签名 token：不再写入 tokens 表（存量旧 token 仍走表兼容）
  const token = signToken(user.id);
  json(res, 200, { token, user: sanitizeUser(user) });
});

route('POST', '/api/auth/logout', { public: true }, async ({ req, res }) => {
  const m = String(req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/);
  if (m && store.db.tokens[m[1]]) {
    delete store.db.tokens[m[1]];
    store.save('tokens');
  }
  json(res, 200, { ok: true });
});

route('GET', '/api/auth/me', {}, async ({ res, user }) => json(res, 200, { user: sanitizeUser(user) }));

route('PUT', '/api/auth/password', {}, async ({ res, user, body }) => {
  const oldPwd = String(body.oldPassword || '');
  const newPwd = String(body.newPassword || '');
  if (!verifyPassword(oldPwd, user.passwordHash)) fail(400, '原密码不正确');
  if (newPwd.length < 6) fail(400, '新密码长度不能少于 6 位');
  if (verifyPassword(newPwd, user.passwordHash)) fail(400, '新密码不能与当前密码相同');
  user.passwordHash = hashPassword(newPwd);
  if (user.mustChangePassword) user.mustChangePassword = false; // 完成首次改密，解除接口限制
  store.save('users');
  json(res, 200, { ok: true, mustChangePassword: false });
});

// ==================== 元数据 / 模板 ====================
route('GET', '/api/meta/classes', {}, async ({ res, user }) => {
  // 纪律委员、班主任、辅导员仅返回其账号关联班级（含对应年级）；管理员与权益部返回全部
  // 多角色合并：拥有学院级角色时按全院范围返回；仅纪律委员时返回其班级
  const isDisciplineOnly = hasRole(user, 'discipline') && !hasAnyRole(user, ['admin', 'rights', 'collegeOfficer']);
  const scope = teacherScope(user) || (isDisciplineOnly ? (user.classes || []).filter(Boolean) : null);
  const students = scope && scope.length ? store.db.students.filter((s) => scope.includes(s.className)) : store.db.students;
  const map = {};
  const gradeOf = {}; // 修改58：班级 → 年级（供「按年级分级多选」使用，纯附加字段，不影响既有消费方）
  for (const s of students) {
    map[s.className] = (map[s.className] || 0) + 1;
    if (s.grade && !gradeOf[s.className]) gradeOf[s.className] = s.grade;
  }
  // 修改72：classes 权威源 → 补年级 / 专业 / 三岗位 / 登记状态；未登记班级由 students 兜底生成虚拟项。
  // 纯附加字段，既有消费方（级联、stats、点名）行为不变。
  const keyOf = (n) => normClassName(n).toLowerCase();
  const regIndex = new Map();
  for (const c of store.db.classes || []) if (c && c.name) regIndex.set(keyOf(c.name), c);
  const names = [...new Set([...Object.keys(map), ...[...regIndex.values()].map((c) => normClassName(c.name))])].filter(Boolean);
  const classes = names
    .map((name) => {
      const reg = regIndex.get(keyOf(name));
      const count = map[name] || 0;
      const grade = (reg && reg.grade) || gradeOf[name] || '';
      return {
        name,
        count,
        grade,
        // 附加字段（新增，不影响既有消费方）
        major: (reg && reg.major) || '',
        registered: !!reg,
        status: reg ? reg.status || 'active' : 'unregistered',
        headTeacher: reg ? postNameOf(reg.headTeacher) : '',
        counselor: reg ? postNameOf(reg.counselor) : '',
        disciplineMember: reg ? postNameOf(reg.disciplineMember) : '',
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  const grades = [...new Set(classes.map((c) => c.grade).filter(Boolean))].sort();
  json(res, 200, { classes, grades });
});

const TEMPLATES = {
  // 修改72：纪律委员 / 辅导员 / 班主任三列已从模板移除 —— 班级岗位统一在「班级管理」
  // 按班级维度维护，学生名单只负责「谁在哪个班」。
  roster: {
    filename: '班级名单导入模板.xlsx',
    ascii: 'roster_template.xlsx',
    headers: ['年级', '班级', '姓名', '学号'],
    rows: [
      ['2023级', '软件2301班', '王雨轩', '202301001'],
      ['2023级', '软件2301班', '刘诗琪', '202301002'],
      ['2023级', '软件2302班', '杨梦琪', '202302001'],
    ],
  },
  leaves: {
    filename: '假单导入模板.xlsx',
    ascii: 'leave_template.xlsx',
    headers: ['班级', '姓名', '学号', '请假开始日期', '请假开始时间', '请假结束日期', '请假结束时间', '假别', '事由'],
    rows: [
      ['软件2301班', '王雨轩', '202301001', '2026/9/24', '08:00', '2026/9/26', '11:40', '病假', '感冒发烧，校医院就诊'],
      ['软件2302班', '杨梦琪', '202302001', '2026/9/24', '14:00', '2026/9/27', '15:40', '公假', '代表学院参加运动会'],
    ],
  },
  // ==================== 修改34：账号管理批量导入模板 ====================
  accounts: {
    filename: '系统账号批量导入模板.xlsx',
    ascii: 'accounts_template.xlsx',
    headers: ['登录账号', '姓名', '角色', '学号或工号', '初始密码', '可点名班级'],
    rows: [
      ['202301001', '王雨轩', '纪律委员', '202301001', '', '软件2301班'],
      ['202301002', '刘诗琪', '权益部', '202301002', '', '软件2301班'],
      ['T2025001', '赵国栋', '班主任', 'T2025001', '', '软件2301班'],
      ['T2025002', '王海燕', '辅导员', 'T2025002', '', '软件2301班'],
      ['admin02', '李校长', '管理员', '', '', ''],
    ],
  },
  staffs: {
    filename: '教职工名单导入模板.xlsx',
    ascii: 'staffs_template.xlsx',
    headers: ['工号', '姓名', '岗位', '所带班级'],
    rows: [
      ['T2025001', '赵国栋', '班主任', '软件2301班'],
      ['T2025002', '王海燕', '辅导员', '软件2301班、软件2302班'],
    ],
  },
  // ==================== 修改72：班级管理批量导入模板（班级维度） ====================
  classes: {
    filename: '班级管理导入模板.xlsx',
    ascii: 'classes_template.xlsx',
    headers: ['班级', '年级', '专业', '班主任', '班主任工号', '辅导员', '辅导员工号', '纪律委员', '纪律委员学号'],
    rows: [
      ['软件2301班', '2023级', '软件工程', '赵国栋', 'T2025001', '王海燕', 'T2025002', '刘明宇', '202301001'],
      ['软件2302班', '2023级', '软件工程', '赵国栋', 'T2025001', '王海燕', 'T2025002', '陈思远', '202302001'],
    ],
  },
};

route('GET', '/api/templates/:name', {}, async ({ res, params }) => {
  const t = TEMPLATES[params.name];
  if (!t) fail(404, '模板不存在');
  const buf = xlsx.buildXlsx(t.headers, t.rows);
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${t.ascii}"; filename*=UTF-8''${encodeURIComponent(t.filename)}`,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
});

// ==================== Excel 通用解析 / 生成 ====================
route('POST', '/api/xlsx/parse', {}, async ({ res, body }) => {
  let buf;
  try {
    buf = Buffer.from(String(body.dataBase64 || ''), 'base64');
  } catch {
    fail(400, '文件数据无效');
  }
  if (!buf || buf.length < 100) fail(400, '文件内容为空或不是有效的 xlsx 文件');
  try {
    const rows = xlsx.rowsToObjects(xlsx.parseXlsxRows(buf));
    if (!rows.length) fail(400, 'Excel 中没有有效数据（首个工作表需包含表头和数据行）');
    json(res, 200, { rows });
  } catch (e) {
    fail(400, `Excel 解析失败：${e.message}`);
  }
});

route('POST', '/api/xlsx/build', { roles: VIEW_ROLES }, async ({ res, body }) => {
  const headers = Array.isArray(body.headers) ? body.headers : [];
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!headers.length) fail(400, '导出表头不能为空');
  const buf = xlsx.buildXlsx(headers, rows);
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(String(body.filename || '导出数据.xlsx'))}`,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
});

// ==================== 账号管理（管理员） ====================
route('GET', '/api/accounts', { roles: ['admin', 'collegeOfficer'] }, async ({ res, query }) => {
  let list = store.db.users.map(sanitizeUser);
  // 角色筛选：匹配账号的任一角色（多角色账号在被筛角色下也会出现）
  if (query.role) list = list.filter((u) => (u.roles || [u.role]).includes(query.role));
  if (query.q) {
    const q = query.q.trim();
    list = list.filter((u) => u.username.includes(q) || u.name.includes(q));
  }
  list.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  json(res, 200, paginate(list, query.page, query.pageSize));
});

route('POST', '/api/accounts', { roles: ['admin', 'collegeOfficer'] }, async ({ res, user, body }) => {
  const username = String(body.username || '').trim();
  const name = String(body.name || '').trim();
  const password = String(body.password || '');
  if (!/^[a-zA-Z0-9_]{2,20}$/.test(username)) fail(400, '账号需为 2-20 位字母、数字或下划线');
  if (!name) fail(400, '请输入姓名');
  if (password.length < 6) fail(400, '初始密码长度不能少于 6 位');
  // 角色解析：支持 roles 数组（多角色，首个为主角色）或单个 role 字段（兼容旧调用）
  let reqRoles;
  if (body.roles !== undefined) {
    const validation = validateRoles(body.roles);
    if (validation.error) fail(400, validation.error);
    reqRoles = validation.roles;
  } else {
    const role = String(body.role || '');
    if (!ROLE_NAMES[role]) fail(400, '角色不正确');
    reqRoles = [role];
  }
  // 防提权：学院考勤负责老师只能创建非特权角色账号（管理员 / 学院考勤负责老师仅管理员可创建）
  if (hasRole(user, 'collegeOfficer') && reqRoles.some((r) => PRIVILEGED_ROLES.includes(r))) fail(403, '无权创建管理员或学院考勤负责老师账号');
  if (store.db.users.some((u) => u.username === username)) fail(400, `账号 "${username}" 已存在`);
  const classes = Array.isArray(body.classes) ? body.classes.map(String).filter(Boolean) : [];
  const u = {
    id: uid('u'),
    username,
    name,
    role: reqRoles[0],
    roles: reqRoles,
    classes: reqRoles.some((r) => r === 'discipline' || r === 'rights') ? classes : [],
    enabled: true,
    mustChangePassword: true, // 修改34：与 generate/student、generate/staff 一致，避免页面文案与实际行为不符
    passwordHash: hashPassword(password),
    createdAt: nowISO(),
    createdBy: user.name,
  };
  store.db.users.push(u);
  store.save('users');
  dataOplog(user, '创建账号', `${username}（${name}），角色：${reqRoles.map((r) => ROLE_NAMES[r]).join('、')}`);
  json(res, 200, { user: sanitizeUser(u) });
});

// ==================== 修改34：账号 / 教职工名单批量导入 ====================
/** 角色中文名与英文 key 双向容错；支持多角色（顿号/逗号/斜杠/空格分隔），取首个为主角色 */
const ROLE_ALIASES = {
  管理员: 'admin', admin: 'admin',
  学院考勤负责老师: 'collegeOfficer', 学院考勤负责人: 'collegeOfficer', collegeofficer: 'collegeOfficer',
  权益部: 'rights', 权益部委员: 'rights', rights: 'rights',
  纪律委员: 'discipline', 纪律部: 'discipline', discipline: 'discipline',
  班主任: 'headTeacher', headteacher: 'headTeacher',
  辅导员: 'counselor', counselor: 'counselor',
};
function parseRoleCell(raw) {
  const parts = String(raw || '').split(/[、，,；;\/|\s]+/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return { error: '角色不能为空' };
  const roles = [];
  for (const p of parts) {
    const key = ROLE_ALIASES[p] || (ROLE_NAMES[p] ? p : '');
    if (!key) return { error: `无效角色：${p}（可用：纪律委员 / 权益部 / 班主任 / 辅导员 / 管理员 / 学院考勤负责老师）` };
    if (!roles.includes(key)) roles.push(key);
  }
  return { roles };
}
/** 单元格取值（支持多别名；含全角空格/零宽字符清理） */
function cellOf(row, ...names) {
  for (const n of names) {
    if (row[n] !== undefined && row[n] !== null && String(row[n]).trim() !== '') {
      return String(row[n]).replace(/[\s\u3000\uFEFF]/g, '').trim();
    }
  }
  return '';
}
/** 多值单元格 → 去重数组（顿号/逗号/分号/斜杠/空格分隔） */
function cellList(raw) {
  return [...new Set(String(raw || '').split(/[、，,；;\/|\s]+/).map((s) => s.trim()).filter(Boolean))];
}
// ==================== 修改72：班级管理（classes 权威源） ====================
// 背景：班级此前不是独立实体，一律从 students 派生，且班主任 / 辅导员 / 纪律委员三岗位
// 逐学生冗余在 students 上（改一次辅导员要改 12 次）。改造后 classes 表为权威源，
// students 上三字段降为「只读镜像」，由班级变更自动回写。
// 兼容策略：classes 优先 + students 兜底（并集），不做硬切换，保证任何时刻可回滚。
const CLASS_POST_FIELDS = [
  { key: 'headTeacher', studentField: 'classTeacher', label: '班主任' },
  { key: 'counselor', studentField: 'counselor', label: '辅导员' },
  { key: 'disciplineMember', studentField: 'disciplineMember', label: '纪律委员' },
];
// 修改73：学生记录上的岗位字段 → 中文标签（导入提示 / 变更明细用）
const POST_LABEL = { classTeacher: '班主任', counselor: '辅导员', disciplineMember: '纪律委员' };

/** 班级名归一：去全角/半角空格与零宽字符（防止「软件2301班 」与「软件2301班」裂成两个班） */
function normClassName(v) {
  return String(v || '').replace(/[\s\u3000\uFEFF]/g, '').trim();
}
/** 按班级名取班级管理记录（忽略大小写与空白） */
function classRecordOf(name) {
  const key = normClassName(name).toLowerCase();
  if (!key) return null;
  return (store.db.classes || []).find((c) => normClassName(c.name).toLowerCase() === key) || null;
}
/** 岗位展示名：name 优先；缺失时用 staffId 查教职工表、用 studentId 查学生表兜底 */
function postNameOf(p) {
  if (!p) return '';
  if (p.name) return String(p.name).trim();
  if (p.staffId) {
    const st = (store.db.staffs || []).find((s) => s.staffId === p.staffId);
    if (st) return st.name;
  }
  if (p.studentId) {
    const s = store.db.students.find((x) => x.studentId === p.studentId);
    if (s) return s.name;
  }
  return '';
}
/** 取班级的三岗位（权威源）；班级未登记时返回 null（调用方各自兜底） */
function classPostsOf(className) {
  const c = classRecordOf(className);
  if (!c) return null;
  const out = {};
  for (const f of CLASS_POST_FIELDS) out[f.studentField] = postNameOf(c[f.key]);
  return out;
}
/** 把班级权威岗位写回学生记录的只读镜像。仅在班级有值时覆盖，绝不把已有历史值清空。 */
function applyClassPosts(s) {
  const p = classPostsOf(s.className);
  if (!p) return false;
  let changed = false;
  for (const f of CLASS_POST_FIELDS) {
    const v = p[f.studentField] || '';
    if (v && (s[f.studentField] || '') !== v) {
      s[f.studentField] = v;
      changed = true;
    }
  }
  return changed;
}
/** 已登记班级名 ∪ 学生表班级名（兜底），排序同原口径 */
function classUnionNames() {
  const set = new Set();
  for (const c of store.db.classes || []) if (c && normClassName(c.name)) set.add(normClassName(c.name));
  for (const s of store.db.students) if (s && s.className) set.add(String(s.className).trim());
  return [...set].filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh'));
}
// 修改73：班级准入（写入前校验）—— 班级管理是班级信息的唯一权威源。
// 旧行为：学生名单导入 / 单条新增遇到未登记班级时自动建档（标记「待补信息」），
// 结果是名单里可以出现「班级管理中并不存在」的班级，两处口径分裂、无法治理。
// 新规则：一律拒绝未登记班级 —— 需先到「班级管理」建档，再导入名单。
const CLASS_MISMATCH_MSG = '因为班级名称同班级管理中已设置的班级信息不一致，请检查';
/** 班级准入校验。返回 { ok, name, rec, reason }：
 *  - ok=true：name 为班级管理中的权威班级名（空格 / 大小写差异已消除，可直接写库）
 *  - ok=false：reason 为面向用户的明确原因（携带班级名，可定位到具体行 / 班级） */
function checkClassRegistered(rawName) {
  const nm = normClassName(rawName);
  if (!nm) return { ok: false, name: '', reason: '班级不能为空' };
  const rec = classRecordOf(nm);
  if (!rec) return { ok: false, name: nm, reason: `${CLASS_MISMATCH_MSG}（表中班级「${nm}」）` };
  return { ok: true, name: normClassName(rec.name), rec };
}

/** 修改35：班级名单匹配。判定条件 = trim 后与班级名单中的 className 完全一致（不区分大小写）。
 *  修改72：已知班级 = 已登记班级 ∪ 学生表班级（班级管理新建的班级也能被教职工导入匹配到）。
 *  返回 { matched, missing } —— matched 可安全写入，missing 需跳过/留空。
 *  班级名单为空（尚未导入名单）时全部算 missing，避免写入脏班级名。 */
function matchClasses(rawList) {
  const list = Array.isArray(rawList) ? rawList.filter(Boolean) : [];
  const known = new Set([
    ...store.db.students.map((s) => String(s.className || '').trim().toLowerCase()),
    ...(store.db.classes || []).map((c) => normClassName(c.name).toLowerCase()),
  ].filter(Boolean));
  const matched = [];
  const missing = [];
  for (const c of list) {
    if (known.has(String(c).trim().toLowerCase())) matched.push(c);
    else missing.push(c);
  }
  return { matched, missing };
}
/** 修改35：判定学号是否存在于班级名单（用于纪律委员 / 权益部账号准入） */
function studentIdExists(studentId) {
  const sid = String(studentId || '').trim().toLowerCase();
  if (!sid) return false;
  return store.db.students.some((s) => String(s.studentId || '').trim().toLowerCase() === sid);
}
/** 批量初始密码规则（修改34，用户口径）：
 *  - 学生角色（纪律委员 / 权益部）：Hzpt@ + 账号后六位（不足六位取整串）
 *  - 教职工角色（班主任 / 辅导员）：Hzpt@ + 完整工号
 *  - 特权角色：Hzpt@ + 账号后六位 */
function derivePassword(role, username) {
  if (role === 'headTeacher' || role === 'counselor') return `Hzpt@${username}`;
  return `Hzpt@${username.slice(-6)}`;
}

route('POST', '/api/accounts/import', { roles: ['admin', 'collegeOfficer'] }, async ({ req, res, user, body }) => {
  if (!rateLimit(`acc-import:${clientIp(req)}`, 20, 60000)) fail(429, '导入过于频繁，请稍后再试');
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) fail(400, '没有可导入的数据');
  // 表头硬性校验：姓名 + 角色 + （登录账号 或 学号或工号）至少要能定位
  // 注意：局部变量不能命名 hasRole —— 会遮蔽同文件 67 行的 hasRole() 函数
  const keys = new Set(rows.flatMap((r) => Object.keys(r || {})));
  const hasNameCol = [...keys].some((k) => ['姓名', '名字', 'name'].includes(k));
  const hasRoleCol = [...keys].some((k) => ['角色', '账号角色', '权限', 'role'].includes(k));
  const hasIdCol = [...keys].some((k) => ['登录账号', '账号', '用户名', '学号或工号', '学号', '工号', '编号'].includes(k));
  if (!hasNameCol) fail(400, '未找到"姓名"列，请下载导入模板后按模板表头填写');
  if (!hasRoleCol) fail(400, '未找到"角色"列，请下载导入模板后按模板表头填写');
  if (!hasIdCol) fail(400, '未找到"登录账号"或"学号或工号"列，无法确定账号');

  const errors = [];       // 未处理（校验失败）
  const notices = [];      // 已成功但需提示
  const created = [];      // 成功创建的账号（含明文初始密码，仅用于回传给管理员导出）
  const seen = new Set();  // 批内自去重
  let imported = 0, duplicates = 0;
  const STUDENT_ROLES = ['discipline', 'rights'];

  rows.forEach((r, idx) => {
    const rowNo = idx + 2; // 模板首行为表头，数据从第 2 行开始
    const name = cellOf(r, '姓名', '名字', 'name');
    const roleRaw = cellOf(r, '角色', '账号角色', '权限', 'role');
    if (!name) { errors.push({ row: rowNo, message: '姓名不能为空' }); return; }
    const roleParsed = parseRoleCell(roleRaw);
    if (roleParsed.error) { errors.push({ row: rowNo, message: roleParsed.error }); return; }
    const reqRoles = roleParsed.roles;
    // 防提权：collegeOfficer 不可批量创建特权角色账号
    if (hasRole(user, 'collegeOfficer') && reqRoles.some((r2) => PRIVILEGED_ROLES.includes(r2))) {
      errors.push({ row: rowNo, message: '无权批量创建管理员或学院考勤负责老师账号' });
      return;
    }
    const explicit = cellOf(r, '登录账号', '账号', '用户名', 'loginAccount', 'username');
    const sid = cellOf(r, '学号或工号', '学号', '工号', '编号', 'studentId');
    // 账号推导：账号列优先；否则按角色取学号（学生）或工号（教职工）
    const username = explicit || sid;
    if (!username) {
      errors.push({ row: rowNo, message: '请填写"登录账号"，或填写"学号/工号"以便自动生成账号' });
      return;
    }
    if (!/^[a-zA-Z0-9_]{2,20}$/.test(username)) {
      errors.push({ row: rowNo, message: `账号 "${username}" 不合法：需为 2-20 位字母、数字或下划线` });
      return;
    }
    // 修改35 · 第3点：纪律委员 / 权益部 属学生角色，账号必须对应班级名单中真实存在的学生。
    // 校验放在账号格式校验之后、去重之前 —— 格式问题优先暴露，且不会让无效账号占用学号配额。
    // 学号缺失或查无此人 → 该账号【不予导入】（整行 failed），其余行不受影响。
    const isStudentRole = reqRoles.some((r2) => STUDENT_ROLES.includes(r2));
    if (isStudentRole) {
      if (!sid) {
        errors.push({ row: rowNo, message: `角色为${reqRoles.map((r2) => ROLE_NAMES[r2]).join('、')}，必须在"学号或工号"列填写学号` });
        return;
      }
      if (!studentIdExists(sid)) {
        errors.push({ row: rowNo, message: `学号 ${sid} 在班级名单中未找到，该账号不予导入` });
        return;
      }
    }
    // 初始密码：Excel 指定优先，否则按角色规则推导
    const pwdRaw = cellOf(r, '初始密码', '密码', 'password');
    const initialPassword = pwdRaw || derivePassword(reqRoles[0], username);
    if (initialPassword.length < 6) {
      errors.push({ row: rowNo, message: `初始密码长度不能少于 6 位（第 ${rowNo} 行）` });
      return;
    }
    // 去重：批内自去重 + 库内已存在 → 全部跳过，不改动已有数据（用户口径）
    if (seen.has(username)) {
      duplicates++;
      errors.push({ row: rowNo, message: `账号 ${username} 在本表内重复，已跳过` });
      return;
    }
    if (store.db.users.some((x) => x.username === username)) {
      duplicates++;
      errors.push({ row: rowNo, message: `账号 ${username} 已存在，已跳过` });
      return;
    }
    // 修改35 · 第4点：可点名班级逐项匹配 —— 未匹配项剔除（留空），但账号照常创建。
    const rawClasses = cellList(cellOf(r, '可点名班级', '班级', '授权班级', 'classes'));
    const { matched, missing } = matchClasses(rawClasses);
    if (missing.length) {
      notices.push({
        row: rowNo,
        message: `可点名班级 ${missing.join('、')} 不在班级名单中，已跳过该字段；账号 ${username} 已正常创建`,
      });
    }
    const keepClasses = reqRoles.some((r2) => STUDENT_ROLES.includes(r2));
    const u = {
      id: uid('u'),
      username,
      name,
      role: reqRoles[0],
      roles: reqRoles,
      classes: keepClasses ? matched : [], // 修改35：写入匹配成功的班级，未匹配的剔除
      enabled: true,
      mustChangePassword: true,
      passwordHash: hashPassword(initialPassword),
      createdAt: nowISO(),
      createdBy: user.name,
    };
    store.db.users.push(u);
    seen.add(username);
    imported++;
    created.push({
      username,
      name,
      roles: reqRoles.map((r2) => ROLE_NAMES[r2]).join('、'),
      password: initialPassword,
      classes: keepClasses ? matched : [], // 供前端展示"部分导入"
      skippedClasses: keepClasses ? missing : [],
    });
  });

  if (imported) store.save('users');
  dataOplog(user, '批量导入账号', `共 ${rows.length} 条，成功 ${imported}，跳过重复 ${duplicates}，未处理 ${errors.length}`);
  json(res, 200, {
    total: rows.length,
    imported,
    failed: errors.length,
    skipped: 0,
    duplicates,
    errors: errors.slice(0, 20),
    notices: notices.slice(0, 20),
    noticesCount: notices.length,
    // 修改35：结果分区 —— 完全导入 / 部分导入（可点名班级被剔除）/ 不予导入
    fullyImported: imported - created.filter((c) => (c.skippedClasses || []).length).length,
    partialImported: created.filter((c) => (c.skippedClasses || []).length).length,
    notImported: errors.length,
    created,
  });
});

// ==================== 教职工名单（工号 / 姓名 / 岗位 / 所带班级） ====================
const STAFF_TYPES = ['班主任', '辅导员'];

route('GET', '/api/staffs', { roles: ['admin', 'collegeOfficer'] }, async ({ res }) => {
  const list = store.db.staffs.slice().sort((a, b) => String(a.staffId).localeCompare(String(b.staffId)));
  // 修改34：附带 hasAccount（该工号是否已生成过账号），前端据此禁用勾选、显示"已建账号"
  const userNames = new Set(store.db.users.map((u) => u.username));
  json(res, 200, { total: list.length, list: list.map((s) => ({ ...s, hasAccount: userNames.has(s.staffId) })) });
});

route('POST', '/api/staffs', { roles: ['admin', 'collegeOfficer'] }, async ({ res, body }) => {
  const staffId = String(body.staffId || '').trim();
  const name = String(body.name || '').trim();
  const type = String(body.type || '').trim();
  if (!/^[a-zA-Z0-9_-]{2,20}$/.test(staffId)) fail(400, '工号需为 2-20 位字母、数字、下划线或短横线');
  if (!name) fail(400, '请输入姓名');
  if (!STAFF_TYPES.includes(type)) fail(400, '岗位需为班主任或辅导员');
  if (store.db.staffs.some((s) => s.staffId === staffId)) fail(400, `工号 ${staffId} 已存在`);
  const classes = [...new Set((Array.isArray(body.classes) ? body.classes : []).map((c) => String(c).trim()).filter(Boolean))];
  const st = { id: uid('stf'), staffId, name, type, classes, createdAt: nowISO() };
  store.db.staffs.push(st);
  store.save('staffs');
  json(res, 200, { staff: st });
});

route('PUT', '/api/staffs/:id', { roles: ['admin', 'collegeOfficer'] }, async ({ res, params, body }) => {
  const st = store.db.staffs.find((x) => x.id === params.id);
  if (!st) fail(404, '教职工不存在');
  if (body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name) fail(400, '请输入姓名');
    st.name = name;
  }
  if (body.type !== undefined) {
    const type = String(body.type || '').trim();
    if (!STAFF_TYPES.includes(type)) fail(400, '岗位需为班主任或辅导员');
    st.type = type;
  }
  if (body.classes !== undefined) {
    st.classes = [...new Set((Array.isArray(body.classes) ? body.classes : []).map((c) => String(c).trim()).filter(Boolean))];
  }
  store.save('staffs');
  json(res, 200, { staff: st });
});

route('DELETE', '/api/staffs/:id', { roles: ['admin', 'collegeOfficer'] }, async ({ res, params }) => {
  const idx = store.db.staffs.findIndex((x) => x.id === params.id);
  if (idx < 0) fail(404, '教职工不存在');
  const st = store.db.staffs[idx];
  if (store.db.users.some((u) => u.username === st.staffId)) fail(400, `工号 ${st.staffId} 已生成过账号，请先删除对应账号`);
  store.db.staffs.splice(idx, 1);
  store.save('staffs');
  json(res, 200, { ok: true });
});

// ==================== 修改34：教职工名单批量导入 / 批量生成账号 ====================
const STAFF_TYPE_TO_ROLE = { 班主任: 'headTeacher', 辅导员: 'counselor' };

/** 由教职工名单条目创建账号（generate-accounts 与 import 共用）
 *  返回 { ok, message }；ok=false 时 message 说明原因（调用方计入 skipped / errors） */
function createStaffAccount(st, role, operator) {
  const username = st.staffId;
  if (store.db.users.some((u) => u.username === username)) {
    return { ok: false, message: `工号 ${username} 已生成过账号，已跳过` };
  }
  const initialPassword = `Hzpt@${username}`; // 用户口径：教职工账号密码 = Hzpt@完整工号
  const u = {
    id: uid('u'),
    username,
    name: st.name,
    role,
    roles: [role],
    classes: [...(st.classes || [])], // 与 generate/staff 772 行一致：教职工账号保留所带班级
    enabled: true,
    mustChangePassword: true,
    passwordHash: hashPassword(initialPassword),
    createdAt: nowISO(),
    createdBy: operator.name,
  };
  store.db.users.push(u);
  return { ok: true, username, name: st.name, role, password: initialPassword };
}

route('POST', '/api/staffs/import', { roles: ['admin', 'collegeOfficer'] }, async ({ req, res, user, body }) => {
  if (!rateLimit(`staff-import:${clientIp(req)}`, 20, 60000)) fail(429, '导入过于频繁，请稍后再试');
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) fail(400, '没有可导入的数据');
  const createAccounts = body.createAccounts === true; // 是否同时按名单批量生成账号
  const keys = new Set(rows.flatMap((r) => Object.keys(r || {})));
  const hasCol = (list) => [...keys].some((k) => list.includes(k));
  if (!hasCol(['工号', '教师工号', '职工号', 'staffId'])) fail(400, '未找到"工号"列，请下载导入模板后按模板表头填写');
  if (!hasCol(['姓名', '名字', 'name'])) fail(400, '未找到"姓名"列，请下载导入模板后按模板表头填写');
  if (!hasCol(['岗位', '类型', '职务', 'type'])) fail(400, '未找到"岗位"列，请下载导入模板后按模板表头填写');

  const errors = []; const notices = []; const created = [];
  const seen = new Set();
  let imported = 0, updated = 0, duplicates = 0, accountsCreated = 0, accountsSkipped = 0;
  // 修改35：结果分区计数 —— 用于前端区分「完全导入 / 部分导入 / 不予导入」
  let fullyImported = 0, partialImported = 0, notImported = 0;

  rows.forEach((r, idx) => {
    const rowNo = idx + 2;
    const staffId = cellOf(r, '工号', '教师工号', '职工号', 'staffId');
    const name = cellOf(r, '姓名', '名字', 'name');
    const type = cellOf(r, '岗位', '类型', '职务', 'type');
    if (!staffId) { errors.push({ row: rowNo, message: '工号不能为空' }); notImported++; return; }
    if (!name) { errors.push({ row: rowNo, message: '姓名不能为空' }); notImported++; return; }
    if (!STAFF_TYPES.includes(type)) { errors.push({ row: rowNo, message: `岗位需为班主任或辅导员（当前为"${type || '空'}"）` }); notImported++; return; }
    if (!/^[a-zA-Z0-9_-]{2,20}$/.test(staffId)) {
      errors.push({ row: rowNo, message: `工号 ${staffId} 不合法：需为 2-20 位字母、数字、下划线或短横线` });
      notImported++;
      return;
    }
    // 修改35 · 第1点：所带班级逐项匹配 —— 未匹配项剔除（该字段留空），但教职工仍正常入库、仍可建号。
    // 判定条件：与班级名单中的 className 精确匹配（trim + 忽略大小写）。
    const rawClasses = cellList(cellOf(r, '所带班级', '带班班级', '班级', 'classes'));
    const { matched, missing } = matchClasses(rawClasses);
    // 修改35 · 第2点：同一工号重复导入 → 执行更新（姓名 / 岗位 / 所带班级），而非整体跳过。
    // 口径：表格留空 = 本次不提供该字段 → 不改动原有值；填了则覆盖为匹配成功的结果。
    const exist = store.db.staffs.find((s) => s.staffId === staffId);
    if (exist) {
      const changed = [];
      if (name && name !== exist.name) { changed.push(`姓名：${exist.name} → ${name}`); exist.name = name; }
      if (type && type !== exist.type) { changed.push(`岗位：${exist.type} → ${type}`); exist.type = type; }
      // 班级：表格留空 → 保持原值不变；非空 → 写入匹配成功的（未匹配项被剔除）
      if (rawClasses.length) {
        const before = [...(exist.classes || [])];
        exist.classes = matched;
        if (JSON.stringify(before) !== JSON.stringify(matched)) {
          changed.push(`所带班级：${before.join('、') || '空'} → ${matched.join('、') || '空'}`);
        }
      }
      // 结果分区：有班级被剔除 → 部分导入；否则完全导入（与新增行同口径）
      if (missing.length) partialImported++; else fullyImported++;
      if (missing.length) {
        notices.push({
          row: rowNo,
          message: `所带班级 ${missing.join('、')} 不在班级名单中，已跳过该字段；${exist.name} ${changed.length ? '信息已更新' : '信息无变化'}${createAccounts ? '，账号正常处理' : ''}`,
        });
      }
      if (changed.length) {
        updated++;
        notices.push({ row: rowNo, message: `工号 ${staffId} 已存在，已更新：${changed.join('；')}` });
      } else {
        duplicates++; // 内容完全一致 → 无需更新，记为重复
      }
      seen.add(staffId);
      // 更新场景同样允许建号（此前已建过则跳过）
      if (createAccounts) {
        const role = STAFF_TYPE_TO_ROLE[type];
        const acc = createStaffAccount(exist, role, user);
        if (acc.ok) { accountsCreated++; created.push({ username: acc.username, name: acc.name, roles: ROLE_NAMES[role], password: acc.password, classes: exist.classes, skippedClasses: missing }); }
        else accountsSkipped++;
      }
      return;
    }
    // 新增行：批内若同一工号重复出现，后一行覆盖前一行（同批次"后值优先"），不报错
    const st = { id: uid('stf'), staffId, name, type, classes: matched, createdAt: nowISO() };
    store.db.staffs.push(st);
    seen.add(staffId);
    imported++;
    if (missing.length) {
      partialImported++;
      notices.push({
        row: rowNo,
        message: `所带班级 ${missing.join('、')} 不在班级名单中，已跳过该字段（该教职工已导入名单${createAccounts ? '，账号正常创建' : ''}）`,
      });
    } else {
      fullyImported++;
    }
    // 同步批量建号：仅对本行新建成功的教职工生效（不受班级是否匹配影响 —— 修改35 第1点）
    if (createAccounts) {
      const role = STAFF_TYPE_TO_ROLE[type];
      const acc = createStaffAccount(st, role, user);
      if (acc.ok) {
        accountsCreated++;
        created.push({ username: acc.username, name: acc.name, roles: ROLE_NAMES[role], password: acc.password, classes: matched, skippedClasses: missing });
      } else accountsSkipped++;
    }
  });

  if (imported || updated) store.save('staffs');
  if (accountsCreated) store.save('users');
  dataOplog(user, '批量导入教职工名单', `共 ${rows.length} 条，新增 ${imported}，更新 ${updated}，跳过重复 ${duplicates}，未处理 ${errors.length}${createAccounts ? `；同时生成账号 ${accountsCreated}` : ''}`);
  json(res, 200, {
    total: rows.length,
    imported,
    updated,
    failed: errors.length,
    skipped: 0,
    duplicates,
    errors: errors.slice(0, 20),
    notices: notices.slice(0, 20),
    noticesCount: notices.length,
    // 修改35：结果分区，供前端明确区分三种结果
    fullyImported,
    partialImported,
    notImported,
    accountsCreated,
    accountsSkipped,
    created,
  });
});

/** 教职工列表勾选后批量生成账号 */
route('POST', '/api/staffs/generate-accounts', { roles: ['admin', 'collegeOfficer'] }, async ({ res, user, body }) => {
  const staffIds = Array.isArray(body.staffIds) ? body.staffIds.map((s) => String(s || '').trim()).filter(Boolean) : [];
  if (!staffIds.length) fail(400, '请至少勾选一名教职工');
  const errors = []; const results = [];
  let created = 0;
  staffIds.forEach((sid, idx) => {
    const rowNo = idx + 1; // 此处为勾选序号，非 Excel 行号
    const st = store.db.staffs.find((x) => x.staffId === sid);
    if (!st) { errors.push({ row: rowNo, message: `工号 ${sid} 不在教职工名单中` }); return; }
    const role = STAFF_TYPE_TO_ROLE[st.type];
    if (!role) { errors.push({ row: rowNo, message: `${st.name}（${sid}）岗位为"${st.type}"，无法生成账号` }); return; }
    const acc = createStaffAccount(st, role, user);
    if (acc.ok) {
      created++;
      results.push({ username: acc.username, name: acc.name, roles: ROLE_NAMES[role], password: acc.password });
    } else {
      errors.push({ row: rowNo, message: acc.message });
    }
  });
  if (created) store.save('users');
  dataOplog(user, '批量生成教职工账号', `勾选 ${staffIds.length} 名，成功 ${created}，未处理 ${errors.length}`);
  json(res, 200, {
    total: staffIds.length,
    imported: created,
    created,
    failed: errors.length,
    skipped: errors.length,
    errors: errors.slice(0, 20),
    results,
  });
});

// ==================== 修改72：班级管理（classes） ====================
// 定位：班级信息的唯一维护入口。原先分散在「班级名单」逐学生冗余的班主任 / 辅导员 /
// 纪律委员三字段，改由本处以班级维度维护，并单向同步回学生记录的只读镜像。
const CLASS_MANAGE_ROLES = ['admin', 'collegeOfficer'];

/** 班级记录 → 列表视图（含人数、账号联动三态） */
function classView(c) {
  const nm = normClassName(c.name);
  const students = store.db.students.filter((s) => String(s.className || '').trim() === nm);
  const linkOf = (p, role) => {
    const label = postNameOf(p);
    if (!label) return { label: '', state: 'empty' };
    if (p && p.staffId) {
      const u = store.db.users.find((x) => x.username === p.staffId);
      if (!u) return { label, state: 'no-account' };
      const has = (u.classes || []).some((cn) => normClassName(cn).toLowerCase() === nm.toLowerCase());
      return { label, state: has ? 'linked' : 'mismatch' };
    }
    // 纪律委员：按姓名/学号找学生账号
    const sid = p && p.studentId;
    const u = sid ? store.db.users.find((x) => x.username === sid) : null;
    if (!u) return { label, state: 'no-account' };
    return { label, state: 'linked' };
  };
  return {
    ...c,
    name: nm,
    count: students.length,
    grade: c.grade || (students[0] && students[0].grade) || '',
    headTeacherName: postNameOf(c.headTeacher),
    counselorName: postNameOf(c.counselor),
    disciplineMemberName: postNameOf(c.disciplineMember),
    links: {
      headTeacher: linkOf(c.headTeacher, 'headTeacher'),
      counselor: linkOf(c.counselor, 'counselor'),
      disciplineMember: linkOf(c.disciplineMember, 'discipline'),
    },
  };
}
/** 三岗位是否齐全 → 决定 status。缺任一即「待补信息」 */
function classStatusOf(c) {
  return postNameOf(c.headTeacher) && postNameOf(c.counselor) && postNameOf(c.disciplineMember)
    ? 'active'
    : 'incomplete';
}

route('GET', '/api/classes', { roles: CLASS_MANAGE_ROLES }, async ({ res, query }) => {
  const q = String(query.q || '').trim().toLowerCase();
  const grade = String(query.grade || '').trim();
  const status = String(query.status || '').trim();
  // 已登记班级 + 学生表有班但尚未登记的虚拟班级（提示去补信息）
  const regNames = new Set((store.db.classes || []).map((c) => normClassName(c.name).toLowerCase()));
  const virtual = [];
  for (const s of store.db.students) {
    const nm = String(s.className || '').trim();
    if (!nm || regNames.has(nm.toLowerCase())) continue;
    regNames.add(nm.toLowerCase());
    virtual.push({ id: `v_${nm}`, name: nm, grade: s.grade || '', major: '', headTeacher: null, counselor: null, disciplineMember: null, status: 'unregistered', source: 'students', updatedAt: '', updatedBy: '' });
  }
  let list = [...(store.db.classes || []), ...virtual].map(classView);
  if (grade) list = list.filter((c) => normGrade(c.grade) === normGrade(grade));
  if (status === 'incomplete') list = list.filter((c) => c.status !== 'active');
  else if (status === 'active') list = list.filter((c) => c.status === 'active');
  if (q) list = list.filter((c) => [c.name, c.grade, c.major, c.headTeacherName, c.counselorName, c.disciplineMemberName].join(' ').toLowerCase().includes(q));
  list.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  const total = list.length;
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(query.pageSize, 10) || 20));
  json(res, 200, { total, page, pageSize, list: list.slice((page - 1) * pageSize, page * pageSize) });
});

// 单个班级详情（编辑弹窗 / 联动结果刷新用）
route('GET', '/api/classes/:name', { roles: CLASS_MANAGE_ROLES }, async ({ res, params }) => {
  const name = normClassName(decodeURIComponent(params.name));
  const rec = classRecordOf(name);
  if (!rec) {
    // 未登记班级：返回 students 派生的虚拟视图，便于用户直接补录岗位信息
    const count = store.db.students.filter((s) => String(s.className || '').trim() === name).length;
    if (!count) fail(404, `班级「${name}」不存在`);
    return json(res, 200, {
      class: {
        ...classView({ id: `v_${name}`, name, grade: '', major: '', headTeacher: null, counselor: null, disciplineMember: null, status: 'unregistered', source: 'students', updatedAt: '', updatedBy: '' }),
        count,
      },
    });
  }
  json(res, 200, { class: classView(rec) });
});

route('POST', '/api/classes', { roles: CLASS_MANAGE_ROLES }, async ({ res, user, body }) => {  const name = normClassName(body.name);
  if (!name) fail(400, '请填写班级名称');
  if (classRecordOf(name)) fail(400, `班级「${name}」已存在`);
  const rec = {
    id: uid('cls'),
    name,
    grade: String(body.grade || '').trim(),
    major: String(body.major || '').trim(),
    headTeacher: { name: String((body.headTeacher && body.headTeacher.name) || '').trim(), staffId: String((body.headTeacher && body.headTeacher.staffId) || '').trim() },
    counselor: { name: String((body.counselor && body.counselor.name) || '').trim(), staffId: String((body.counselor && body.counselor.staffId) || '').trim() },
    disciplineMember: { name: String((body.disciplineMember && body.disciplineMember.name) || '').trim(), studentId: String((body.disciplineMember && body.disciplineMember.studentId) || '').trim() },
    source: 'manual',
    updatedAt: nowISO(),
    updatedBy: user.name,
  };
  rec.status = classStatusOf(rec);
  store.db.classes.push(rec);
  store.save('classes');
  syncPostsToStudents(rec.name);
  dataOplog(user, '新增班级', `${name}（${rec.grade || '—'}）`);
  json(res, 200, { class: classView(rec) });
});

route('PUT', '/api/classes/:name', { roles: CLASS_MANAGE_ROLES }, async ({ res, user, params, body }) => {
  const oldName = normClassName(decodeURIComponent(params.name));
  const rec = classRecordOf(oldName);
  if (!rec) fail(404, `班级「${oldName}」不存在（未登记的班级请先新增）`);
  const newName = body.name !== undefined ? normClassName(body.name) : oldName;
  if (!newName) fail(400, '班级名称不能为空');
  if (newName.toLowerCase() !== oldName.toLowerCase() && classRecordOf(newName)) fail(400, `班级「${newName}」已存在`);
  const rename = newName !== oldName;
  if (body.grade !== undefined) rec.grade = String(body.grade || '').trim();
  if (body.major !== undefined) rec.major = String(body.major || '').trim();
  for (const f of ['headTeacher', 'counselor', 'disciplineMember']) {
    if (body[f] === undefined) continue;
    const v = body[f] || {};
    rec[f] = {
      name: String(v.name || '').trim(),
      staffId: String(v.staffId || '').trim(),
      studentId: String(v.studentId || '').trim(),
    };
  }
  rec.status = classStatusOf(rec);
  rec.updatedAt = nowISO();
  rec.updatedBy = user.name;
  if (rename) {
    // 班级改名：同步学生表 / 教职工 / 账号上的班级名引用
    rec.name = newName;
    for (const s of store.db.students) if (String(s.className || '').trim() === oldName) s.className = newName;
    store.save('students');
    for (const st of store.db.staffs || []) {
      if ((st.classes || []).some((c) => String(c).trim() === oldName)) {
        st.classes = st.classes.map((c) => (String(c).trim() === oldName ? newName : c));
      }
    }
    store.save('staffs');
    for (const u of store.db.users) {
      if ((u.classes || []).some((c) => String(c).trim() === oldName)) {
        u.classes = u.classes.map((c) => (String(c).trim() === oldName ? newName : c));
      }
    }
    store.save('users');
  }
  store.save('classes');
  syncPostsToStudents(newName);
  dataOplog(user, '编辑班级', `${oldName}${rename ? ` → ${newName}` : ''}`);
  json(res, 200, { class: classView(rec) });
});

/** 把班级三岗位写回学生记录的只读镜像（权威源 → 学生表） */
function syncPostsToStudents(className) {
  const nm = normClassName(className);
  let changed = false;
  for (const s of store.db.students) {
    if (String(s.className || '').trim() !== nm) continue;
    if (applyClassPosts(s)) changed = true;
  }
  if (changed) store.save('students');
  return changed;
}

route('DELETE', '/api/classes/:name', { roles: CLASS_MANAGE_ROLES }, async ({ res, user, params }) => {
  const name = normClassName(decodeURIComponent(params.name));
  const idx = (store.db.classes || []).findIndex((c) => normClassName(c.name).toLowerCase() === name.toLowerCase());
  if (idx < 0) fail(404, `班级「${name}」不存在`);
  const students = store.db.students.filter((s) => String(s.className || '').trim() === name);
  const staffRefs = (store.db.staffs || []).filter((st) => (st.classes || []).some((c) => String(c).trim() === name));
  const userRefs = store.db.users.filter((u) => (u.classes || []).some((c) => String(c).trim() === name));
  const refs = [];
  if (students.length) refs.push(`班级名单 ${students.length} 名学生`);
  if (staffRefs.length) refs.push(`教职工名单 ${staffRefs.length} 人`);
  if (userRefs.length) refs.push(`账号 ${userRefs.length} 个`);
  if (refs.length) fail(400, `班级「${name}」仍被引用（${refs.join('、')}），请先清空后再删除；若该班已毕业，建议保留记录即可`);
  store.db.classes.splice(idx, 1);
  store.save('classes');
  dataOplog(user, '删除班级', name);
  json(res, 200, { ok: true });
});

route('POST', '/api/classes/import', { roles: CLASS_MANAGE_ROLES }, async ({ req, res, user, body }) => {
  if (!rateLimit(`cls-import:${clientIp(req)}`, 20, 60000)) fail(429, '导入过于频繁，请稍后再试');
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) fail(400, '没有可导入的数据');
  const keys = new Set(rows.flatMap((r) => Object.keys(r || {})));
  const hasCol = (list) => [...keys].some((k) => list.includes(k));
  if (!hasCol(['班级', '班级名称', '班级名', 'className'])) fail(400, '未找到"班级"列，请下载导入模板后按模板表头填写');

  const errors = []; const notices = [];
  let imported = 0, updated = 0, duplicates = 0;
  let fullyImported = 0, partialImported = 0, notImported = 0;

  rows.forEach((r, idx) => {
    const rowNo = idx + 2;
    const name = normClassName(cellOf(r, '班级', '班级名称', '班级名', 'className'));
    if (!name) { errors.push({ row: rowNo, message: '班级不能为空' }); notImported++; return; }
    const grade = cellOf(r, '年级', 'grade');
    const major = cellOf(r, '专业', 'major');
    const htName = cellOf(r, '班主任', 'headTeacher');
    const htId = cellOf(r, '班主任工号', 'headTeacherId');
    const coName = cellOf(r, '辅导员', 'counselor');
    const coId = cellOf(r, '辅导员工号', 'counselorId');
    const dmName = cellOf(r, '纪律委员', 'disciplineMember');
    const dmSid = cellOf(r, '纪律委员学号', 'disciplineMemberId');

    const next = {
      grade,
      major,
      headTeacher: { name: htName, staffId: htId },
      counselor: { name: coName, staffId: coId },
      disciplineMember: { name: dmName, studentId: dmSid },
    };
    const exist = classRecordOf(name);
    let target;
    if (exist) {
      target = exist;
      const changed = [];
      // 口径：表格留空 = 本次不提供该字段 → 不改动原有值；填了则覆盖
      if (grade && grade !== exist.grade) { changed.push(`年级：${exist.grade || '空'} → ${grade}`); exist.grade = grade; }
      if (major && major !== exist.major) { changed.push(`专业：${exist.major || '空'} → ${major}`); exist.major = major; }
      if (htName || htId) {
        const before = postNameOf(exist.headTeacher);
        exist.headTeacher = { name: htName || (exist.headTeacher && exist.headTeacher.name) || '', staffId: htId || (exist.headTeacher && exist.headTeacher.staffId) || '' };
        if (postNameOf(exist.headTeacher) !== before) changed.push(`班主任：${before || '空'} → ${postNameOf(exist.headTeacher) || '空'}`);
      }
      if (coName || coId) {
        const before = postNameOf(exist.counselor);
        exist.counselor = { name: coName || (exist.counselor && exist.counselor.name) || '', staffId: coId || (exist.counselor && exist.counselor.staffId) || '' };
        if (postNameOf(exist.counselor) !== before) changed.push(`辅导员：${before || '空'} → ${postNameOf(exist.counselor) || '空'}`);
      }
      if (dmName || dmSid) {
        const before = postNameOf(exist.disciplineMember);
        exist.disciplineMember = { name: dmName || (exist.disciplineMember && exist.disciplineMember.name) || '', studentId: dmSid || (exist.disciplineMember && exist.disciplineMember.studentId) || '' };
        if (postNameOf(exist.disciplineMember) !== before) changed.push(`纪律委员：${before || '空'} → ${postNameOf(exist.disciplineMember) || '空'}`);
      }
      exist.status = classStatusOf(exist);
      exist.updatedAt = nowISO();
      exist.updatedBy = user.name;
      if (changed.length) { updated++; notices.push({ row: rowNo, message: `班级「${name}」已存在，已更新：${changed.join('；')}` }); }
      else duplicates++;
    } else {
      target = {
        id: uid('cls'),
        name,
        grade,
        major,
        headTeacher: next.headTeacher,
        counselor: next.counselor,
        disciplineMember: next.disciplineMember,
        source: 'import',
        updatedAt: nowISO(),
        updatedBy: user.name,
      };
      target.status = classStatusOf(target);
      store.db.classes.push(target);
      imported++;
    }
    // 三区判定：岗位齐全 = 完全导入；缺岗位但至少有班级名 = 部分导入
    const hasStudent = store.db.students.some((s) => String(s.className || '').trim() === name);
    if (target.status === 'active') fullyImported++;
    else {
      partialImported++;
      const miss = CLASS_POST_FIELDS.filter((f) => !postNameOf(target[f.key])).map((f) => f.label);
      notices.push({ row: rowNo, message: `班级「${name}」${miss.join('、')}未填写，已标记「待补信息」${hasStudent ? '' : '；该班在班级名单中暂无学生'}` });
    }
  });

  if (imported || updated) {
    store.save('classes');
    // 权威源 → 学生只读镜像
    let changed = false;
    for (const c of store.db.classes) if (syncPostsToStudents(c.name)) changed = true;
  }
  dataOplog(user, '批量导入班级', `共 ${rows.length} 条，新增 ${imported}，更新 ${updated}，无变化 ${duplicates}，未处理 ${errors.length}`);
  json(res, 200, {
    total: rows.length, imported, updated, failed: errors.length, skipped: 0, duplicates,
    errors: errors.slice(0, 20), notices: notices.slice(0, 20), noticesCount: notices.length,
    fullyImported, partialImported, notImported,
  });
});

/** 存量迁移：把学生表上逐学生冗余的三岗位聚合进 classes（幂等） */
route('POST', '/api/classes/migrate', { roles: ['admin', 'collegeOfficer'] }, async ({ res, user }) => {
  const groups = new Map();
  for (const s of store.db.students) {
    const nm = String(s.className || '').trim();
    if (!nm) continue;
    const k = nm.toLowerCase();
    if (!groups.has(k)) groups.set(k, { name: nm, grade: s.grade || '', classTeacher: new Map(), counselor: new Map(), disciplineMember: new Map() });
    const g = groups.get(k);
    if (!g.grade && s.grade) g.grade = s.grade;
    for (const f of ['classTeacher', 'counselor', 'disciplineMember']) {
      const v = String(s[f] || '').trim();
      if (!v) continue;
      g[f].set(v, (g[f].get(v) || 0) + 1);
    }
  }
  let created = 0, updated = 0, unchanged = 0, conflicts = 0;
  const report = [];
  for (const g of groups.values()) {
    // 冲突消解：众数（出现次数最多的非空值）优先，次数相同取首个
    const pick = (m) => {
      if (!m.size) return '';
      const arr = [...m.entries()].sort((a, b) => b[1] - a[1]);
      if (arr.length > 1 && arr[0][1] === arr[1][1]) conflicts++;
      return arr[0][0];
    };
    const ht = pick(g.classTeacher);
    const co = pick(g.counselor);
    const dm = pick(g.disciplineMember);
    const exist = classRecordOf(g.name);
    if (exist) {
      let changed = false;
      if (ht && !postNameOf(exist.headTeacher)) { exist.headTeacher = { ...(exist.headTeacher || {}), name: ht }; changed = true; }
      if (co && !postNameOf(exist.counselor)) { exist.counselor = { ...(exist.counselor || {}), name: co }; changed = true; }
      if (dm && !postNameOf(exist.disciplineMember)) { exist.disciplineMember = { ...(exist.disciplineMember || {}), name: dm }; changed = true; }
      if (!exist.grade && g.grade) { exist.grade = g.grade; changed = true; }
      if (changed) { exist.status = classStatusOf(exist); exist.updatedAt = nowISO(); exist.updatedBy = user.name; updated++; report.push({ name: g.name, action: 'updated' }); }
      else { unchanged++; report.push({ name: g.name, action: 'unchanged' }); }
      continue;
    }
    const rec = {
      id: uid('cls'),
      name: g.name,
      grade: g.grade,
      major: '',
      headTeacher: { name: ht, staffId: '' },
      counselor: { name: co, staffId: '' },
      disciplineMember: { name: dm, studentId: '' },
      source: 'migrate',
      updatedAt: nowISO(),
      updatedBy: user.name,
    };
    rec.status = classStatusOf(rec);
    store.db.classes.push(rec);
    created++;
    report.push({ name: g.name, action: 'created', headTeacher: ht, counselor: co, disciplineMember: dm });
  }
  store.save('classes');
  // 权威源 → 学生只读镜像（顺带把班内冲突值统一）
  for (const c of store.db.classes) syncPostsToStudents(c.name);
  dataOplog(user, '班级信息存量迁移', `共 ${groups.size} 个班，新增 ${created}，补全 ${updated}，无变化 ${unchanged}，字段冲突 ${conflicts}`);
  json(res, 200, { total: groups.size, created, updated, unchanged, conflicts, report: report.slice(0, 200) });
});

/** 显式联动：把班级名追加到该班班主任 / 辅导员账号的可见班级，
 *  并回填教职工名单的所带班级 —— 一次性双写，填平「改 staffs 不回写 user」的既有缺口。 */
// 修改76：同步账号 → 自动补建缺失账号（幂等）。
// 原行为：只把岗位人员追加到"已存在"账号的可见班级，账号不存在只能失败返回，链路断裂。
// 现在：
//  ① 班主任 / 辅导员：按工号自动建号（初始密码 Hzpt@工号，首登强制改密），并补齐教职工名单记录；
//  ② 纪律委员：按学号建号 —— 前提是该学号能在本班名单中匹配到学生（防止学号填错造出孤儿账号），
//     初始密码 Hzpt@学号后六位；姓名以班级名单为准，与班级管理填写不一致时提示；
//  ③ 幂等：同一工号 / 学号全程仅一个账号 —— 已存在时不重复创建、不改动角色，
//     只确保其可点名班级包含本班（同一人带多个班 = 一个账号关联多个班级，需求3）。
// 汇总返回：created（新建）/ linked（已存在并追加班级）/ skipped（已存在且已含本班）/ failed（含原因）。
// 修改77：核心逻辑抽为 syncClassAccounts(rec, opts) —— 单班级路由与「批量同步」路由共用同一份实现，
// 避免两处漂移；opts.empty 表示该班未维护任何岗位人员（单班路由报错、批量路由记为跳过）。
function syncClassAccounts(rec, opts) {
  const name = normClassName(rec.name);
  const { which = 'all', autoCreate = true, operatorName = '' } = opts || {};
  const results = [];
  let created = 0, linked = 0, skipped = 0, failed = 0;

  /** 把本班追加到账号可见班级（幂等）。返回是否发生变更 */
  const linkClass = (u) => {
    const list = Array.isArray(u.classes) ? u.classes : [];
    if (list.some((c) => normClassName(c).toLowerCase() === name.toLowerCase())) return false;
    u.classes = [...list, name];
    store.save('users');
    return true;
  };
  /** 教职工名单回填：无该工号则按岗位补建记录，保持「账号 ← → 教职工名单」一致 */
  const upsertStaff = (staffId, sName, roleKey) => {
    const st = (store.db.staffs || []).find((x) => x.staffId === staffId);
    if (!st) {
      store.db.staffs.push({ id: uid('stf'), staffId, name: sName, type: ROLE_NAMES[roleKey] || roleKey, classes: [name], createdAt: nowISO() });
      store.save('staffs');
      return;
    }
    const sl = Array.isArray(st.classes) ? st.classes : [];
    if (!sl.some((c) => normClassName(c).toLowerCase() === name.toLowerCase())) {
      st.classes = [...sl, name];
      store.save('staffs');
    }
  };

  const targets = [];
  for (const f of CLASS_POST_FIELDS) {
    if (which !== 'all' && which !== f.key) continue;
    const p = rec[f.key];
    const label = postNameOf(p);
    if (!label) continue;
    targets.push({ f, p, label });
  }
  if (!targets.length) return { results: [], summary: { created: 0, linked: 0, skipped: 0, failed: 0 }, empty: true };

  for (const t of targets) {
    const isStudentPost = t.f.key === 'disciplineMember';
    const id = String(t.p.staffId || t.p.studentId || '').trim();
    if (!id) {
      failed++;
      results.push({ post: t.f.label, name: t.label, id: '', ok: false, action: 'failed', message: '未填写工号 / 学号，无法定位或创建账号' });
      continue;
    }
    const u = store.db.users.find((x) => x.username === id);
    if (u) {
      // 幂等：账号已存在 —— 不重复创建、不改角色（账号唯一），只确保可见班级包含本班
      const changed = linkClass(u);
      if (changed) {
        linked++;
        if (!isStudentPost) upsertStaff(id, u.name, u.role);
        results.push({ post: t.f.label, name: u.name, id, ok: true, action: 'linked', message: `账号已存在（${ROLE_NAMES[u.role] || u.role}），已把「${name}」加入其可点名班级` });
      } else {
        skipped++;
        results.push({ post: t.f.label, name: u.name, id, ok: true, action: 'skipped', message: '账号已存在且已包含该班级，无需处理' });
      }
      continue;
    }
    if (!autoCreate) {
      failed++;
      results.push({ post: t.f.label, name: t.label, id, ok: false, action: 'failed', message: `账号 ${id} 不存在（本次未开启自动补建），请先在「账号管理」创建` });
      continue;
    }
    // ---- 自动补建缺失账号 ----
    let initialPassword;
    let newU;
    if (isStudentPost) {
      const stu = store.db.students.find((s) => s.studentId === id && normClassName(s.className).toLowerCase() === name.toLowerCase());
      if (!stu) {
        failed++;
        results.push({ post: t.f.label, name: t.label, id, ok: false, action: 'failed', message: `纪律委员学号 ${id} 未能在「${name}」班级名单中匹配到学生，未创建账号；请先导入名单或核对学号` });
        continue;
      }
      initialPassword = `Hzpt@${id.slice(-6)}`;
      newU = {
        id: uid('u'), username: id, name: stu.name, role: 'discipline', roles: ['discipline'],
        classes: [name], enabled: true, mustChangePassword: true,
        passwordHash: hashPassword(initialPassword), createdAt: nowISO(), createdBy: operatorName,
      };
      store.db.users.push(newU);
      store.save('users');
      created++;
      let msg = `已自动创建纪律委员账号并关联「${name}」`;
      if (t.label !== stu.name) msg += `（班级管理中姓名为「${t.label}」，账号姓名以名单中的「${stu.name}」为准）`;
      results.push({ post: t.f.label, name: stu.name, id, ok: true, action: 'created', message: msg, initialPassword });
    } else {
      initialPassword = `Hzpt@${id}`;
      newU = {
        id: uid('u'), username: id, name: t.label, role: t.f.key, roles: [t.f.key],
        classes: [name], enabled: true, mustChangePassword: true,
        passwordHash: hashPassword(initialPassword), createdAt: nowISO(), createdBy: operatorName,
      };
      store.db.users.push(newU);
      store.save('users');
      created++;
      upsertStaff(id, t.label, t.f.key);
      results.push({ post: t.f.label, name: t.label, id, ok: true, action: 'created', message: `已自动创建${ROLE_NAMES[t.f.key]}账号并关联「${name}」`, initialPassword });
    }
  }
  return { results, summary: { created, linked, skipped, failed }, empty: false };
}

/** 单班级同步账号（班级管理行内「同步账号」按钮） */
route('POST', '/api/classes/:name/sync-account', { roles: CLASS_MANAGE_ROLES }, async ({ res, user, params, body }) => {
  const name = normClassName(decodeURIComponent(params.name));
  const rec = classRecordOf(name);
  if (!rec) fail(404, `班级「${name}」不存在`);
  const out = syncClassAccounts(rec, {
    which: String((body && body.which) || 'all'),
    autoCreate: !body || body.autoCreate !== false,
    operatorName: user.name,
  });
  if (out.empty) fail(400, '该班级尚未维护可同步的岗位人员');
  dataOplog(user, '同步班级到账号', `${rec.name}：新建账号 ${out.summary.created}，关联班级 ${out.summary.linked}，跳过 ${out.summary.skipped}，失败 ${out.summary.failed}`);
  json(res, 200, { results: out.results, summary: out.summary, class: classView(rec) });
});

// 修改77：批量同步账号 —— 两种入参（names 优先）：
//  ① names: [...] → 同步勾选的班级；② 无 names → 按当前筛选条件（grade / status / q，
//  与班级列表同口径）覆盖范围内全部班级，单次最多 200 个。
// 逐班复用 syncClassAccounts（自动补建 + 幂等），返回总汇总、每班明细与已不存在的班级名，
// 供前端一次展示「新建 / 关联 / 跳过 / 失败」四档结果与失败原因。
route('POST', '/api/classes/sync-account-batch', { roles: CLASS_MANAGE_ROLES }, async ({ res, user, body }) => {
  const which = String((body && body.which) || 'all');
  const autoCreate = !body || body.autoCreate !== false;
  const names = Array.isArray(body && body.names) ? body.names.map((x) => normClassName(x)).filter(Boolean) : [];
  const missingNames = [];
  let recs = [];
  if (names.length) {
    for (const n of names) {
      const rec = classRecordOf(n);
      if (rec) recs.push(rec);
      else missingNames.push(n);
    }
    if (!recs.length) fail(400, '所选班级均已不存在，请刷新页面后重试');
  } else {
    const grade = String((body && body.grade) || '').trim();
    const status = String((body && body.status) || '').trim();
    const q = String((body && body.q) || '').trim().toLowerCase();
    let list = (store.db.classes || []).map(classView);
    if (grade) list = list.filter((c) => normGrade(c.grade) === normGrade(grade));
    if (status === 'incomplete') list = list.filter((c) => c.status !== 'active');
    else if (status === 'active') list = list.filter((c) => c.status === 'active');
    if (q) list = list.filter((c) => [c.name, c.grade, c.major, c.headTeacherName, c.counselorName, c.disciplineMemberName].join(' ').toLowerCase().includes(q));
    recs = list.map((c) => classRecordOf(c.name)).filter(Boolean);
    if (!recs.length) fail(400, '当前筛选范围内没有可同步的班级');
    if (recs.length > 200) fail(400, `一次最多同步 200 个班级（当前筛选命中 ${recs.length} 个），请先缩小筛选范围`);
  }
  const perClass = [];
  const total = { created: 0, linked: 0, skipped: 0, failed: 0 };
  for (const rec of recs) {
    const out = syncClassAccounts(rec, { which, autoCreate, operatorName: user.name });
    if (out.empty) {
      perClass.push({ name: rec.name, empty: true, summary: { created: 0, linked: 0, skipped: 0, failed: 0 }, results: [] });
      continue;
    }
    for (const k of Object.keys(total)) total[k] += out.summary[k] || 0;
    perClass.push({ name: rec.name, empty: false, summary: out.summary, results: out.results });
  }
  dataOplog(user, '批量同步班级账号', `共 ${recs.length} 个班级：新建账号 ${total.created}，关联班级 ${total.linked}，跳过 ${total.skipped}，失败 ${total.failed}`);
  json(res, 200, { total: recs.length, summary: total, classes: perClass, missingNames });
});

// ==================== 账号生成（学生 / 教职工，初始密码首登强制修改） ====================
const STUDENT_GEN_ROLES = ['discipline', 'rights'];
const STAFF_GEN_ROLES = ['headTeacher', 'counselor'];

// 为学生生成账号：账号 = 学号，姓名自动带出，初始密码 = Hzpt@学号后六位
route('POST', '/api/accounts/generate/student', { roles: ['admin', 'collegeOfficer'] }, async ({ res, user, body }) => {
  const role = String(body.role || '');
  if (!STUDENT_GEN_ROLES.includes(role)) fail(400, '学生账号仅支持生成纪律委员或权益部角色');
  const className = String(body.className || '').trim();
  const studentId = String(body.studentId || '').trim();
  if (!className || !studentId) fail(400, '请选择班级与学生');
  const stu = store.db.students.find((s) => s.studentId === studentId && s.className === className);
  if (!stu) fail(400, '未在班级名单中找到该学生');
  const username = stu.studentId;
  if (store.db.users.some((u) => u.username === username)) fail(400, `学号 ${username} 已生成过账号，请勿重复创建`);
  const initialPassword = `Hzpt@${username.slice(-6)}`;
  const u = {
    id: uid('u'),
    username,
    name: stu.name,
    role,
    roles: [role],
    classes: role === 'discipline' ? [stu.className] : [],
    enabled: true,
    mustChangePassword: true,
    passwordHash: hashPassword(initialPassword),
    createdAt: nowISO(),
    createdBy: user.name,
  };
  store.db.users.push(u);
  store.save('users');
  json(res, 200, {
    user: sanitizeUser(u),
    initialPassword,
    hint: '请将账号与初始密码告知本人，首次登录时系统将引导其修改密码',
  });
});

// 为教职工生成账号：从教职工名单中选择工号，姓名与所带班级自动带入；初始密码 = Hzpt@工号
route('POST', '/api/accounts/generate/staff', { roles: ['admin', 'collegeOfficer'] }, async ({ res, user, body }) => {
  const role = String(body.role || '');
  if (!STAFF_GEN_ROLES.includes(role)) fail(400, '教职工账号仅支持生成班主任或辅导员角色');
  const staffId = String(body.staffId || '').trim();
  if (!staffId) fail(400, '请选择教职工工号');
  const st = store.db.staffs.find((x) => x.staffId === staffId);
  if (!st) fail(400, `教职工名单中不存在工号 ${staffId}，请先在"教职工名单"中添加`);
  const typeName = ROLE_NAMES[role];
  if (st.type !== typeName) fail(400, `工号 ${staffId}（${st.name}）的岗位为"${st.type}"，与所选角色"${typeName}"不符`);
  if (store.db.users.some((u) => u.username === staffId)) fail(400, `工号 ${staffId} 已生成过账号，请勿重复创建`);
  const initialPassword = `Hzpt@${staffId}`;
  const u = {
    id: uid('u'),
    username: staffId,
    name: st.name,
    role,
    roles: [role],
    classes: [...(st.classes || [])],
    enabled: true,
    mustChangePassword: true,
    passwordHash: hashPassword(initialPassword),
    createdAt: nowISO(),
    createdBy: user.name,
  };
  store.db.users.push(u);
  store.save('users');
  json(res, 200, {
    user: sanitizeUser(u),
    initialPassword,
    hint: '请将账号与初始密码告知本人，首次登录时系统将引导其修改密码',
  });
});

route('PUT', '/api/accounts/:id', { roles: ['admin', 'collegeOfficer'] }, async ({ res, user, params, body }) => {
  const u = store.db.users.find((x) => x.id === params.id);
  if (!u) fail(404, '账号不存在');
  // 防提权：collegeOfficer 不可修改特权角色（管理员/学院考勤负责老师）的账号，也不可把任何账号改为/加配特权角色
  const targetPrivileged = hasAnyRole(u, PRIVILEGED_ROLES);
  const submitPrivileged =
    (body.role !== undefined && PRIVILEGED_ROLES.includes(String(body.role || ''))) ||
    (Array.isArray(body.roles) && body.roles.some((r) => PRIVILEGED_ROLES.includes(String(r || ''))));
  if (hasRole(user, 'collegeOfficer') && (targetPrivileged || submitPrivileged)) {
    fail(403, '无权修改管理员或学院考勤负责老师的账号');
  }
  if (body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name) fail(400, '请输入姓名');
    u.name = name;
  }
  // 角色更换：支持 roles 数组（添加/更换/移除角色）或单个 role 字段（兼容旧客户端）
  if (body.roles !== undefined || body.role !== undefined) {
    let newRoles;
    if (body.roles !== undefined) {
      const validation = validateRoles(body.roles);
      if (validation.error) fail(400, validation.error);
      newRoles = validation.roles;
    } else {
      const role = String(body.role || '');
      if (!ROLE_NAMES[role]) fail(400, '角色不正确');
      newRoles = [role];
    }
    // 自我保护：管理员不能移除自己的管理员角色（防止误操作失去管理能力）
    if (u.id === user.id && hasRole(user, 'admin') && !newRoles.includes('admin')) {
      fail(400, '不能移除自己的管理员角色');
    }
    const oldRoles = rolesOf(u).slice();
    if (JSON.stringify(oldRoles) !== JSON.stringify(newRoles)) {
      u.roles = newRoles;
      u.role = newRoles[0]; // 首个角色为主角色（用于展示与旧逻辑兼容）
      dataOplog(user, '修改账号角色', `${u.username}（${u.name}）：${oldRoles.map((r) => ROLE_NAMES[r]).join('、')} → ${newRoles.map((r) => ROLE_NAMES[r]).join('、')}`);
    }
  }
  if (body.classes !== undefined) {
    // 修改58：可点名班级对所有账号开放（不限于纪律委员 / 权益部），按提交值如实落库。
    // 影响面说明：班主任 / 辅导员账号的 classes 同时决定 teacherScope 可见班级范围与
    // canManageClass 点名权限，二者均由管理员在「编辑账号」中显式授权；
    // 留空沿用既有兜底语义 = 不限制班级。
    const nextClasses = Array.isArray(body.classes)
      ? [...new Set(body.classes.map(String).filter(Boolean))]
      : [];
    const oldClasses = u.classes || [];
    if (JSON.stringify(oldClasses) !== JSON.stringify(nextClasses)) {
      dataOplog(
        user,
        '修改可点名班级',
        `${u.username}（${u.name}）：${oldClasses.join('、') || '不限'} → ${nextClasses.join('、') || '不限'}`
      );
    }
    u.classes = nextClasses;
  }
  if (body.enabled !== undefined) {
    if (u.id === user.id && body.enabled === false) fail(400, '不能停用自己的账号');
    u.enabled = body.enabled === true;
  }
  store.save('users');
  json(res, 200, { user: sanitizeUser(u) });
});

route('PUT', '/api/accounts/:id/password', { roles: ['admin', 'collegeOfficer'] }, async ({ res, user, params, body }) => {
  const u = store.db.users.find((x) => x.id === params.id);
  if (!u) fail(404, '账号不存在');
  // 防提权：collegeOfficer 不可重置特权角色账号的密码（否则可接管管理员账号）
  if (hasRole(user, 'collegeOfficer') && hasAnyRole(u, PRIVILEGED_ROLES)) fail(403, '无权重置管理员或学院考勤负责老师的密码');
  const password = String(body.password || '');
  if (password.length < 6) fail(400, '密码长度不能少于 6 位');
  u.passwordHash = hashPassword(password);
  // 管理员重置密码后，同样要求该用户下次登录时修改密码；此前签发的登录态一并失效
  u.mustChangePassword = true;
  u.pwdChangedAt = nowISO();
  store.save('users');
  json(res, 200, { ok: true });
});

route('DELETE', '/api/accounts/:id', { roles: ['admin', 'collegeOfficer'] }, async ({ res, user, params }) => {
  const idx = store.db.users.findIndex((x) => x.id === params.id);
  if (idx < 0) fail(404, '账号不存在');
  // 防提权：collegeOfficer 不可删除特权角色账号
  if (hasRole(user, 'collegeOfficer') && hasAnyRole(store.db.users[idx], PRIVILEGED_ROLES)) fail(403, '无权删除管理员或学院考勤负责老师的账号');
  if (store.db.users[idx].id === user.id) fail(400, '不能删除自己的账号');
  const delU = store.db.users[idx];
  store.db.users.splice(idx, 1);
  store.save('users');
  dataOplog(user, '删除账号', `${delU.username}（${delU.name}），原角色：${rolesOf(delU).map((r) => ROLE_NAMES[r]).join('、')}`);
  json(res, 200, { ok: true });
});

// ==================== 班级名单管理 ====================
route('GET', '/api/students', { roles: ['admin', 'rights', 'collegeOfficer'] }, async ({ res, query }) => {
  let list = store.db.students.slice();
  // 修改69：年级归一化匹配（原本是精确字符串相等）。
  // 前端年级下拉自修改60 起统一传归一化值「YYYY级」，而库里可能存「2025」，
  // 精确相等会一条都查不出来（级联选中年级后列表恒空）。故两侧都归一化后再比较。
  if (query.grade) {
    const g = normGrade(query.grade);
    list = list.filter((s) => normGrade(s.grade) === g);
  }
  if (query.className) list = list.filter((s) => s.className === query.className);
  if (query.q) {
    const q = query.q.trim();
    list = list.filter((s) => [s.name, s.studentId, s.disciplineMember, s.counselor, s.classTeacher].some((v) => String(v || '').includes(q)));
  }
  list.sort((a, b) => a.className.localeCompare(b.className, 'zh') || a.studentId.localeCompare(b.studentId));
  // 修改72：读时用「班级管理」权威源覆盖三岗位（学生表字段降为只读镜像）。
  // 只影响返回视图、不落盘 —— 即便历史学生记录未同步，班级名单页也显示班级管理的值。
  const viewList = list.map((s) => {
    const p = classPostsOf(s.className);
    if (!p) return s;
    const out = { ...s };
    for (const k of ['disciplineMember', 'counselor', 'classTeacher']) if (p[k]) out[k] = p[k];
    return out;
  });
  json(res, 200, paginate(viewList, query.page, query.pageSize));
});

route('POST', '/api/students', { roles: ['admin', 'rights', 'collegeOfficer'] }, async ({ res, user, body }) => {
  const className = String(body.className || '').trim();
  const name = String(body.name || '').trim();
  const studentId = String(body.studentId || '').trim();
  if (!className || !name || !studentId) fail(400, '班级、姓名、学号为必填项');
  // 修改73：班级准入 —— 未登记班级不再自动建档，直接拒绝并给出可定位的原因
  const gate = checkClassRegistered(className);
  if (!gate.ok) fail(400, gate.reason);
  if (store.db.students.some((s) => normClassName(s.className).toLowerCase() === gate.name.toLowerCase() && s.studentId === studentId)) fail(400, '该班级下已存在相同学号的学生');
  const stu = {
    id: uid('stu'),
    className: gate.name,
    name,
    studentId,
    grade: String(body.grade || '').trim(),
    disciplineMember: String(body.disciplineMember || '').trim(),
    counselor: String(body.counselor || '').trim(),
    classTeacher: String(body.classTeacher || '').trim(),
  };
  // 修改72：三岗位以「班级管理」为权威源（只读镜像）
  applyClassPosts(stu);
  store.db.students.push(stu);
  store.save('students');
  json(res, 200, { student: stu });
});

route('POST', '/api/students/import', { roles: ['admin', 'rights', 'collegeOfficer'] }, async ({ res, user, body }) => {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) fail(400, '没有可导入的数据');
  const errors = [];
  const notices = [];
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;

  // 修改74：逐条校验、逐条处理 —— 班级不匹配的行**跳过该条并继续**，不再整批中止
  // （修改73 的"任一行不匹配即零写入"在真实名单里过于严苛：一个班名写法差异会挡住其余全部数据）。
  // 跳过行汇入 errors（含行号 + 班级名 + 原因），导入结束后由前端汇总展示；
  // 其余校验规则不变：班级 / 姓名 / 学号必填，统计口径与真实写库严格一致（修改73）。
  rows.forEach((r, idx) => {
    const rowNo = idx + 2; // 模板首行为表头
    const rawClass = String(r['班级'] || '').trim();
    const name = String(r['姓名'] || '').trim();
    const studentId = String(r['学号'] || '').trim();
    if (!rawClass || !name || !studentId) {
      errors.push({ row: rowNo, message: `班级、姓名、学号为必填，该行已跳过（表中班级「${normClassName(rawClass) || '空'}」）` });
      skipped++;
      return;
    }
    // 班级准入：班级名必须已在「班级管理」中登记；不匹配 → 跳过该条
    const gate = checkClassRegistered(rawClass);
    if (!gate.ok) {
      errors.push({ row: rowNo, message: `班级不存在或未匹配（班级管理中没有「${gate.name || normClassName(rawClass)}」），该行已跳过；请核对班级名称，或先在「班级管理」中登记该班级` });
      skipped++;
      return;
    }
    const className = gate.name;
    if (normClassName(rawClass) !== className) {
      notices.push({ row: rowNo, message: `班级「${normClassName(rawClass)}」已按班级管理中的「${className}」导入（空格 / 大小写差异已自动校正）` });
    }
    // 修改75：匹配策略（防"更新名单被当成新增插入"）——
    // ① 班级 + 学号 精确匹配（主键口径，不变）；
    // ② 未命中时按 班级 + 姓名 兜底：名单更正常见于学号更正（如 2017002304 → 2017002504），
    //    若仍只按学号匹配，会把更正后的行当成新学生插入，出现"一人两条"重复记录。
    //    同班同名恰好一条 → 视为同一学生，做字段级更新（学号随名单更正）；
    //    同班同名多条 → 无法唯一判定更新目标，跳过该条并提示先手工处理重复。
    let exist = store.db.students.find(
      (s) => normClassName(s.className).toLowerCase() === className.toLowerCase() && s.studentId === studentId
    );
    if (!exist) {
      const sameName = store.db.students.filter(
        (s) => normClassName(s.className).toLowerCase() === className.toLowerCase() && String(s.name || '').trim() === name
      );
      if (sameName.length === 1) {
        exist = sameName[0];
        notices.push({ row: rowNo, message: `表中学号「${studentId}」在名单中不存在，已按同班同名匹配到学号「${exist.studentId}」的记录并更新（视为学号更正，未新增）` });
      } else if (sameName.length > 1) {
        errors.push({ row: rowNo, message: `班级「${className}」下存在 ${sameName.length} 条同名记录（学号：${sameName.map((s) => s.studentId).join('、')}），无法判定更新目标，该行已跳过；请先在名单中手工处理重复后再导入` });
        skipped++;
        return;
      }
    }
    // 三岗位：班级管理为权威源；班级管理未登记该岗位时，表格留空 = 保留库中原值（绝不清空）
    const posts = classPostsOf(className) || {};
    const tbl = {
      disciplineMember: String(r['纪律委员'] || '').trim(),
      counselor: String(r['辅导员'] || '').trim(),
      classTeacher: String(r['班主任'] || '').trim(),
    };
    const next = {
      className,
      studentId,
      name,
      grade: String(r['年级'] || '').trim() || (exist ? exist.grade || '' : ''),
    };
    for (const k of ['disciplineMember', 'counselor', 'classTeacher']) {
      if (posts[k]) {
        next[k] = posts[k];
        if (tbl[k] && tbl[k] !== posts[k]) {
          notices.push({ row: rowNo, message: `「${POST_LABEL[k]}」以班级管理中维护的「${posts[k]}」为准（表中为「${tbl[k]}」，已忽略）` });
        }
      } else {
        next[k] = tbl[k] || (exist ? exist[k] || '' : '');
      }
    }
    if (exist) {
      const diff = [];
      for (const k of Object.keys(next)) {
        if (String(exist[k] || '') !== String(next[k] || '')) {
          exist[k] = next[k];
          diff.push(k === 'studentId' ? '学号' : (POST_LABEL[k] || k));
        }
      }
      if (diff.length) updated++;
      else unchanged++;
    } else {
      store.db.students.push({ id: uid('stu'), ...next });
      inserted++;
    }
  });
  if (inserted || updated) store.save('students');
  dataOplog(user, '批量导入班级名单', `共 ${rows.length} 条，新增 ${inserted}，更新 ${updated}，无变化 ${unchanged}，跳过 ${skipped}`);
  json(res, 200, {
    total: rows.length, inserted, updated, unchanged, skippedRows: skipped, failed: errors.length,
    errors: errors.slice(0, 20), errorsCount: errors.length,
    notices: notices.slice(0, 20), noticesCount: notices.length,
  });
});

route('PUT', '/api/students/:id', { roles: ['admin', 'rights', 'collegeOfficer'] }, async ({ res, params, body }) => {
  const stu = store.db.students.find((s) => s.id === params.id);
  if (!stu) fail(404, '学生不存在');
  const className = String(body.className ?? stu.className).trim();
  const name = String(body.name ?? stu.name).trim();
  const studentId = String(body.studentId ?? stu.studentId).trim();
  if (!className || !name || !studentId) fail(400, '班级、姓名、学号为必填项');
  // 修改73：班级准入 —— 与批量导入同一口径，未登记班级拒绝（不再自动建档）
  const gate = checkClassRegistered(className);
  if (!gate.ok) fail(400, gate.reason);
  if (store.db.students.some((s) => s.id !== stu.id && normClassName(s.className).toLowerCase() === gate.name.toLowerCase() && s.studentId === studentId)) fail(400, '该班级下已存在相同学号的学生');
  Object.assign(stu, {
    className: gate.name,
    name,
    studentId,
    grade: String(body.grade ?? stu.grade ?? '').trim(),
    disciplineMember: String(body.disciplineMember ?? stu.disciplineMember).trim(),
    counselor: String(body.counselor ?? stu.counselor).trim(),
    classTeacher: String(body.classTeacher ?? stu.classTeacher).trim(),
  });
  // 修改72：三岗位以「班级管理」为权威源（只读镜像）
  applyClassPosts(stu);
  store.save('students');
  json(res, 200, { student: stu });
});

route('POST', '/api/students/batch-delete', { roles: ['admin', 'rights', 'collegeOfficer'] }, async ({ res, body }) => {
  const ids = new Set(Array.isArray(body.ids) ? body.ids.map(String) : []);
  if (!ids.size) fail(400, '请先选择要删除的学生');
  const before = store.db.students.length;
  store.db.students = store.db.students.filter((s) => !ids.has(s.id));
  const deleted = before - store.db.students.length;
  if (deleted) store.save('students');
  json(res, 200, { deleted });
});

// 修改76：清空班级名单 —— 仅删除 students 集合数据（可按班级或全部），不触碰登录账号 /
// 考勤 / 假单 / 班级管理等任何其他集合（需求：清空范围仅限班级名单数据）。
// 幂等：名单已为空时返回 deleted:0，不报错。
route('POST', '/api/students/clear', { roles: ['admin', 'collegeOfficer'] }, async ({ res, user, body }) => {
  const className = String((body && body.className) || '').trim();
  let target;
  let scope;
  if (className) {
    const key = normClassName(className).toLowerCase();
    target = store.db.students.filter((s) => normClassName(s.className).toLowerCase() === key);
    scope = className;
  } else {
    target = store.db.students;
    scope = '全部班级';
  }
  const ids = new Set(target.map((s) => s.id));
  if (ids.size) {
    store.db.students = store.db.students.filter((s) => !ids.has(s.id));
    store.save('students');
  }
  dataOplog(user, '清空班级名单', `${scope}：删除 ${ids.size} 名学生的名单数据（不影响登录账号）`);
  json(res, 200, { deleted: ids.size, scope });
});

route('DELETE', '/api/students/:id', { roles: ['admin', 'rights', 'collegeOfficer'] }, async ({ res, params }) => {
  const idx = store.db.students.findIndex((s) => s.id === params.id);
  if (idx < 0) fail(404, '学生不存在');
  store.db.students.splice(idx, 1);
  store.save('students');
  json(res, 200, { ok: true });
});

// ==================== 考勤点名 ====================
// 班级学生名单（点名页用；纪律委员仅限本班）。
// 传入 date + periods 时，返回每位学生的假单覆盖预填信息（leaveCovered / leaveNote），
// 发起点名时被已通过假单覆盖的学生将自动显示为"请假"。
route('GET', '/api/attendance/roster', {}, async ({ res, user, query }) => {
  const className = String(query.className || '');
  if (!className) fail(400, '请选择班级');
  if (!canManageClass(user, className)) fail(403, '你没有该班级的点名权限');
  const date = normDate(query.date);
  const periods = String(query.periods || '')
    .split(',')
    .map((x) => x.trim())
    .filter((p) => PERIODS.includes(p));
  const cfg = store.getPeriodTimes();
  const useLeave = !!(date && periods.length);
  const students = store.db.students
    .filter((s) => s.className === className)
    .sort((a, b) => a.studentId.localeCompare(b.studentId))
    .map((s) => {
      let leaveCovered = false;
      let leaveNote = '';
      if (useLeave) {
        for (const lv of store.db.leaves) {
          if (lv.className !== className) continue;
          const { s: ds, e: de } = leaveRange(lv);
          if (!(ds && de && date >= ds && date <= de)) continue;
          if (!studentMatch(lv, s.studentId, s.name)) continue;
          const covered = periodsCoveredByLeaveOn(lv, date, cfg).filter((p) => periods.includes(p));
          if (covered.length) {
            leaveCovered = true;
            leaveNote = `假单·${lv.type}：${lv.reason}`;
            break;
          }
        }
      }
      return { id: s.id, className: s.className, name: s.name, studentId: s.studentId, leaveCovered, leaveNote };
    });
  json(res, 200, { students });
});

/** 只读角色（班主任 / 辅导员）的数据范围：配置了所带班级则按班级过滤，未配置则不限制 */
function teacherScope(user) {
  const rs = rolesOf(user);
  // 拥有学院级角色（管理员/权益部/学院考勤负责老师）时不做班级过滤（合并权限取最大可见范围）
  if (rs.some((r) => r === 'admin' || r === 'rights' || r === 'collegeOfficer')) return null;
  if (rs.includes('headTeacher') || rs.includes('counselor')) {
    const cls = user.classes || [];
    return cls.length ? cls : null;
  }
  return null;
}

route('GET', '/api/attendance', {}, async ({ res, user, query }) => {
  let list = store.db.attendance.slice();
  const scope = teacherScope(user);
  // 纪律委员仅见其班级点名记录（若同时拥有学院级角色则按全院范围，合并权限取最大可见）
  if (hasRole(user, 'discipline') && !hasAnyRole(user, ['admin', 'rights', 'collegeOfficer'])) {
    list = list.filter((s) => (user.classes || []).includes(s.className));
  }
  if (scope) list = list.filter((s) => scope.includes(s.className));
  if (query.className) list = list.filter((s) => s.className === query.className);
  if (query.from) list = list.filter((s) => s.date >= query.from);
  if (query.to) list = list.filter((s) => s.date <= query.to);
  if (query.q) {
    const q = query.q.trim();
    list = list.filter((s) => [s.courseName, s.teacher, s.createdBy].some((v) => String(v || '').includes(q)));
  }
  list.sort((a, b) => b.date.localeCompare(a.date) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const page = paginate(list.map(sessionSummary), query.page, query.pageSize);
  json(res, 200, page);
});

route('GET', '/api/attendance/:id', {}, async ({ res, user, params }) => {
  const s = store.db.attendance.find((x) => x.id === params.id);
  if (!s) fail(404, '点名记录不存在');
  if (hasRole(user, 'discipline') && !hasAnyRole(user, ['admin', 'rights', 'collegeOfficer']) && !(user.classes || []).includes(s.className)) fail(403, '没有权限查看该记录');
  // 修改80：signatureRef → signature(dataUri) 回填，响应形状与改造前一致
  json(res, 200, { session: { ...attachments.hydrateAttendance(s), counts: sessionCounts(s) } });
});

// ==================== 修改81：考勤修改日志查询（时间线数据源） ====================
// 查看权限与点名详情接口完全一致（纯纪律委员限本班，其余可查看详情的角色均可看）。
// 按时间倒序返回；修改人账号按查看角色脱敏：管理员 / 权益部 / 学院考勤负责老师
// （可更正考勤的角色）明文；只读角色（纪律委员 / 班主任 / 辅导员）账号打星且不回传
// 操作人 id —— 服务端脱敏，不依赖前端自觉。字段脱敏边界：学生姓名 / 学号 / 状态 / 备注
// 与详情页明细表同口径展示，不额外打星（打星反而与上方明细对不上）。
route('GET', '/api/attendance/:id/logs', {}, async ({ res, user, params }) => {
  const s = store.db.attendance.find((x) => x.id === params.id);
  if (!s) fail(404, '点名记录不存在');
  if (hasRole(user, 'discipline') && !hasAnyRole(user, ['admin', 'rights', 'collegeOfficer']) && !(user.classes || []).includes(s.className)) fail(403, '没有权限查看该记录');
  const privileged = hasAnyRole(user, ['admin', 'rights', 'collegeOfficer']);
  const logs = (store.db.attendanceLogs || [])
    .filter((l) => l.sessionId === params.id)
    .sort((a, b) => String(b.at).localeCompare(String(a.at))) // 时间倒序；同毫秒由稳定排序保持写入序
    .slice(0, ATT_LOG_LIMIT)
    .map((l) => {
      if (privileged) return l;
      const op = l.operator || {};
      return {
        ...l,
        operator: { ...op, id: undefined, username: op.username ? maskAccount(op.username) : op.username },
      };
    });
  json(res, 200, { masked: !privileged, logs });
});

route('POST', '/api/attendance', { roles: ['discipline', 'admin', 'rights', 'collegeOfficer'] }, async ({ res, user, body }) => {
  const className = String(body.className || '').trim();
  const date = String(body.date || '');
  const periods = Array.isArray(body.periods) ? body.periods.filter((p) => PERIODS.includes(p)) : [];
  const courseName = String(body.courseName || '').trim();
  const teacher = String(body.teacher || '').trim();
  if (!className) fail(400, '请选择班级');
  if (!canManageClass(user, className)) fail(403, '你没有该班级的点名权限');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(400, '请选择上课日期');
  if (!periods.length) fail(400, '请至少选择一个节次');
  if (!courseName) fail(400, '请输入课程名称');
  const roster = store.db.students.filter((s) => s.className === className);
  if (!roster.length) fail(400, '该班级暂无学生名单，请先在"班级名单"中导入');

  const key = sortPeriods(periods).join(',');
  const dup = store.db.attendance.find(
    (s) => s.className === className && s.date === date && sortPeriods(s.periods).join(',') === key
  );
  if (dup) return json(res, 409, { message: `该班级在 ${date} 已存在相同时段（${key}）的点名记录，请直接编辑该记录`, existingId: dup.id });

  const input = new Map((Array.isArray(body.items) ? body.items : []).map((it) => [String(it.studentId), it]));
  const items = roster
    .sort((a, b) => a.studentId.localeCompare(b.studentId))
    .map((s) => {
      const it = input.get(s.studentId) || {};
      return {
        studentId: s.studentId,
        name: s.name,
        status: STATUSES.includes(it.status) ? it.status : '出勤',
        note: String(it.note || '').slice(0, 100),
      };
    });
  const now = nowISO();
  const session = {
    id: uid('att'),
    className,
    date,
    periods: sortPeriods(periods),
    courseName,
    teacher,
    items,
    createdBy: user.name,
    createdById: user.id,
    createdAt: now,
    updatedBy: user.name,
    updatedAt: now,
    confirmToken: uid('ctk') + uid('ctk').slice(4),
    confirmStatus: 'pending',
  };
  store.db.attendance.push(session);
  // 修改81：日志 ① 发起点名（发起人 + 初始四态概况；取假单复核前的原始提交状态）
  const preReconcile = session.items.map((it) => ({ ...it }));
  appendAttendanceLog({
    id: uid('alog'),
    sessionId: session.id,
    action: 'create',
    at: now,
    operator: attendanceLogOperator(user),
    summary: { total: preReconcile.length, counts: sessionCounts({ items: preReconcile }) },
  });
  // 保存后即时套用该班当天已通过假单（覆盖节次缺勤→请假，未覆盖请假→缺勤）
  beginAttendanceLogCapture();
  const touched = reconcileLeavesForSession(session);
  endAttendanceLogCapture(); // 修改81：对账改判落「假单自动校正」system 日志
  store.save('attendance');
  store.save('attendanceLogs');
  if (touched) store.save('leaves');
  // 修改30：点名提交改变缺勤节数 → 重算相关学生处分
  recalcPunishmentsByPairs(session.items.map((it) => ({ className: session.className, studentId: it.studentId })));
  json(res, 200, { session: { ...session, counts: sessionCounts(session) } });
});

// 点名记录提交后锁定：纪律委员仅可查看；权益部 / 管理员 / 学院考勤负责老师可单独修改学生考勤状态；班主任 / 辅导员只读
route('PUT', '/api/attendance/:id', {}, async ({ res, user, params, body }) => {
  const s = store.db.attendance.find((x) => x.id === params.id);
  if (!s) fail(404, '点名记录不存在');
  const canCorrect = hasAnyRole(user, ['admin', 'rights', 'collegeOfficer']);
  if (hasRole(user, 'discipline') && !canCorrect) {
    return json(res, 423, { message: '纪律委员提交点名后记录锁定为只读，仅可查看；考勤状态更正由权益部 / 管理员或假单导入完成' });
  }
  if (!canCorrect && (hasRole(user, 'headTeacher') || hasRole(user, 'counselor'))) {
    return json(res, 403, { message: '班主任 / 辅导员为只读角色，仅可查看考勤记录' });
  }
  if (!Array.isArray(body.items) || !body.items.length) fail(400, '请提供要修改的考勤条目');
  // 修改81：人工修改前快照（与假单复核区分：本段 diff = 操作人的真实改动）
  const beforeUser = s.items.map((it) => ({ ...it }));
  const map = new Map(s.items.map((it) => [it.studentId, it]));
  let changed = 0;
  for (const it of body.items) {
    const base = map.get(String(it.studentId));
    if (!base) continue;
    if (it.status !== undefined && STATUSES.includes(it.status) && base.status !== it.status) {
      base.status = it.status;
      changed++;
    }
    if (it.note !== undefined) {
      const note = String(it.note).slice(0, 100);
      if (note !== base.note) {
        base.note = note;
        changed++;
      }
    }
  }
  const now = nowISO();
  s.updatedBy = user.name;
  s.updatedAt = now;
  // 修改81：日志 ② 人工修改（仅存在真实字段变更时写入，避免空保存刷日志）
  const userChanges = diffAttendanceItems(beforeUser, s.items);
  if (userChanges.length) {
    appendAttendanceLog({
      id: uid('alog'),
      sessionId: s.id,
      action: 'update',
      at: now,
      operator: attendanceLogOperator(user),
      changes: userChanges,
    });
    store.save('attendanceLogs');
  }
  // 任课老师只需在下课后签字确认一次；考勤记录被人工修改后，确认状态保持有效，无需重新确认。
  // 保存后即时套用该班当天已通过假单（覆盖节次的缺勤仍会被自动改为请假）
  beginAttendanceLogCapture();
  const touchedLeaves = reconcileLeavesForSession(s);
  endAttendanceLogCapture(); // 修改81：对账改判落「假单自动校正」system 日志
  store.save('attendance');
  if (touchedLeaves) store.save('leaves');
  // 修改30：更正考勤状态改变缺勤节数 → 重算相关学生处分
  recalcPunishmentsByPairs(s.items.map((it) => ({ className: s.className, studentId: it.studentId })));
  json(res, 200, { session: { ...s, counts: sessionCounts(s) } });
});

// 点名记录提交后锁定：管理员可删除；其他角色不可删除
route('DELETE', '/api/attendance/:id', { roles: ['admin'] }, async ({ res, params }) => {
  const idx = store.db.attendance.findIndex((x) => x.id === params.id);
  if (idx < 0) fail(404, '点名记录不存在');
  // 修改30：删除前先记下涉及学生，删除后重算其处分（缺勤节数会回落）
  const affected = store.db.attendance[idx].items.map((it) => ({ className: store.db.attendance[idx].className, studentId: it.studentId }));
  pruneAttendanceLogs([store.db.attendance[idx].id]); // 修改81：同步清理该记录的修改日志
  store.db.attendance.splice(idx, 1);
  store.save('attendance');
  recalcPunishmentsByPairs(affected);
  json(res, 200, { ok: true });
});

// 管理员批量删除点名记录
route('POST', '/api/attendance/batch-delete', { roles: ['admin'] }, async ({ res, body }) => {
  const ids = new Set((Array.isArray(body.ids) ? body.ids : []).map(String));
  if (!ids.size) fail(400, '请先选择要删除的点名记录');
  // 修改30：删除前先记下涉及学生，删除后重算其处分
  const affected = store.db.attendance.filter((s) => ids.has(s.id)).flatMap((s) => s.items.map((it) => ({ className: s.className, studentId: it.studentId })));
  const before = store.db.attendance.length;
  store.db.attendance = store.db.attendance.filter((s) => !ids.has(s.id));
  const deleted = before - store.db.attendance.length;
  if (deleted) {
    store.save('attendance');
    pruneAttendanceLogs([...ids]); // 修改81：同步清理被删记录的修改日志
  }
  recalcPunishmentsByPairs(affected);
  json(res, 200, { deleted });
});

// ==================== 任课老师免登录签字确认 ====================
// 通过确认链接中的令牌定位记录（无需登录账号）
route('GET', '/api/confirm/:token', { public: true }, async ({ res, params }) => {
  const s = store.db.attendance.find((x) => x.confirmToken === params.token);
  if (!s) fail(404, '确认链接无效或记录已被删除');
  json(res, 200, {
    confirmed: s.confirmStatus === 'confirmed',
    record: {
      className: s.className,
      date: s.date,
      periods: s.periods,
      courseName: s.courseName,
      teacher: s.teacher,
      counts: sessionCounts(s),
      total: s.items.length,
      createdBy: s.createdBy,
      items: s.items.map(({ studentId, name, status, note }) => ({ studentId, name, status, note })),
    },
    confirm: s.confirmStatus === 'confirmed'
      ? { name: s.confirmedName, at: s.confirmedAt, signature: s.signatureRef ? attachments.toDataUri(s.signatureRef) : s.signature || '' }
      : null,
  });
});

// 任课老师提交签字确认（无需登录；链接令牌即凭证）
route('POST', '/api/confirm/:token', { public: true }, async ({ res, params, body }) => {
  const s = store.db.attendance.find((x) => x.confirmToken === params.token);
  if (!s) fail(404, '确认链接无效或记录已被删除');
  if (s.confirmStatus === 'confirmed') fail(400, '该记录已确认过，无需重复确认');
  const name = String(body.name || '').trim();
  const signature = String(body.signature || '');
  if (!name) fail(400, '请填写确认人姓名');
  if (!signature.startsWith('data:image/png;base64,')) fail(400, '请完成手写签名');
  if (signature.length > 200 * 1024) fail(400, '签名图片过大，请重新签名');
  // 修改80：签名外置为内容寻址文件（data/attachments/<sha256>），记录只存引用，避免备份包随点名线性膨胀
  const sigRef = attachments.putDataUri(signature);
  if (!sigRef) fail(400, '签名图片格式非法，请重新签名');
  s.confirmStatus = 'confirmed';
  s.confirmedName = name;
  s.confirmedAt = nowISO();
  s.signatureRef = sigRef;
  delete s.signature; // 清理可能残留的旧内嵌字段
  // 修改81：签字确认同样属于记录变更 → 落日志（确认人免登录无账号，external 标记）
  appendAttendanceLog({
    id: uid('alog'),
    sessionId: s.id,
    action: 'confirm',
    at: s.confirmedAt,
    operator: { id: '', username: '', name, roles: [], external: true },
    changes: [{ field: 'confirmStatus', before: '待确认', after: '已确认' }],
  });
  store.save('attendance');
  store.save('attendanceLogs');
  json(res, 200, { ok: true, confirmedName: name, confirmedAt: s.confirmedAt });
});

// ==================== 假单管理 ====================
route('GET', '/api/leaves', { roles: ['admin', 'rights', 'collegeOfficer'] }, async ({ res, query }) => {
  let list = store.db.leaves.slice();
  if (query.status) list = list.filter((l) => l.status === query.status);
  if (query.classNames) {
    // 班级多选筛选（逗号分隔）
    const set = new Set(String(query.classNames).split(',').map((x) => x.trim()).filter(Boolean));
    if (set.size) list = list.filter((l) => set.has(l.className));
  }
  if (query.q) {
    const q = query.q.trim();
    list = list.filter((l) => [l.studentName, l.studentId, l.className, l.reason, l.type].some((v) => String(v || '').includes(q)));
  }
  list.sort((a, b) => String(b.importedAt).localeCompare(String(a.importedAt)));
  const stats = {
    pending: store.db.leaves.filter((l) => l.status === '待生效').length,
    applied: store.db.leaves.filter((l) => l.status === '已生效').length,
  };
  json(res, 200, { ...paginate(list, query.page, query.pageSize), stats });
});

/**
 * 假单导入核心：逐行校验 → 创建假单 → 触发双向考勤对账。
 * 行对象支持 _row（源文件行号，用于错误提示）。
 * 兼容三类字段写法：
 * - 新模板：请假开始日期 + 请假结束日期 + 请假开始时间 + 请假结束时间
 * - 旧模板：请假日期（单日）+ 请假开始/结束时间
 * - 更早模板：请假日期 + 节次
 */
function importLeaveRows(rows, user, initialErrors = []) {
  const errors = [...initialErrors];
  const duplicates = [];
  const notices = [];
  const created = [];
  const cellDate = (v) => {
    if (typeof v === 'number') return (xlsx.cellToDateTime(v) || {}).date || '';
    return v;
  };
  const cellTime = (v) => {
    if (typeof v === 'number') return (xlsx.cellToDateTime(v) || {}).time || '';
    return v;
  };
  rows.forEach((r, idx) => {
    const rowNo = r._row || idx + 2;
    const name = String(r['姓名'] ?? '').trim();
    const sid = String(r['学号'] ?? '').trim();
    // 仅校验学号与姓名是否在班级名单中（班级名称可能存在不一致表述，以名单为准）
    if (!name || !sid) return errors.push({ row: rowNo, message: '姓名、学号为必填' });
    const m = matchLeaveStudent(sid, name, String(r['班级'] ?? '').trim());
    if (m.error) return errors.push({ row: rowNo, message: m.error });
    if (m.notice) notices.push({ row: rowNo, message: m.notice });
    const stu = m.stu;

    // 日期（支持 Excel 日期单元格 / 2026-09-24 / 2026/9/24 / 2026年9月24日）
    let startDate = normDate(cellDate(r['请假开始日期']));
    let endDate = normDate(cellDate(r['请假结束日期']));
    if (!startDate) startDate = normDate(cellDate(r['请假日期']));
    if (startDate && !endDate) endDate = startDate;
    if (!startDate) return errors.push({ row: rowNo, message: '请假开始日期缺失或格式不正确' });
    if (endDate < startDate) return errors.push({ row: rowNo, message: `请假结束日期（${endDate}）早于开始日期（${startDate}）` });
    if (new Date(`${endDate}T00:00:00`) - new Date(`${startDate}T00:00:00`) > 31 * 86400000) {
      return errors.push({ row: rowNo, message: '请假跨度超过 31 天，请拆分后导入' });
    }

    // 时间（支持 Excel 时间单元格 / 08:00 / 8:30:00）
    let timeStart = normTime(cellTime(r['请假开始时间']));
    let timeEnd = normTime(cellTime(r['请假结束时间']));
    // 仅同一天内才要求结束时间晚于开始时间；跨天假单（如 27 日 22:00 请到 28 日 15:00）时间倒挂是正常的
    if (timeStart && timeEnd && timeStart >= timeEnd && endDate === startDate) {
      return errors.push({ row: rowNo, message: `请假时间段 ${timeStart}~${timeEnd} 无效：同一天的请假开始时间需早于结束时间` });
    }
    if ((timeStart && !timeEnd) || (!timeStart && timeEnd)) {
      return errors.push({ row: rowNo, message: '请假开始时间与结束时间需成对填写' });
    }
    let periods = [];
    if (!timeStart || !timeEnd) {
      const jieci = String(r['节次'] ?? '').trim();
      if (!jieci) return errors.push({ row: rowNo, message: '请填写请假开始时间与结束时间（旧模板可填节次）' });
      const np = normPeriods(jieci);
      if (np.error) return errors.push({ row: rowNo, message: np.error });
      periods = np.periods;
    }

    // 去重：同一学生 + 相同请假时间段（起止日期 + 起止时间）的记录已存在则跳过
    const dup = [...store.db.leaves, ...created].find(
      (lv) =>
        (lv.studentId || '') === stu.studentId &&
        (lv.startDate || lv.date || '') === startDate &&
        (lv.endDate || lv.date || startDate) === endDate &&
        (lv.timeStart || '') === (timeStart || '') &&
        (lv.timeEnd || '') === (timeEnd || '')
    );
    if (dup) {
      return duplicates.push({
        row: rowNo,
        message: `${stu.name} 的这条请假记录已存在（${startDate} ~ ${endDate}${timeStart ? ` ${timeStart}~${timeEnd}` : ''}），已跳过`,
      });
    }

    created.push({
      id: uid('lv'),
      className: stu.className,
      studentName: stu.name,
      studentId: stu.studentId,
      grade: stu.grade || '',
      periods,
      startDate,
      endDate,
      timeStart: timeStart || '',
      timeEnd: timeEnd || '',
      coveredPeriods: [],
      effectivePeriods: [],
      type: normLeaveType(r['假别']),
      reason: String(r['事由'] ?? '').trim() || '—',
      status: '待生效',
      remark: '',
      appliedCount: 0,
      appliedTo: [],
      importedBy: user.name,
      importedAt: nowISO(),
    });
  });
  let appliedLeaves = 0;
  let revertedTotal = 0;
  // 修改81：捕获整批导入的对账改判 → 每个变更会话合并为一条「假单自动校正」日志
  beginAttendanceLogCapture();
  for (const lv of created) {
    store.db.leaves.push(lv);
    const r2 = reconcileLeaveAllDays(lv);
    if (lv.status === '已生效') appliedLeaves++;
    revertedTotal += r2.reverted;
  }
  endAttendanceLogCapture();
  store.save('leaves');
  store.save('attendance');
  // 修改30：假单对账改判影响缺勤节数 → 重算导入涉及学生的处分
  recalcPunishmentsByPairs(created.map((lv) => ({ className: lv.className, studentId: lv.studentId })));
  return {
    total: rows.length + initialErrors.length,
    imported: created.length,
    applied: appliedLeaves,
    reverted: revertedTotal,
    failed: errors.length,
    duplicates: duplicates.length,
    noticesCount: notices.length,
    notices: notices.slice(0, 20),
    errors: errors.slice(0, 20),
    duplicateDetails: duplicates.slice(0, 20),
  };
}

route('POST', '/api/leaves/import', { roles: ['admin', 'rights', 'collegeOfficer'] }, async ({ res, user, body }) => {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) fail(400, '没有可导入的数据');
  json(res, 200, importLeaveRows(rows, user));
});

/**
 * 导入系统请假数据（外部系统导出的 Excel）：
 * 字段映射：学号/班级/姓名 原样对应；请假开始时间 → 请假开始日期 + 开始时间；
 * 请假结束时间 → 请假结束日期 + 结束时间（兼容合并列与拆分列两种格式）；请假类型 → 假别；
 * 请假事由 → 事由（新表格可无此列，事由留空，不报错不跳行）。
 * 审批状态：表格无"审批/审核状态"列 → 默认"已通过"；列存在但值为空 → 亦按"已通过"；
 * 仅明确标注非"已通过"（未通过/待审核等）才跳过。
 * 日期用 Excel 日期序列号或常见文本格式均可；有日期缺时间按 开始 00:00 / 结束 23:59 兜底。
 */
route('POST', '/api/leaves/import-system', { roles: ['admin', 'rights', 'collegeOfficer'] }, async ({ res, user, body }) => {
  let buf;
  try {
    buf = Buffer.from(String(body.dataBase64 || ''), 'base64');
  } catch {
    fail(400, '文件数据无效');
  }
  if (!buf || buf.length < 100) fail(400, '文件内容为空或不是有效的 xlsx 文件');
  let grid;
  try {
    grid = xlsx.parseXlsxRows(buf);
  } catch (e) {
    fail(400, `Excel 解析失败：${e.message}`);
  }
  // 定位表头行（允许前若干行为说明文字）。
  // 兼容两种格式：
  // - 旧版：请假开始时间 / 请假结束时间（日期时间合并列）
  // - 新版：请假开始日期 + 开始时间、请假结束日期 + 结束时间（拆分列）
  let headerIdx = -1;
  for (let i = 0; i < Math.min(10, grid.length); i++) {
    const texts = grid[i].map((c) => String(c ?? '').trim());
    const startOk = texts.includes('请假开始时间') || (texts.includes('请假开始日期') && texts.includes('开始时间'));
    const endOk = texts.includes('请假结束时间') || (texts.includes('请假结束日期') && texts.includes('结束时间'));
    if (texts.includes('学号') && startOk && endOk) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) fail(400, '未找到系统导出表头（需包含：学号、姓名、班级，以及"请假开始时间/请假结束时间"，或拆分后的"请假开始日期+开始时间/请假结束日期+结束时间"）');
  const headers = grid[headerIdx].map((h) => String(h ?? '').trim());
  // 字段定位（支持别名；列缺失返回 -1，不报错）：
  // 假别=「假别/请假类型」；事由=「事由/请假事由」（新表格可无此列，留空即可）；审批状态=「审批状态/审核状态」
  const colOf = (...names) => {
    for (const n of names) {
      const i = headers.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const col = {
    sid: colOf('学号'),
    name: colOf('姓名'),
    className: colOf('班级'),
    startMerged: colOf('请假开始时间'),
    startDate: colOf('请假开始日期'),
    startTime: colOf('开始时间'),
    endMerged: colOf('请假结束时间'),
    endDate: colOf('请假结束日期'),
    endTime: colOf('结束时间'),
    type: colOf('假别', '请假类型'),
    reason: colOf('事由', '请假事由'),
    audit: colOf('审批状态', '审核状态'),
  };
  const cellAt = (row, idx) => (idx >= 0 ? row[idx] : '');
  const strOf = (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) return String(Number.isInteger(v) ? Math.trunc(v) : v);
    return String(v ?? '').trim();
  };
  // 开始/结束时间解析：优先合并列，否则用拆分列（日期列 + 时间列）；返回 { date, time }，可能为 null
  const parseDt = (row, mergedIdx, dateIdx, timeIdx) => {
    if (mergedIdx >= 0) {
      const dt = xlsx.cellToDateTime(cellAt(row, mergedIdx));
      if (dt) return dt;
    }
    if (dateIdx >= 0 || timeIdx >= 0) {
      const d = dateIdx >= 0 ? xlsx.cellToDateTime(cellAt(row, dateIdx)) : null;
      const t = timeIdx >= 0 ? xlsx.cellToDateTime(cellAt(row, timeIdx)) : null;
      return { date: (d && d.date) || null, time: (t && t.time) || (d && d.time) || null };
    }
    return null;
  };

  const mappingErrors = [];
  const skipped = [];
  const normalized = [];
  let sourceRows = 0;
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const row = grid[i];
    if (!row || !row.some((c) => String(c ?? '').trim() !== '')) continue;
    sourceRows++;
    const rowNo = i + 1;
    // 审批状态：表格中无该列 → 默认"已通过"；列存在但值为空 → 亦按"已通过"导入（空值直接跳过的旧逻辑已废弃）；
    // 仅当明确填写非"已通过"状态（如 未通过/待审核）才跳过
    if (col.audit >= 0) {
      const audit = strOf(cellAt(row, col.audit)).replace(/\s+/g, '');
      if (audit && audit !== '已通过') {
        skipped.push({ row: rowNo, message: `审批状态为"${audit}"，非"已通过"，已跳过` });
        continue;
      }
    }
    const sid = strOf(cellAt(row, col.sid));
    const name = strOf(cellAt(row, col.name));
    const className = strOf(cellAt(row, col.className));
    if (!sid || !name) {
      mappingErrors.push({ row: rowNo, message: '学号、姓名为必填' });
      continue;
    }
    const startDt = parseDt(row, col.startMerged, col.startDate, col.startTime);
    const endDt = parseDt(row, col.endMerged, col.endDate, col.endTime);
    // 空值宽容处理：有日期缺时间 → 填默认值（开始 00:00 / 结束 23:59），避免整行丢失
    if (startDt && startDt.date && !startDt.time) startDt.time = '00:00';
    if (endDt && endDt.date && !endDt.time) endDt.time = '23:59';
    if (!startDt || !startDt.date) {
      const raw = col.startMerged >= 0 ? cellAt(row, col.startMerged) : cellAt(row, col.startDate);
      mappingErrors.push({ row: rowNo, message: `请假开始时间"${strOf(raw)}"无法解析为日期` });
      continue;
    }
    if (!endDt || !endDt.date) {
      const raw = col.endMerged >= 0 ? cellAt(row, col.endMerged) : cellAt(row, col.endDate);
      mappingErrors.push({ row: rowNo, message: `请假结束时间"${strOf(raw)}"无法解析为日期` });
      continue;
    }
    if (`${startDt.date} ${startDt.time}` >= `${endDt.date} ${endDt.time}`) {
      mappingErrors.push({ row: rowNo, message: `请假时间无效：开始（${startDt.date} ${startDt.time}）需早于结束（${endDt.date} ${endDt.time}）` });
      continue;
    }
    normalized.push({
      _row: rowNo,
      班级: className,
      姓名: name,
      学号: sid,
      请假开始日期: startDt.date,
      请假结束日期: endDt.date,
      请假开始时间: startDt.time,
      请假结束时间: endDt.time,
      假别: strOf(cellAt(row, col.type)),
      // 新表格若无"事由"列则为空串（导入核心以"—"占位），不报错不跳过
      事由: strOf(cellAt(row, col.reason)),
    });
  }
  const result = importLeaveRows(normalized, user, mappingErrors);
  json(res, 200, {
    ...result,
    total: sourceRows,
    skipped: skipped.length,
    duplicates: result.duplicates.length,
    errors: [...skipped.map((s) => ({ ...s, skip: true })), ...result.duplicateDetails.map((d) => ({ ...d, skip: true })), ...result.errors].slice(0, 20),
  });
});

route('POST', '/api/leaves/:id/apply', { roles: ['admin', 'rights', 'collegeOfficer'] }, async ({ res, params }) => {
  const lv = store.db.leaves.find((l) => l.id === params.id);
  if (!lv) fail(404, '假单不存在');
  // 「重新应用」逐天对账：跨多天假单的中间日考勤也要改判（此前只刷 startDate 单日导致无效）
  beginAttendanceLogCapture(); // 修改81：改判落「假单自动校正」日志
  const r = reconcileLeaveAllDays(lv);
  endAttendanceLogCapture();
  // 修改30：对账改判影响缺勤节数 → 重算该生处分
  recalcPunishmentsByPairs([{ className: lv.className, studentId: lv.studentId }]);
  json(res, 200, { leave: lv, applied: r.applied, reverted: r.reverted });
});

route('DELETE', '/api/leaves/:id', { roles: ['admin', 'rights', 'collegeOfficer'] }, async ({ res, params }) => {
  const idx = store.db.leaves.findIndex((l) => l.id === params.id);
  if (idx < 0) fail(404, '假单不存在');
  const lv = store.db.leaves[idx];
  store.db.leaves.splice(idx, 1);
  store.save('leaves');
  // 删除后逐天重新对账：失去覆盖的"请假"逐日改回"缺勤"（跨天假单每一天都要 revert）
  beginAttendanceLogCapture(); // 修改81：改判落「假单自动校正」日志
  const r = reconcileLeaveAllDays(lv);
  endAttendanceLogCapture();
  store.save('leaves');
  store.save('attendance');
  // 修改30：删除假单后失去覆盖 → 缺勤回升，重算该生处分
  recalcPunishmentsByPairs([{ className: lv.className, studentId: lv.studentId }]);
  json(res, 200, { ok: true, reverted: r.reverted });
});

// ==================== 上课时间段设置 ====================
route('GET', '/api/settings/periods', {}, async ({ res }) => {
  json(res, 200, { periodTimes: store.getPeriodTimes() });
});

route('PUT', '/api/settings/periods', { roles: ['admin', 'rights', 'collegeOfficer'] }, async ({ res, body }) => {
  const input = body.periodTimes || {};
  const out = {};
  for (const p of PERIODS) {
    const t = input[p] || {};
    const s = normTime(t.start);
    const e = normTime(t.end);
    if (!s || !e) fail(400, `${p} 的上课时间格式不正确（应为 HH:MM）`);
    if (s >= e) fail(400, `${p} 的开始时间需早于结束时间`);
    out[p] = { start: s, end: e };
  }
  store.db.settings = { periodTimes: out };
  store.save('settings');
  json(res, 200, { periodTimes: out });
});

// ==================== 数据统计 ====================
route('GET', '/api/stats', { roles: VIEW_ROLES }, async ({ res, user, query }) => {
  const from = query.from || '';
  const to = query.to || '';
  const className = query.className || '';
  // 修改61：班级多选（逗号分隔 classNames）——与 /api/leaves 同模式；不传 = 不过滤，行为不变
  let clsSet = null;
  if (query.classNames) {
    clsSet = new Set(String(query.classNames).split(',').map((x) => x.trim()).filter(Boolean));
  }
  const scope = teacherScope(user);
  const sessions = store.db.attendance.filter(
    (s) => (!from || s.date >= from) && (!to || s.date <= to) && (!className || s.className === className) && (!clsSet || clsSet.has(s.className)) && (!scope || scope.includes(s.className))
  );
  sessions.sort((a, b) => String(a.updatedAt || a.createdAt).localeCompare(String(b.updatedAt || b.createdAt)));
  // 同一学生同一天同一节次取最新一次记录
  const best = new Map();
  for (const s of sessions) {
    for (const p of s.periods) {
      for (const it of s.items) {
        best.set(`${it.studentId}|${s.date}|${p}`, { className: s.className, studentId: it.studentId, name: it.name, status: it.status });
      }
    }
  }
  const sessionCount = {};
  for (const s of sessions) sessionCount[s.className] = (sessionCount[s.className] || 0) + 1;

  const blank = () => ({ should: 0, 出勤: 0, 迟到: 0, 缺勤: 0, 请假: 0 });
  const byClassMap = new Map();
  const byStudentMap = new Map();
  for (const e of best.values()) {
    if (!byClassMap.has(e.className)) byClassMap.set(e.className, { className: e.className, sessions: sessionCount[e.className] || 0, ...blank() });
    const c = byClassMap.get(e.className);
    c.should++;
    if (c[e.status] != null) c[e.status]++;
    const key = `${e.className}|${e.studentId}`;
    if (!byStudentMap.has(key)) byStudentMap.set(key, { className: e.className, studentId: e.studentId, name: e.name, ...blank() });
    const st = byStudentMap.get(key);
    st.should++;
    if (st[e.status] != null) st[e.status]++;
  }
  const rateOf = (o) => (o.should ? Math.round(((o['出勤'] + o['迟到']) / o.should) * 1000) / 10 : 0);
  const byClass = [...byClassMap.values()]
    .map((o) => ({ ...o, rate: rateOf(o) }))
    .sort((a, b) => a.className.localeCompare(b.className, 'zh'));
  const byStudent = [...byStudentMap.values()]
    .map((o) => ({ ...o, rate: rateOf(o) }))
    .sort((a, b) => a.className.localeCompare(b.className, 'zh') || a.studentId.localeCompare(b.studentId));
  json(res, 200, { from, to, className, byClass, byStudent });
});

// ==================== 工作台首页 ====================
route('GET', '/api/dashboard', {}, async ({ res, user }) => {
  const t = fmtDate();
  const sortDesc = (a, b) => b.date.localeCompare(a.date) || String(b.updatedAt).localeCompare(String(a.updatedAt));
  const scope = teacherScope(user);
  const inScope = (s) => !scope || scope.includes(s.className);
  const stuInScope = (s) => !scope || scope.includes(s.className);
  // 多角色合并：纪律委员视图仅对"纯纪律委员"生效；卡片按 管理员 > 权益部 > 其他 优先级选取
  if (hasRole(user, 'discipline') && !hasAnyRole(user, ['admin', 'rights', 'collegeOfficer'])) {
    const mine = store.db.attendance.filter((s) => s.createdById === user.id).sort(sortDesc);
    json(res, 200, {
      role: user.role,
      cards: [
        { label: '我的班级', value: (user.classes || []).length },
        { label: '班级学生数', value: store.db.students.filter((s) => (user.classes || []).includes(s.className)).length },
        { label: '我的点名记录', value: mine.length },
        { label: '今日点名', value: mine.filter((s) => s.date === t).length },
      ],
      recent: mine.slice(0, 8).map(sessionSummary),
    });
    return;
  }
  const all = store.db.attendance.filter(inScope).sort(sortDesc);
  const myStudents = store.db.students.filter((s) => stuInScope(s));
  const cards =
    hasRole(user, 'admin')
      ? [
          { label: '系统账号', value: store.db.users.length },
          { label: '班级数', value: new Set(store.db.students.map((s) => s.className)).size },
          { label: '学生总数', value: store.db.students.length },
          { label: '今日点名', value: all.filter((s) => s.date === t).length },
        ]
      : hasRole(user, 'rights')
        ? [
            { label: '班级数', value: new Set(store.db.students.map((s) => s.className)).size },
            { label: '学生总数', value: store.db.students.length },
            { label: '今日点名', value: all.filter((s) => s.date === t).length },
            { label: '待生效假单', value: store.db.leaves.filter((l) => l.status === '待生效').length },
          ]
        : [
            { label: '所带班级', value: new Set(myStudents.map((s) => s.className)).size },
            { label: '学生总数', value: myStudents.length },
            { label: '今日点名', value: all.filter((s) => s.date === t).length },
            { label: '待生效假单', value: store.db.leaves.filter((l) => l.status === '待生效').length },
          ];
  json(res, 200, { role: user.role, cards, recent: all.slice(0, 8).map(sessionSummary) });
});

// ==================== 缺勤节数统计 ====================
function mondayOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const day = d.getDay() === 0 ? 7 : d.getDay(); // 周一为一周开始
  d.setDate(d.getDate() - (day - 1));
  return fmtDate(d);
}
function weekNoOfMonday(mondayStr) {
  const y = Number(mondayStr.slice(0, 4));
  const jan1 = new Date(y, 0, 1);
  const jan1day = jan1.getDay() === 0 ? 7 : jan1.getDay();
  const firstMonday = new Date(y, 0, 1 + ((8 - jan1day) % 7));
  return Math.floor((new Date(`${mondayStr}T00:00:00`) - firstMonday) / (7 * 86400000)) + 1;
}
function bucketKeyOf(dateStr, dimension) {
  if (dimension === 'week') return mondayOf(dateStr);
  if (dimension === 'month') return dateStr.slice(0, 7);
  if (dimension === 'year') return dateStr.slice(0, 4);
  return 'custom';
}
function bucketLabel(key, dimension) {
  if (dimension === 'week') {
    const y = Number(key.slice(0, 4));
    const n = weekNoOfMonday(key);
    const end = addDays(key, 6);
    return `${y}年第${n}周（${key.slice(5)}~${end.slice(5)}）`;
  }
  if (dimension === 'month') {
    const [y, m] = key.split('-');
    return `${y}年${Number(m)}月`;
  }
  if (dimension === 'year') return `${key}年`;
  return `自定义区间 ${key}`;
}

// 学生缺勤节数统计：按周 / 月 / 年 / 自定义区间分桶，支持年级、班级、缺勤节数区间复合筛选
route('GET', '/api/stats/absences', { roles: VIEW_ROLES }, async ({ res, user, query }) => {
  const dimension = ['week', 'month', 'year', 'custom'].includes(query.dimension) ? query.dimension : 'week';
  let from = normDate(query.from) || '';
  let to = normDate(query.to) || '';
  const todayStr = fmtDate();
  if (dimension === 'custom' && (!normDate(query.from) || !normDate(query.to))) {
    fail(400, '自定义区间统计需提供开始日期与结束日期');
  }
  if (!from || !to) {
    if (dimension === 'week') { const mon = mondayOf(todayStr); from = mon; to = addDays(mon, 6); }
    else if (dimension === 'month') { from = `${todayStr.slice(0, 7)}-01`; to = fmtDate(new Date(Number(todayStr.slice(0, 4)), Number(todayStr.slice(5, 7)), 0)); }
    else if (dimension === 'year') { from = `${todayStr.slice(0, 4)}-01-01`; to = `${todayStr.slice(0, 4)}-12-31`; }
  }
  if (from > to) fail(400, '开始日期不能晚于结束日期');
  if ((new Date(`${to}T00:00:00`) - new Date(`${from}T00:00:00`)) / 86400000 > 366 * 3) fail(400, '查询跨度不能超过 3 年');

  const grade = String(query.grade || '').trim();
  // 修改60：年级归一化匹配。前端级联筛选统一传「YYYY级」；历史数据里同一届可能写成
  // 「2025级」「2025」等，精确匹配会漏。这里把两侧都归一到 4 位年+「级」再比较；
  // 原本就规范的数据归一前后相同，行为不变（纯等价改写，无破坏性）。
  // 修改69：内联的 normGradeSrv 删除，改用 ./utils 的共享 normGrade（与前端同规则）。
  const gradeN = grade ? normGrade(grade) : '';
  const className = String(query.className || '').trim();
  const student = String(query.student || '').trim();
  const min = query.min === undefined || query.min === '' ? null : Number(query.min);
  const max = query.max === undefined || query.max === '' ? null : Number(query.max);
  if ((min != null && (Number.isNaN(min) || min < LATE_JIE)) || (max != null && (Number.isNaN(max) || max < LATE_JIE))) {
    fail(400, '缺勤节数区间需为不小于 0.5 的数值');
  }
  if (min != null && max != null && min > max) fail(400, '缺勤节数下限不能大于上限');

  // 缺勤记录聚合（修改18 口径）：缺勤节数按节次权重求和（常规节次=2 节，早自习/晚自习=1 节）；
  // 迟到按"次"折算，一条迟到记录恒折 0.5 节（与记录覆盖几个节次无关），并入缺勤节数
  const scope = teacherScope(user);
  const acc = new Map();
  for (const s of store.db.attendance) {
    if (s.date < from || s.date > to) continue;
    if (className && s.className !== className) continue;
    if (scope && !scope.includes(s.className)) continue;
    const periodCount = jieSumOf(s.periods);
    if (!periodCount && !s.items.some((x) => x.status === '迟到')) continue;
    const key = bucketKeyOf(s.date, dimension);
    for (const it of s.items) {
      if (it.status !== '缺勤' && it.status !== '迟到') continue;
      const stu = store.db.students.find((x) => x.studentId === it.studentId);
      if (!stu) continue;
      if (gradeN && normGrade(stu.grade) !== gradeN) continue;
      if (student && !(stu.studentId.includes(student) || stu.name.includes(student))) continue;
      const k = `${stu.className}|${stu.studentId}`;
      let rec = acc.get(k);
      if (!rec) {
        rec = { grade: stu.grade || '', className: stu.className, studentId: stu.studentId, name: stu.name, total: 0, sessions: 0, lateSessions: 0, studySessions: 0, byBucket: new Map() };
        acc.set(k, rec);
      }
      rec.total += it.status === '缺勤' ? periodCount : LATE_JIE;
      if (it.status === '缺勤') rec.sessions += 1;
      // 修改20：迟到记录次数；早/晚自习缺勤记录次数（缺勤记录节次含早自习或晚自习即计 1 次）
      if (it.status === '迟到') rec.lateSessions += 1;
      else if (s.periods.includes('早自习') || s.periods.includes('晚自习')) rec.studySessions += 1;
      rec.byBucket.set(key, (rec.byBucket.get(key) || 0) + (it.status === '缺勤' ? periodCount : LATE_JIE));
    }
  }
  let students = [...acc.values()].map((r) => ({ ...r, byBucket: Object.fromEntries(r.byBucket) }));
  if (min != null) students = students.filter((s) => s.total >= min);
  if (max != null) students = students.filter((s) => s.total <= max);
  students.sort((a, b) => b.total - a.total || a.className.localeCompare(b.className, 'zh') || a.studentId.localeCompare(b.studentId));

  const bucketSet = new Set();
  students.forEach((s) => Object.keys(s.byBucket).forEach((k) => bucketSet.add(k)));
  const buckets = [...bucketSet].sort().map((k) => ({ key: k, label: bucketLabel(k, dimension) }));
  json(res, 200, { dimension, from, to, buckets, students, filters: { grade, className, student, min, max } });
});

// 学生缺勤明细：某学生在统计区间内的全部缺勤/迟到记录（含日期、星期、状态、节次、各节上课时间段、课程、备注）；
// 修改20：迟到记录一并返回，缺勤 jie=节次权重和、迟到 jie=0.5（与缺勤统计主表口径一致）
route('GET', '/api/stats/absences/detail', { roles: VIEW_ROLES }, async ({ res, user, query }) => {
  const className = String(query.className || '').trim();
  const studentId = String(query.studentId || '').trim();
  const from = normDate(query.from) || '';
  const to = normDate(query.to) || '';
  if (!className || !studentId) fail(400, '缺少班级或学号参数');
  if (!from || !to) fail(400, '缺少统计区间');
  if (from > to) fail(400, '开始日期不能晚于结束日期');
  const scope = teacherScope(user);
  if (scope && !scope.includes(className)) fail(403, '没有权限查看该班级的缺勤数据');
  const stu = store.db.students.find((s) => s.studentId === studentId && s.className === className);
  if (!stu) fail(404, '未在班级名单中找到该学生');
  const cfg = store.getPeriodTimes();
  const records = [];
  for (const s of store.db.attendance) {
    if (s.date < from || s.date > to || s.className !== className) continue;
    const it = s.items.find((x) => x.studentId === studentId);
    if (!it || (it.status !== '缺勤' && it.status !== '迟到')) continue;
    records.push({
      sessionId: s.id,
      date: s.date,
      weekday: `周${'日一二三四五六'[new Date(`${s.date}T00:00:00`).getDay()]}`,
      status: it.status,
      periods: [...s.periods],
      jie: it.status === '缺勤' ? jieSumOf(s.periods) : LATE_JIE,
      times: s.periods.map((p) => ({ period: p, start: cfg[p]?.start || '', end: cfg[p]?.end || '' })),
      courseName: s.courseName,
      teacher: s.teacher || '',
      note: it.note || '',
      createdBy: s.createdBy,
    });
  }
  records.sort((a, b) => b.date.localeCompare(a.date) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  json(res, 200, {
    student: { studentId, name: stu.name, className, grade: stu.grade || '' },
    from,
    to,
    records,
  });
});

// ==================== 缺勤月报（修改36） ====================
// 口径：
// - 「本月」= 查询月份的自然月（支持切换历史月份，不能晚于当前月）；
// - 「本学期 / 本学年」= 查询月份所属学期 / 学年（切历史月份时按那个时期算），
//   学期区间优先用管理员配置的 settings.semesterTerms，未配置回退默认（9/1~1/31、2/1~7/31）；
//   月份落在两个学期之间（如 8 月）时学期累计回退用全学年区间；
// - 缺勤节数口径与缺勤统计一致：缺勤按节次权重求和（常规节次=2 节，早/晚自习=1 节），迟到一次恒折 0.5 节；
// - 仅展示「本月缺勤节数 > 0」的学生；
// - 处分情况 = 该生截至目前【生效中】的最高等级处分（已自动撤销的不算），无则留空；
// - 班主任 / 辅导员仅能看到所带班级（teacherScope）。
route('GET', '/api/stats/monthly', { roles: VIEW_ROLES }, async ({ res, user, query }) => {
  const todayStr = fmtDate();
  const curMonth = todayStr.slice(0, 7);
  const month = /^\d{4}-\d{2}$/.test(String(query.month || '').trim()) ? String(query.month).trim() : curMonth;
  if (month > curMonth) fail(400, '月报不能查看未来月份');
  const [y, mo] = month.split('-').map(Number);
  if (mo < 1 || mo > 12) fail(400, '月份格式需为 YYYY-MM');
  const monthFrom = `${month}-01`;
  const monthTo = fmtDate(new Date(y, mo, 0)); // 该月月末

  // 以月中 15 日为锚点判定该月所属学年 / 学期
  const anchor = new Date(`${month}-15T00:00:00`);
  const sy = schoolYearOf(anchor);
  const terms = effectiveTerms(sy);
  const term = terms.find((t) => monthFrom <= t.end && monthTo >= t.start) || { name: '全学年', start: sy.start, end: sy.end, configured: false };
  const className = String(query.className || '').trim();
  // 修改61：班级多选（classNames 逗号分隔）——不传 = 不过滤；与单选 className 互斥时以多选优先
  let moClsSet = null;
  if (query.classNames) {
    moClsSet = new Set(String(query.classNames).split(',').map((x) => x.trim()).filter(Boolean));
  }
  const scope = teacherScope(user);
  if (className && scope && !scope.includes(className)) fail(403, '没有权限查看该班级的月报数据');

  // 三个区间一次遍历同时累计
  const stuIdx = new Map(store.db.students.map((s) => [s.studentId, s]));
  const acc = new Map();
  for (const s of store.db.attendance) {
    const inMonth = s.date >= monthFrom && s.date <= monthTo;
    const inTerm = s.date >= term.start && s.date <= term.end;
    const inYear = s.date >= sy.start && s.date <= sy.end;
    if (!inMonth && !inTerm && !inYear) continue;
    if (className && s.className !== className) continue;
    if (moClsSet && !moClsSet.has(s.className)) continue;
    if (scope && !scope.includes(s.className)) continue;
    const periodCount = jieSumOf(s.periods);
    if (!periodCount && !s.items.some((x) => x.status === '迟到')) continue;
    for (const it of s.items) {
      if (it.status !== '缺勤' && it.status !== '迟到') continue;
      const stu = stuIdx.get(it.studentId);
      if (!stu) continue;
      let rec = acc.get(stu.studentId);
      if (!rec) {
        rec = { className: stu.className, studentId: stu.studentId, name: stu.name, grade: stu.grade || '', monthJie: 0, termJie: 0, yearJie: 0 };
        acc.set(stu.studentId, rec);
      }
      const jie = it.status === '缺勤' ? periodCount : LATE_JIE;
      if (inMonth) rec.monthJie += jie;
      if (inTerm) rec.termJie += jie;
      if (inYear) rec.yearJie += jie;
    }
  }
  // 仅本月有缺勤的学生
  const rows = [...acc.values()].filter((r) => r.monthJie > 0);
  // 生效中处分的最高等级（每生每班只留 levelIndex 最大的一条）
  const punishTop = new Map();
  for (const p of store.db.punishments || []) {
    if (p.revokedAt) continue;
    const k = `${p.sid}|${p.className}`;
    const cur = punishTop.get(k);
    if (!cur || (p.levelIndex || 0) > (cur.levelIndex || 0)) {
      punishTop.set(k, { level: p.level, levelIndex: p.levelIndex || 0, levelRange: p.levelRange || '' });
    }
  }
  for (const r of rows) r.punishment = punishTop.get(`${r.studentId}|${r.className}`) || null;
  rows.sort((a, b) => b.monthJie - a.monthJie || a.className.localeCompare(b.className, 'zh') || a.studentId.localeCompare(b.studentId));

  json(res, 200, {
    month,
    monthFrom,
    monthTo,
    term: { name: term.name, start: term.start, end: term.end },
    schoolYear: { label: sy.label, start: sy.start, end: sy.end },
    total: rows.length,
    list: rows,
  });
});

// ==================== 缺勤公示（修改14：免登录自查 / 班级公示榜 / 导出公示表） ====================
// 防刷节流：内存固定窗口（单实例场景够用；重启清零可接受）
const rateBuckets = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const b = rateBuckets.get(key);
  if (!b || now - b.start > windowMs) {
    rateBuckets.set(key, { start: now, count: 1 });
    return true;
  }
  b.count += 1;
  return b.count <= limit;
}
function clientIp(req) {
  const fwd = String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
  return fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
}

// 公示相关辅助
// 学号脱敏：保留前 4 位与后 2 位，中间每位一个 *（长度不足 7 时只保留首尾各 1 位）
function maskStudentId(id) {
  const s = String(id || '');
  if (s.length <= 2) return '*'.repeat(s.length);
  if (s.length < 7) return s[0] + '*'.repeat(s.length - 2) + s[s.length - 1];
  return s.slice(0, 4) + '*'.repeat(s.length - 6) + s.slice(-2);
}
// 姓名脱敏：2 字保留首字末字打星（郑楠→郑*）；3 字及以上保留首尾、中间每字一个 *；单字名 → 名+*
function maskName(name) {
  const s = String(name || '');
  if (s.length <= 1) return s + '*';
  if (s.length === 2) return s[0] + '*';
  return s[0] + '*'.repeat(s.length - 2) + s[s.length - 1];
}
// 修改72：改为「已登记班级 ∪ 学生表班级」——班级管理中新建的班级（尚无学生）也要出现在下拉里
function classNamesOf() {
  return classUnionNames();
}
// 修改61：班级元数据（名字 + 归一化年级 + 人数），供公共接口携带年级信息；
// 与 /api/meta/classes 的 gradeOf 同源规则（normGrade 归一，防「2025级/2025」拆组）
// 修改72：classes 登记的年级优先，学生表推导兜底；已登记但无学生的班级同样输出（count=0）
function classMetaOf() {
  const map = new Map();
  const keyOf = (n) => normClassName(n).toLowerCase();
  for (const c of store.db.classes || []) {
    if (!c || !c.name) continue;
    const nm = normClassName(c.name);
    map.set(keyOf(nm), { name: nm, count: 0, grade: c.grade ? normGrade(c.grade) : '' });
  }
  for (const s of store.db.students) {
    if (!s.className) continue;
    const k = keyOf(s.className);
    const rec = map.get(k) || { name: s.className, count: 0, grade: '' };
    rec.count++;
    if (!rec.grade && s.grade) {
      // 修改69：内联归一化改用 ./utils 的共享 normGrade（与前端 gradeClassCascade.js 同规则）
      rec.grade = normGrade(s.grade);
    }
    map.set(k, rec);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}
// 生效学期配置：管理员在 settings.semesterTerms[学年] 配置过则用之，否则回退默认（9/1~1/31、2/1~7/31）
function effectiveTerms(sy) {
  const cfg = (store.db.settings && store.db.settings.semesterTerms) || {};
  const def = defaultTerms(sy);
  const custom = Array.isArray(cfg[sy.label]) ? cfg[sy.label] : null;
  const pick = (i) => {
    const d = def[i];
    const t = custom && custom[i];
    if (t && normDate(t.start) && normDate(t.end) && normDate(t.start) <= normDate(t.end)) {
      const s = normDate(t.start);
      const e = normDate(t.end);
      const name = String(t.name || d.name);
      // 与默认划分完全一致时视为未自定义（展示与回退语义一致）
      const configured = name !== d.name || s !== d.start || e !== d.end;
      return { name, start: s, end: e, configured };
    }
    return { ...d, configured: false };
  };
  return [pick(0), pick(1)];
}
function termRangeOf(termKey, sy) {
  const terms = effectiveTerms(sy);
  if (termKey === '0') return terms[0];
  if (termKey === '1') return terms[1];
  return { name: '全学年', start: sy.start, end: sy.end };
}
function weekdayOf(dateStr) {
  return `周${'日一二三四五六'[new Date(`${dateStr}T00:00:00`).getDay()]}`;
}
// 汇总某班级在区间内的缺勤/迟到记录（items 中该学生状态为 缺勤/迟到 的点名记录）
function collectAbsenceRecords(className, studentId, from, to) {
  const cfg = store.getPeriodTimes();
  const records = [];
  for (const s of store.db.attendance) {
    if (s.date < from || s.date > to || s.className !== className) continue;
    const it = s.items.find((x) => x.studentId === studentId);
    if (!it || (it.status !== '缺勤' && it.status !== '迟到')) continue;
    records.push({
      sessionId: s.id,
      date: s.date,
      weekday: weekdayOf(s.date),
      periods: [...s.periods],
      // 节数口径（修改18）：缺勤按节次权重求和（常规节次=2 节，早/晚自习=1 节）；迟到按"次"恒折 0.5 节
      jie: it.status === '缺勤' ? jieSumOf(s.periods) : LATE_JIE,
      times: s.periods.map((p) => ({ period: p, start: cfg[p]?.start || '', end: cfg[p]?.end || '' })),
      status: it.status,
      // 修改21：是否属于早晚自习（记录节次含早自习或晚自习）
      isStudy: s.periods.includes('早自习') || s.periods.includes('晚自习'),
      courseName: s.courseName,
      teacher: s.teacher || '',
      note: it.note || '',
    });
  }
  records.sort((a, b) => b.date.localeCompare(a.date) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return records;
}
function statsOf(records) {
  let absenceCount = 0;
  let lateCount = 0;
  let absencePeriods = 0;
  let studyCount = 0;
  for (const r of records) {
    // 缺勤节数（修改18 口径）：缺勤按节次权重、迟到每次折 0.5 节，一并累加
    absencePeriods += r.jie;
    if (r.status === '缺勤') {
      absenceCount += 1;
      // 修改21：早/晚自习缺勤次数（与修改20 studySessions 口径一致：记录节次含早自习或晚自习即计 1 次，混合记录计 1 次）
      if ((r.periods || []).some((p) => p === '早自习' || p === '晚自习')) studyCount += 1;
    } else if (r.status === '迟到') lateCount += 1;
  }
  return { absenceCount, absencePeriods, lateCount, studyCount };
}
// 校验公示查询参数中的 term（all/0/1），并返回区间
function publicTermOf(raw, sy) {
  const term = ['all', '0', '1'].includes(raw) ? raw : 'all';
  return { key: term, ...termRangeOf(term, sy) };
}

// ==================== 处分管理（修改30） ====================
// 规则：累计缺勤节数（缺勤按节次权重 + 迟到每次折 0.5 节，与统计/公示口径一致）
// 达到等级阈值时自动生成处分记录（含触发时的全部缺勤/迟到明细快照）；
// 节数回落（异议改判 / 假单对账 / 记录修正）低于已生成等级阈值时，系统自动撤销（revokedAt 留痕）。
// 一个学生同一等级同时最多一条生效记录；节数反复波动时同等级记录复用（撤销→重新达标→恢复生效）。

/** 生成处分时定格的「触发明细」快照：该生全部缺勤/迟到记录的关键字段 */
function punishmentSnapshot(className, studentId) {
  return collectAbsenceRecords(className, studentId, '0000-00-00', '9999-12-31').map((r) => ({
    sessionId: r.sessionId,
    date: r.date,
    weekday: r.weekday,
    periods: r.periods,
    courseName: r.courseName,
    status: r.status,
    jie: r.jie,
  }));
}

// ==================== 修改32：认定口径细化 ====================
// 「最早认定节数」= 按时间正序累计，第一次达到该等级区间下限（lv.min）时的累计节数；
// 「生成时间」= 产生该次达标的那条考勤记录的时间点；
// 「详情记录」= 自首次达标记录起、累计节数仍落在该区间 [lv.min, lv.max] 内的记录切片（超出上限即止）；
// 「累计缺勤节数」= 截止目前的全历史累计（缺勤按节次权重 + 迟到每次折 0.5 节），随考勤变化、不冻结。
const PUNISH_CALC_VER = 3; // 计算口径版本：旧记录（无该字段或小于此值）启动时强制重算升级（v3=高等级详情含首次缺勤起完整轨迹）

/** 该生全历史缺勤/迟到时间轴（按时间正序，逐条带累计节数 runningTotal 与记录时点 at） */
function absenceTimeline(className, studentId) {
  const atOf = new Map();
  for (const s of store.db.attendance) atOf.set(s.id, s.updatedAt || s.createdAt || '');
  const rs = collectAbsenceRecords(className, studentId, '0000-00-00', '9999-12-31')
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  let run = 0;
  return rs.map((r) => {
    run += r.jie;
    // 时间点：以考勤日期为准，时刻取该次点名记录的时间（无则 00:00:00）——避免用「记录创建时刻」顶替缺勤发生日
    const raw = atOf.get(r.sessionId) || '';
    const hms = /T(\d{2}:\d{2}:\d{2})/.exec(raw);
    const at = `${r.date}T${hms ? hms[1] : '00:00:00'}`;
    return { ...r, runningTotal: run, at };
  });
}

/** 按等级区间切片（修改33 口径）：
 *  - 最低等级（idx=0）：首次达标（≥lv.min）起收集、超出上限（>lv.max）即止 —— 保持区间内切片；
 *  - 高等级（idx≥1）：自时间线第一条起收集，至首次达到该区间下限（≥lv.min）的那条为止（含）——
 *    展示"从首次缺勤到进入本区间"的完整轨迹；firstJie/firstAt 仍取首次达标点，不受影响 */
function sliceForLevel(timeline, lv, idx = 0) {
  const out = [];
  let firstJie = null;
  let firstAt = null;
  for (const r of timeline) {
    const reached = r.runningTotal >= lv.min;
    if (firstJie === null) {
      if (idx >= 1 && !reached) { out.push(r); continue; } // 高等级：达标前的全部轨迹也纳入
      if (!reached) continue;                              // 最低等级：尚未达下限，跳过
      firstJie = r.runningTotal;                           // 首次达标（含该条）
      firstAt = r.at;
      out.push(r);
      continue;
    }
    if (idx >= 1) break;                // 高等级：首次达到本区间即止
    if (r.runningTotal > lv.max) break; // 最低等级：累计超出区间上限 → 停止收集
    out.push(r);
  }
  return {
    firstJie,
    firstAt,
    records: out.map((r) => ({
      sessionId: r.sessionId,
      date: r.date,
      weekday: r.weekday,
      periods: r.periods,
      courseName: r.courseName,
      status: r.status,
      jie: r.jie,
      runningTotal: r.runningTotal,
    })),
  };
}

/** 单个学生的处分重算（幂等）：返回是否有变更。stu 需含 className/studentId/studentName/grade */
function recalcPunishmentsForStudent(stu) {
  const timeline = absenceTimeline(stu.className, stu.studentId);
  const totalJie = timeline.length ? timeline[timeline.length - 1].runningTotal : 0; // 当前累计 = 全历史折算和
  const targetMax = punishmentIndexOf(totalJie);
  const list = store.db.punishments || (store.db.punishments = []);
  const own = (p) => p.sid === stu.studentId && p.className === stu.className;
  let changed = false;
  // ① 逐级补齐应达等级（跳级补录时中间等级一并生成；展示侧取最高等级）
  for (let i = 0; i <= targetMax; i++) {
    const lv = PUNISHMENT_LEVELS[i];
    const { firstJie, firstAt, records } = sliceForLevel(timeline, lv, i); // 修改33：传等级下标决定切片口径
    if (firstJie === null) continue; // 未达该等级下限（理论不出现，保险）
    const existing = list.find((p) => own(p) && p.levelIndex === i);
    const needUpgrade = existing && Number(existing.calcVer || 0) < PUNISH_CALC_VER; // 旧口径记录强制重算升级
    if (existing && !existing.revokedAt && !needUpgrade) {
      // 已生效且口径最新：仅刷新「区间内记录」切片（新增缺勤若累计仍在该区间内应纳入详情）；
      // 最早认定节数与生成时间保持首次达标值，不随后续缺勤变化
      const before = JSON.stringify(existing.records || []);
      const after = JSON.stringify(records);
      if (before !== after) {
        existing.records = records;
        existing.updatedAt = nowISO();
        changed = true;
      }
      continue;
    }
    if (existing) {
      // 曾被自动撤销（现重新达标）→ 恢复生效；或旧口径 → 升级刷新
      existing.revokedAt = null;
      existing.revokeInfo = null;
      existing.totalJie = firstJie;      // 认定节数 = 最早认定节数（首次达到该区间下限时的累计）
      existing.firstJie = firstJie;
      existing.firstReachAt = firstAt;   // 首次达到该区间的时间点
      existing.createdAt = firstAt || existing.createdAt || nowISO();
      existing.records = records;        // 仅该区间内的记录
      existing.calcVer = PUNISH_CALC_VER;
      existing.updatedAt = nowISO();
    } else {
      list.push({
        id: uid('pm'),
        sid: stu.studentId,
        className: stu.className,
        studentName: stu.studentName || stu.name || '',
        grade: stu.grade || '',
        level: lv.level,
        levelIndex: i,
        levelRange: `${lv.min} ~ ${lv.max === Infinity ? '∞' : lv.max} 节`,
        totalJie: firstJie,
        firstJie,
        firstReachAt: firstAt || nowISO(),
        records,
        createdAt: firstAt || nowISO(),
        updatedAt: nowISO(),
        revokedAt: null,
        revokeInfo: null,
        createdBy: '系统（自动）',
        calcVer: PUNISH_CALC_VER,
      });
    }
    changed = true;
  }
  // ② 高于当前应达等级的生效记录 → 自动撤销（留痕，不物理删除）
  for (const p of list) {
    if (own(p) && !p.revokedAt && p.levelIndex > targetMax) {
      p.revokedAt = nowISO();
      p.revokeInfo = `累计缺勤节数降至 ${totalJie} 节，低于「${p.level}」阈值（${p.levelRange}），系统自动撤销`;
      p.updatedAt = nowISO();
      changed = true;
    }
  }
  return changed;
}

/** 批量重算：pairs = [{className, studentId}]，有变更时统一落盘一次 */
function recalcPunishmentsByPairs(pairs) {
  if (!Array.isArray(pairs) || !pairs.length) return false;
  const seen = new Set();
  const targets = store.db.students.filter((s) => {
    const key = `${s.className}|${s.studentId}`;
    if (!pairs.some((p) => p.className === s.className && p.studentId === s.studentId) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  let changed = false;
  for (const stu of targets) changed = recalcPunishmentsForStudent(stu) || changed;
  if (changed) store.save('punishments');
  return changed;
}

/** 学生的处分摘要（公示自查 / 详情用）：生效记录按等级降序 */
function punishmentSummaryOf(className, studentId, totalJie) {
  const active = (store.db.punishments || [])
    .filter((p) => p.sid === studentId && p.className === className && !p.revokedAt)
    .sort((a, b) => b.levelIndex - a.levelIndex);
  return {
    totalJie, // 当前累计缺勤节数（全历史，随考勤变化）
    activeCount: active.length,
    top: active.length
      ? {
          level: active[0].level,
          levelIndex: active[0].levelIndex,
          levelRange: active[0].levelRange || '',
          createdAt: active[0].createdAt,           // 首次达到该等级区间的时间点
          firstJie: active[0].firstJie ?? active[0].totalJie, // 最早认定节数
        }
      : null,
    levels: active.map((p) => ({
      level: p.level,
      levelIndex: p.levelIndex,
      createdAt: p.createdAt,
      firstJie: p.firstJie ?? p.totalJie,
    })),
  };
}

/** 学生当前累计缺勤节数（全历史，与统计/公示口径一致：缺勤权重和 + 迟到 0.5/次） */
function currentTotalJieOf(className, studentId) {
  return statsOf(punishmentSnapshot(className, studentId)).absencePeriods;
}

// ① 元信息：当前学年、生效学期划分、班级列表（公开）
route('GET', '/api/public/absence/meta', { public: true }, async ({ res, req }) => {
  if (!rateLimit(`meta:${clientIp(req)}`, 20, 60 * 1000)) fail(429, '查询过于频繁，请稍后再试');
  const sy = schoolYearOf();
  const terms = effectiveTerms(sy);
  json(res, 200, {
    schoolYear: { label: sy.label, start: sy.start, end: sy.end },
    terms,
    classes: classNamesOf(),
    // 修改61：带年级的班级元数据（树形组件按年级分组需要）；保留 classes 字段兼容既有消费方
    classMeta: classMetaOf(),
  });
});

// ② 学生免登录自查：班级 + 学号 + 姓名三要素精确匹配（不匹配统一 404，防枚举）
route('GET', '/api/public/absence/query', { public: true }, async ({ res, req, query }) => {
  const ip = clientIp(req);
  if (!rateLimit(`query:${ip}`, 10, 60 * 1000)) fail(429, '查询过于频繁，请稍后再试');
  const className = String(query.className || '').trim();
  const studentId = String(query.studentId || '').trim();
  const name = String(query.name || '').trim();
  if (!className || !studentId || !name) fail(400, '请填写班级、学号和姓名');
  const stu = store.db.students.find((s) => s.className === className && s.studentId === studentId && s.name === name);
  if (!stu) fail(404, '未找到匹配的学生信息，请核对班级、学号与姓名');
  const sy = schoolYearOf();
  const term = publicTermOf(query.term, sy);
  const records = collectAbsenceRecords(className, studentId, term.start, term.end);
  // 修改30：读时自愈 —— 自查时对该生幂等重算一次处分（兜底任何写路径遗漏），再返回处分摘要。
  // 处分累计口径为「全部历史缺勤节数」（不随查询学期收窄），与统计页「缺勤节数」同口径（含迟到折 0.5 节/次）
  recalcPunishmentsForStudent(stu);
  const punishment = punishmentSummaryOf(className, studentId, currentTotalJieOf(className, studentId));
  json(res, 200, {
    schoolYear: { label: sy.label, start: sy.start, end: sy.end },
    term: { key: term.key, name: term.name, start: term.start, end: term.end },
    student: { name: stu.name, studentId: stu.studentId, className: stu.className, grade: stu.grade || '' },
    stats: statsOf(records),
    punishment,
    records,
  });
});

// ③ 班级公示榜：按缺勤节数降序，仅返回统计数字（不含明细备注）
route('GET', '/api/public/absence/classboard', { public: true }, async ({ res, req, query }) => {
  if (!rateLimit(`board:${clientIp(req)}`, 10, 60 * 1000)) fail(429, '查询过于频繁，请稍后再试');
  const className = String(query.className || '').trim();
  if (!className) fail(400, '请选择班级');
  if (!store.db.students.some((s) => s.className === className)) fail(404, '未找到该班级');
  const sy = schoolYearOf();
  const term = publicTermOf(query.term, sy);
  const board = store.db.students
    .filter((s) => s.className === className)
    .map((s) => {
      const recs = collectAbsenceRecords(className, s.studentId, term.start, term.end);
      return { name: s.name, studentId: s.studentId, grade: s.grade || '', ...statsOf(recs) };
    })
    .sort((a, b) => b.absencePeriods - a.absencePeriods || b.absenceCount - a.absenceCount || a.studentId.localeCompare(b.studentId))
    // 隐私脱敏仅在最终输出（排序用真实学号，公示榜不泄露全名/完整学号）
    .map((x) => ({ ...x, name: maskName(x.name), studentId: maskStudentId(x.studentId) }));
  json(res, 200, {
    schoolYear: { label: sy.label, start: sy.start, end: sy.end },
    term: { key: term.key, name: term.name, start: term.start, end: term.end },
    className,
    board,
  });
});

// ④ 公示榜缺勤详情（修改21）：班主任/辅导员/学院考勤负责人/权益部/管理员可查；
// 榜单返回的是脱敏学号，前端无法回查——用榜单行下标 idx 由后端按与 classboard 完全相同的排序还原学生，
// 三层防越权：路由 roles 白名单（不含纪律委员）→ teacherScope 班级范围 → 仅返回统计区间内明细
route('GET', '/api/absence/board-detail', { roles: ['admin', 'rights', 'headTeacher', 'counselor', 'collegeOfficer'] }, async ({ res, user, query }) => {
  const className = String(query.className || '').trim();
  if (!className) fail(400, '请选择班级');
  if (!store.db.students.some((s) => s.className === className)) fail(404, '未找到该班级');
  const idx = Number(query.idx);
  if (!Number.isInteger(idx) || idx < 0) fail(400, '参数错误');
  // 班级范围校验（与 /api/stats/absences/detail 同范式）：班主任 / 辅导员仅限所带班级
  const scope = teacherScope(user);
  if (scope && !scope.includes(className)) fail(403, '没有权限查看该班级的缺勤数据');
  const sy = schoolYearOf();
  const term = publicTermOf(query.term, sy);
  const students = store.db.students
    .filter((s) => s.className === className)
    .map((s) => ({ stu: s, ...statsOf(collectAbsenceRecords(className, s.studentId, term.start, term.end)) }))
    .sort((a, b) => b.absencePeriods - a.absencePeriods || b.absenceCount - a.absenceCount || a.stu.studentId.localeCompare(b.stu.studentId));
  const hit = students[idx];
  if (!hit) fail(404, '未找到该学生的缺勤数据');
  const records = collectAbsenceRecords(className, hit.stu.studentId, term.start, term.end);
  json(res, 200, {
    term: { key: term.key, name: term.name, start: term.start, end: term.end },
    className,
    student: { studentId: hit.stu.studentId, name: hit.stu.name, className, grade: hit.stu.grade || '' },
    stats: statsOf(records),
    records,
  });
});

// ⑤ 导出公示表（Excel）：管理员 / 权益部 / 学院考勤负责老师
route('POST', '/api/absence/export', { roles: ['admin', 'rights', 'collegeOfficer'] }, async ({ res, body }) => {
  const className = String(body.className || '').trim();
  if (!className) fail(400, '请选择要导出的班级');
  if (!store.db.students.some((s) => s.className === className)) fail(404, '未找到该班级');
  const sy = schoolYearOf();
  const term = publicTermOf(body.term, sy);
  const rows = [];
  const students = store.db.students
    .filter((s) => s.className === className)
    .sort((a, b) => a.studentId.localeCompare(b.studentId));
  for (const s of students) {
    for (const r of collectAbsenceRecords(className, s.studentId, term.start, term.end)) {
      rows.push([
        r.date,
        r.weekday,
        r.periods.join('、'),
        r.jie || '',
        s.studentId,
        s.name,
        r.status,
        r.courseName,
        r.teacher,
        r.note || '',
      ]);
    }
  }
  const buf = xlsx.buildXlsx(['日期', '星期', '节次', '节数', '学号', '姓名', '状态', '课程名称', '任课老师', '备注'], rows);
  const filename = `缺勤公示_${className}_${term.name}_${sy.label}.xlsx`;
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="absence_export.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
});

// ⑤ 学期起止配置（仅管理员）：读取
route('GET', '/api/settings/semesters', { roles: ['admin'] }, async ({ res }) => {
  const sy = schoolYearOf();
  const terms = effectiveTerms(sy);
  json(res, 200, {
    schoolYear: { label: sy.label, start: sy.start, end: sy.end },
    terms,
    defaults: defaultTerms(sy),
    configured: terms.some((t) => t.configured),
  });
});

// ⑥ 学期起止配置（仅管理员）：写入 / 恢复默认 —— 唯一写入点，仅触碰 settings.semesterTerms 键
route('PUT', '/api/settings/semesters', { roles: ['admin'] }, async ({ res, body }) => {
  const sy = schoolYearOf();
  if (body.reset) {
    const cfg = store.db.settings || {};
    if (cfg.semesterTerms && cfg.semesterTerms[sy.label]) delete cfg.semesterTerms[sy.label];
    store.db.settings = cfg;
    store.save('settings');
    json(res, 200, { ok: true, reset: true, terms: effectiveTerms(sy) });
    return;
  }
  const idx = body.term === 0 || body.term === '0' ? 0 : body.term === 1 || body.term === '1' ? 1 : null;
  if (idx == null) fail(400, 'term 需为 0（第一学期）或 1（第二学期）');
  const name = String(body.name || '').trim();
  if (!name || name.length > 20) fail(400, '学期名称需为 1~20 个字符');
  const start = normDate(body.start);
  const end = normDate(body.end);
  if (!start || !end) fail(400, '日期格式无效（需 YYYY-MM-DD）');
  if (start > end) fail(400, '开始日期不能晚于结束日期');
  if (start < sy.start || end > sy.end) fail(400, `日期需在${sy.label}（${sy.start} ~ ${sy.end}）范围内`);
  const cfg = store.db.settings || {};
  if (!cfg.semesterTerms || typeof cfg.semesterTerms !== 'object') cfg.semesterTerms = {};
  const terms = effectiveTerms(sy).map((t) => ({ name: t.name, start: t.start, end: t.end }));
  terms[idx] = { name, start, end };
  cfg.semesterTerms[sy.label] = terms;
  store.db.settings = cfg;
  store.save('settings');
  json(res, 200, { ok: true, schoolYear: { label: sy.label, start: sy.start, end: sy.end }, terms: effectiveTerms(sy) });
});

// ==================== 数据管理（备份 / 恢复 / 迁移 / 灰测留存，仅管理员） ====================
const { register: registerDataMgmt, oplog: dataOplog, snapshot: dataSnapshot } = require('./datamgmt');
registerDataMgmt({ route, fail, json, readBody });

// ==================== 考勤异议（修改27）：学生提交 / 权益部与学院考勤负责老师审核改判 ====================
const APPEAL_REVIEW_ROLES = ['admin', 'rights', 'collegeOfficer'];
const APPEAL_TARGET_STATUS = ['请假', '出勤'];

// 对外视图：学生侧/列表侧不回传附件 base64（公开面减小体积），仅返回数量；
// 修改28：补 reason（修复学生进度卡与审核列表理由列空白）、resolveHistory/withdrawInfo 留痕；
// opts.withAttachments 仅 mine 使用——本人可见自己上传的材料 dataUrl
function appealPublicView(a, opts = {}) {
  const view = {
    id: a.id,
    status: a.status,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    recordsCount: a.records.length,
    records: a.records,
    reason: a.reason,
    reviewInfo: a.reviewInfo || null,
    resolveInfo: a.resolveInfo || null,
    resolveHistory: a.resolveHistory || [],
    withdrawInfo: a.withdrawInfo || null,
    attachmentsCount: (a.attachments || []).length,
  };
  if (opts.withAttachments) view.attachments = a.attachments || [];
  return view;
}

// 附件校验（提交/修改共用，修改28 抽取；错误文案与 m27 测试断言逐字一致）
// 修改80：校验通过后外置为内容寻址文件，记录只存 {name, sha256, mime, size} 引用
function parseAttachments(atts) {
  if (!Array.isArray(atts)) atts = [];
  if (atts.length > 3) fail(400, '佐证材料最多 3 张');
  return atts.map((x, i) => {
    const dataUrl = String((x && x.dataUrl) || '');
    const fname = String((x && x.name) || `附件${i + 1}`).slice(0, 50);
    if (!/^data:image\/(jpeg|png|webp);base64,/.test(dataUrl)) fail(400, `第 ${i + 1} 张附件格式不支持（仅支持 jpg/png/webp 图片）`);
    if (dataUrl.length > 1.4 * 1024 * 1024) fail(400, `第 ${i + 1} 张附件超过 1MB，请压缩后上传`);
    const ref = attachments.putDataUri(dataUrl);
    if (!ref) fail(400, `第 ${i + 1} 张附件解析失败，请重新上传`);
    return { name: fname, sha256: ref.sha256, mime: ref.mime, size: ref.size };
  });
}
// 免登录异议操作的三要素身份核验（撤销/修改共用，修改28 抽取）：返回对应异议单
function ownAppealOrFail(body, id) {
  const className = String(body.className || '').trim();
  const studentId = String(body.studentId || '').trim();
  const name = String(body.name || '').trim();
  if (!className || !studentId || !name) fail(400, '请填写班级、学号和姓名');
  const stu = store.db.students.find((s) => s.className === className && s.studentId === studentId && s.name === name);
  if (!stu) fail(404, '未找到匹配的学生信息，请核对班级、学号与姓名');
  const a = store.db.appeals.find((x) => x.id === id);
  if (!a || a.className !== className || a.studentId !== studentId) fail(404, '异议单不存在');
  return a;
}

// ① 学生提交异议（免登录 + 三要素身份凭据 + 从紧限流）
route('POST', '/api/public/appeals', { public: true }, async ({ res, req, body }) => {
  if (!rateLimit(`appeal-sub:${clientIp(req)}`, 5, 60 * 1000)) fail(429, '提交过于频繁，请稍后再试');
  const className = String(body.className || '').trim();
  const studentId = String(body.studentId || '').trim();
  const name = String(body.name || '').trim();
  if (!className || !studentId || !name) fail(400, '请填写班级、学号和姓名');
  const stu = store.db.students.find((s) => s.className === className && s.studentId === studentId && s.name === name);
  if (!stu) fail(404, '未找到匹配的学生信息，请核对班级、学号与姓名');
  const ids = Array.isArray(body.sessionIds) ? [...new Set(body.sessionIds.map((x) => String(x).trim()).filter(Boolean))] : [];
  if (ids.length < 1 || ids.length > 10) fail(400, '请选择 1~10 条存在异议的考勤记录');
  const reason = String(body.reason || '').trim();
  if (reason.length < 5 || reason.length > 500) fail(400, '异议理由需为 5~500 字');
  const attachments = parseAttachments(body.attachments);
  // 逐条校验目标记录：存在 + 班级一致 + 该生当前状态为缺勤/迟到（可异议状态）
  const recordSnaps = ids.map((sid, i) => {
    const session = store.db.attendance.find((s) => s.id === sid);
    if (!session || session.className !== className) fail(400, `第 ${i + 1} 条记录不存在或不属于可异议状态`);
    const item = (session.items || []).find((it) => it.studentId === studentId);
    if (!item || (item.status !== '缺勤' && item.status !== '迟到')) fail(400, `第 ${i + 1} 条记录不存在或不属于可异议状态`);
    return { sessionId: sid, date: session.date, periods: [...(session.periods || [])], status: item.status };
  });
  // 防重复提交：同记录存在处理中（待审核/已通过未办结）的异议单时禁止再提（rejected/resolved 可再提）
  const activeSids = new Set(
    store.db.appeals.filter((a) => a.status === 'pending' || a.status === 'approved').flatMap((a) => a.records.map((r) => r.sessionId))
  );
  for (const sid of ids) {
    if (activeSids.has(sid)) fail(409, '所选记录中存在处理中的异议，请勿重复提交');
  }
  const appeal = {
    id: uid('apl'),
    className,
    studentId,
    studentName: stu.name,
    records: recordSnaps,
    reason,
    attachments,
    status: 'pending',
    createdAt: nowISO(),
    updatedAt: nowISO(),
    reviewInfo: null,
    resolveInfo: null,
  };
  store.db.appeals.push(appeal);
  store.save('appeals');
  json(res, 200, { appeal: { id: appeal.id, status: appeal.status, createdAt: appeal.createdAt, recordsCount: appeal.records.length } });
});

// ② 学生查询本人异议进度（免登录 + 三要素；独立接口：不触碰自查 query 契约、限流键分离、支持提交后局部刷新）
// 注意：必须注册在 GET /api/appeals/:id 之前，否则 mine 会被 :param 吞掉
route('GET', '/api/public/appeals/mine', { public: true }, async ({ res, req, query }) => {
  if (!rateLimit(`appeal-q:${clientIp(req)}`, 10, 60 * 1000)) fail(429, '查询过于频繁，请稍后再试');
  const className = String(query.className || '').trim();
  const studentId = String(query.studentId || '').trim();
  const name = String(query.name || '').trim();
  if (!className || !studentId || !name) fail(400, '请填写班级、学号和姓名');
  const stu = store.db.students.find((s) => s.className === className && s.studentId === studentId && s.name === name);
  if (!stu) fail(404, '未找到匹配的学生信息，请核对班级、学号与姓名');
  const list = store.db.appeals
    .filter((a) => a.className === className && a.studentId === studentId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map((a) => attachments.hydrateAppeal(appealPublicView(a, { withAttachments: true })));
  json(res, 200, { appeals: list });
});

// ②-1 学生撤销异议（免登录 + 三要素，修改28）：仅 pending 可撤 → withdrawn 终态（保留痕迹、记录释放可再提）
route('POST', '/api/public/appeals/:id/withdraw', { public: true }, async ({ res, req, params, body }) => {
  if (!rateLimit(`appeal-w:${clientIp(req)}`, 5, 60 * 1000)) fail(429, '操作过于频繁，请稍后再试');
  const a = ownAppealOrFail(body, params.id);
  if (a.status !== 'pending') fail(409, '仅待审核的异议可以撤销');
  a.status = 'withdrawn';
  a.withdrawInfo = { withdrawnAt: nowISO(), studentName: a.studentName };
  a.updatedAt = nowISO();
  store.save('appeals');
  dataOplog(null, '考勤异议撤销', `${a.id} ${a.className} ${a.studentName} 学生自主撤销`);
  json(res, 200, { appeal: appealPublicView(a) });
});

// ②-2 学生修改待审核异议（免登录 + 三要素，修改28）：仅 pending 可改，只改理由与佐证材料（记录不可换）
route('POST', '/api/public/appeals/:id/edit', { public: true }, async ({ res, req, params, body }) => {
  if (!rateLimit(`appeal-e:${clientIp(req)}`, 5, 60 * 1000)) fail(429, '操作过于频繁，请稍后再试');
  const a = ownAppealOrFail(body, params.id);
  if (a.status !== 'pending') fail(409, '仅待审核的异议可以修改');
  const reason = String(body.reason || '').trim();
  if (reason.length < 5 || reason.length > 500) fail(400, '异议理由需为 5~500 字');
  const attachments = parseAttachments(body.attachments);
  a.reason = reason;
  a.attachments = attachments;
  a.updatedAt = nowISO();
  store.save('appeals');
  dataOplog(null, '考勤异议修改', `${a.id} ${a.className} ${a.studentName} 学生修改理由/材料`);
  json(res, 200, { appeal: attachments.hydrateAppeal(a) });
});

// ②-3 已办结重新判定（登录态，修改28）：admin/collegeOfficer 恒可，rights 须为本单审核人/改判人；
// 目标状态=请假/出勤/恢复原状态（按 resolveHistory 倒序取最近 applied=true 的 from 回滚）；旧 resolveInfo 移入 resolveHistory 留痕
route('POST', '/api/appeals/:id/reresolve', { roles: APPEAL_REVIEW_ROLES }, async ({ res, params, body, user }) => {
  const a = store.db.appeals.find((x) => x.id === params.id);
  if (!a) fail(404, '异议单不存在');
  const isOwner =
    String((a.reviewInfo && a.reviewInfo.reviewer) || '').endsWith(`(${user.username})`) ||
    String((a.resolveInfo && a.resolveInfo.resolver) || '').endsWith(`(${user.username})`);
  const canRe = hasAnyRole(user, ['admin', 'collegeOfficer']) || (hasRole(user, 'rights') && isOwner);
  if (!canRe) fail(403, '仅管理员、学院考勤负责老师或该单审核人可重新判定');
  if (a.status !== 'resolved') fail(409, '仅已办结的异议可以重新判定');
  const REVERT = '恢复原状态';
  const reqItems = Array.isArray(body.items) ? body.items : [];
  const toMap = new Map(reqItems.map((x) => [String((x && x.sessionId) || ''), String((x && x.to) || '')]));
  // 恢复原状态推导：倒序扫历史轮次（当前 resolveInfo 优先，再扫 resolveHistory）取最近 applied=true 的 from
  const rounds = [a.resolveInfo, ...(a.resolveHistory || [])].filter(Boolean);
  const lastAppliedFrom = (sid) => {
    for (const rd of rounds) {
      const hit = (rd.items || []).find((x) => x.sessionId === sid && x.applied);
      if (hit) return hit.from;
    }
    const rec = a.records.find((r) => r.sessionId === sid);
    return rec ? rec.status : '';
  };
  for (const r of a.records) {
    const to = toMap.get(r.sessionId);
    if (to !== REVERT && !APPEAL_TARGET_STATUS.includes(to)) fail(400, '请为全部记录选择目标状态（请假、出勤或恢复原状态）');
  }
  const resolveItems = [];
  for (const r of a.records) {
    const to = toMap.get(r.sessionId);
    const hasAppliedHistory = rounds.some((rd) => (rd.items || []).some((x) => x.sessionId === r.sessionId && x.applied));
    // 「恢复原状态」但该记录从未被异议改判过（无 applied 历史）→ 无可恢复内容，跳过留痕
    if (to === REVERT && !hasAppliedHistory) {
      const session0 = store.db.attendance.find((s) => s.id === r.sessionId);
      const item0 = session0 ? (session0.items || []).find((it) => it.studentId === a.studentId) : null;
      resolveItems.push({ sessionId: r.sessionId, date: r.date, from: item0 ? item0.status : '', to: REVERT, applied: false });
      continue;
    }
    const target = to === REVERT ? lastAppliedFrom(r.sessionId) : to;
    const session = store.db.attendance.find((s) => s.id === r.sessionId);
    const item = session ? (session.items || []).find((it) => it.studentId === a.studentId) : null;
    const from = item ? item.status : '';
    if (!item || from === target) {
      resolveItems.push({ sessionId: r.sessionId, date: r.date, from, to: target, applied: false });
      continue;
    }
    item.status = target;
    session.updatedBy = `${user.name}（异议重新改判）`;
    session.updatedAt = nowISO();
    resolveItems.push({ sessionId: r.sessionId, date: r.date, from, to: target, applied: true });
  }
  const changed = resolveItems.filter((x) => x.applied).length;
  if (changed > 0) store.save('attendance');
  if (!Array.isArray(a.resolveHistory)) a.resolveHistory = [];
  if (a.resolveInfo) a.resolveHistory.push({ ...a.resolveInfo });
  a.resolveInfo = { resolver: `${user.name}(${user.username})`, resolvedAt: nowISO(), isRe: true, items: resolveItems };
  a.updatedAt = nowISO();
  store.save('appeals');
  // 修改30：重新改判影响缺勤节数 → 重算该生处分
  recalcPunishmentsByPairs([{ className: a.className, studentId: a.studentId }]);
  dataOplog(user, '考勤异议重新改判', `${a.id} ${a.className} ${a.studentName}：${changed}/${resolveItems.length} 条重判（历史 ${a.resolveHistory.length} 轮）`);
  json(res, 200, { appeal: attachments.hydrateAppeal(a), changed });
});

// ③ 审核列表（权益部 / 学院考勤负责老师 / 管理员）
route('GET', '/api/appeals', { roles: APPEAL_REVIEW_ROLES }, async ({ res, query }) => {
  let list = store.db.appeals.slice();
  const st = String(query.status || 'pending');
  if (st !== 'all') list = list.filter((a) => a.status === st);
  if (query.className) list = list.filter((a) => a.className === query.className);
  // 修改61：班级多选（classNames 逗号分隔）——不传 = 不过滤
  if (query.classNames) {
    const set = new Set(String(query.classNames).split(',').map((x) => x.trim()).filter(Boolean));
    if (set.size) list = list.filter((a) => set.has(a.className));
  }
  if (query.q) {
    const q = query.q.trim();
    list = list.filter((a) => [a.studentName, a.studentId, a.reason].some((v) => String(v || '').includes(q)));
  }
  list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const rows = list.map((a) => {
    const dates = a.records.map((r) => r.date).sort();
    return {
      ...appealPublicView(a),
      studentId: a.studentId,
      studentName: a.studentName,
      className: a.className,
      firstDate: dates[0] || '',
      lastDate: dates[dates.length - 1] || '',
    };
  });
  json(res, 200, paginate(rows, query.page, query.pageSize));
});

// ④ 审核详情（此处才返回附件 dataUrl，列表不带图）
route('GET', '/api/appeals/:id', { roles: APPEAL_REVIEW_ROLES }, async ({ res, params }) => {
  const a = store.db.appeals.find((x) => x.id === params.id);
  if (!a) fail(404, '异议单不存在');
  // 修改70：详情返回原始完整对象（审核角色可见学生姓名/学号/班级，不可走脱敏视图
  // appealPublicView——它会丢弃 studentName/studentId/className，导致弹窗头部空白），
  // 并补充 recordsCount / attachmentsCount 两个计算字段——此前直接返回原始对象缺这两个，
  // 前端模板读到 undefined 显示「记录 undefined 条 · 附件 undefined/3」。
  json(res, 200, { appeal: { ...attachments.hydrateAppeal(a), recordsCount: a.records.length, attachmentsCount: (a.attachments || []).length } });
});

// ⑤ 审核判定：pending → approved / rejected（终态锁定）
route('POST', '/api/appeals/:id/review', { roles: APPEAL_REVIEW_ROLES }, async ({ res, params, body, user }) => {
  const a = store.db.appeals.find((x) => x.id === params.id);
  if (!a) fail(404, '异议单不存在');
  const decision = String(body.decision || '');
  if (decision !== 'approved' && decision !== 'rejected') fail(400, 'decision 需为 approved 或 rejected');
  if (a.status !== 'pending') fail(409, '该异议已审核过');
  const comment = String(body.comment || '').trim();
  if (comment.length > 300) fail(400, '审核意见需为 300 字以内');
  if (decision === 'rejected' && !comment) fail(400, '驳回时必须填写审核意见');
  a.reviewInfo = { reviewer: `${user.name}(${user.username})`, reviewedAt: nowISO(), decision, comment };
  a.status = decision;
  a.updatedAt = nowISO();
  store.save('appeals');
  dataOplog(user, '考勤异议审核', `${a.id} ${a.className} ${a.studentName} → ${decision === 'approved' ? '通过' : '驳回'}`);
  json(res, 200, { appeal: attachments.hydrateAppeal(a) });
});

// ⑥ 执行改判并办结（一致性核心）：approved → resolved
// 仅允许把「缺勤/迟到」改为「请假/出勤」；改前逐条二次校验当前状态，不满足则跳过留痕（applied=false）；
// 全部校验通过后统一保存一次 attendance（先全量校验后落盘，避免半程失败）；resolved 再 resolve 一律 409（幂等防重改）
route('POST', '/api/appeals/:id/resolve', { roles: APPEAL_REVIEW_ROLES }, async ({ res, params, body, user }) => {
  const a = store.db.appeals.find((x) => x.id === params.id);
  if (!a) fail(404, '异议单不存在');
  if (a.status === 'resolved') fail(409, '该异议已办结');
  if (a.status !== 'approved') fail(409, '该异议尚未审核通过，不能执行改判');
  const reqItems = Array.isArray(body.items) ? body.items : [];
  const toMap = new Map(reqItems.map((x) => [String((x && x.sessionId) || ''), String((x && x.to) || '')]));
  for (const r of a.records) {
    const to = toMap.get(r.sessionId);
    if (!APPEAL_TARGET_STATUS.includes(to)) fail(400, '请为全部记录选择目标状态（请假或出勤）');
  }
  const resolveItems = [];
  for (const r of a.records) {
    const to = toMap.get(r.sessionId);
    const session = store.db.attendance.find((s) => s.id === r.sessionId);
    const item = session ? (session.items || []).find((it) => it.studentId === a.studentId) : null;
    const from = item ? item.status : '';
    if (!item || (from !== '缺勤' && from !== '迟到')) {
      // 当前状态已不是可改判状态（如已被假单对账改判）——跳过并留痕，不整单失败
      resolveItems.push({ sessionId: r.sessionId, date: r.date, from, to, applied: false });
      continue;
    }
    item.status = to;
    session.updatedBy = `${user.name}（异议改判）`;
    session.updatedAt = nowISO();
    // 修改81：异议改判写入修改日志（操作人=审核人，via 标注来源）
    appendAttendanceLog({
      id: uid('alog'),
      sessionId: session.id,
      action: 'update',
      at: session.updatedAt,
      operator: attendanceLogOperator(user),
      via: '异议改判',
      changes: [{ studentId: a.studentId, name: a.studentName, field: 'status', before: from, after: to }],
    });
    resolveItems.push({ sessionId: r.sessionId, date: r.date, from, to, applied: true });
  }
  const changed = resolveItems.filter((x) => x.applied).length;
  if (changed > 0) {
    store.save('attendance');
    store.save('attendanceLogs');
  }
  a.resolveInfo = { resolver: `${user.name}(${user.username})`, resolvedAt: nowISO(), items: resolveItems };
  a.status = 'resolved';
  a.updatedAt = nowISO();
  store.save('appeals');
  // 修改30：异议改判影响缺勤节数 → 重算该生处分（可能自动撤销/生成）
  recalcPunishmentsByPairs([{ className: a.className, studentId: a.studentId }]);
  dataOplog(user, '考勤异议改判', `${a.id} ${a.className} ${a.studentName}：${changed}/${resolveItems.length} 条改判（明细见异议单）`);
  json(res, 200, { appeal: attachments.hydrateAppeal(a), changed });
});

// ==================== 处分管理路由（修改30） ====================
// 列表：5 类角色可查看；班主任 / 辅导员经 teacherScope 只见所带班级；纪律委员不可见
route('GET', '/api/punishments', { roles: PUNISH_VIEW_ROLES }, async ({ res, user, query }) => {
  const scope = teacherScope(user); // null = 全院可见；数组 = 仅所带班级
  let list = (store.db.punishments || []).slice();
  if (scope) list = list.filter((p) => scope.includes(p.className));
  const status = ['active', 'revoked', 'all'].includes(query.status) ? query.status : 'active';
  if (status === 'active') list = list.filter((p) => !p.revokedAt);
  if (status === 'revoked') list = list.filter((p) => p.revokedAt);
  const className = String(query.className || '').trim();
  if (className) list = list.filter((p) => p.className === className);
  // 修改61：班级多选（classNames 逗号分隔）——不传 = 不过滤
  if (query.classNames) {
    const punSet = new Set(String(query.classNames).split(',').map((x) => x.trim()).filter(Boolean));
    if (punSet.size) list = list.filter((p) => punSet.has(p.className));
  }
  const q = String(query.q || '').trim();
  if (q) list = list.filter((p) => [p.studentName, p.sid].some((v) => String(v || '').includes(q)));
  const levelIndex = Number(query.levelIndex);
  if (Number.isInteger(levelIndex) && levelIndex >= 0 && String(query.levelIndex || '') !== '') list = list.filter((p) => p.levelIndex === levelIndex);
  list.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
  const classes = [...new Set(store.db.students.map((s) => s.className))].sort();
  const classMeta = classMetaOf(); // 修改61：带年级的班级元数据（树形组件分组需要）
  json(res, 200, {
    total: list.length,
    classes,
    classMeta, // 修改61：带年级元数据；classes 保留兼容既有消费方
    levelNames: PUNISHMENT_LEVELS.map((l) => l.level),
    list: list.slice(0, 500).map((p) => ({
      id: p.id,
      className: p.className,
      studentName: p.studentName,
      sid: p.sid,
      grade: p.grade || '',
      level: p.level,
      levelIndex: p.levelIndex,
      levelRange: p.levelRange || '',
      firstJie: p.firstJie ?? p.totalJie,        // 最早认定节数（首次达到该区间下限时的累计节数）
      totalJie: p.totalJie,
      firstReachAt: p.firstReachAt || p.createdAt, // 首次达到该区间的时间点
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      currentTotalJie: currentTotalJieOf(p.className, p.sid), // 截止目前的累计缺勤节数（实时）
      revokedAt: p.revokedAt || null,
      revokeInfo: p.revokeInfo || null,
    })),
  });
});

// 详情：含触发明细快照（具体由哪几节课缺勤/迟到导致）；实时节数供比对
route('GET', '/api/punishments/:id', { roles: PUNISH_VIEW_ROLES }, async ({ res, user, params }) => {
  const p = (store.db.punishments || []).find((x) => x.id === params.id);
  if (!p) fail(404, '处分记录不存在');
  const scope = teacherScope(user);
  if (scope && !scope.includes(p.className)) fail(403, '该学生不在你所带班级范围内');
  // 读时自愈：查看详情时幂等重算该生，保证明细与最新考勤一致（可能触发撤销/恢复）
  const stu = store.db.students.find((s) => s.className === p.className && s.studentId === p.sid);
  if (stu) recalcPunishmentsForStudent(stu);
  const cur = (store.db.punishments || []).find((x) => x.id === params.id) || p;
  json(res, 200, {
    punishment: {
      ...cur,
      records: cur.records || [],
      currentTotalJie: currentTotalJieOf(cur.className, cur.sid),
    },
  });
});

// 修改30 补记：启动时对全部学生幂等补算处分。历史存量缺勤不经写路径钩子（钩子只覆盖部署后的
// 新增写操作），读时自愈又仅挂学生自查——若无回溯，存量缺勤者的处分永远为空。
// 幂等：已一致的学生零改动；统一 save 一次；重复启动无副作用。
function backfillAllPunishments() {
  const students = store.db.students || [];
  const t0 = Date.now();
  let touched = 0;
  for (const stu of students) {
    if (recalcPunishmentsForStudent(stu)) touched++;
  }
  if (touched) store.save('punishments');
  console.log(`[punishments] 启动补算完成：${students.length} 名学生核查，${touched} 人生成/更新处分（${Date.now() - t0}ms）`);
}

// 修改80 补记：启动时把存量内嵌 base64（点名签名 / 异议佐证材料）一次性外置为内容寻址文件。
// 幂等：已是引用形态的记录零改动；重复启动无副作用。迁移前自动打一份完整快照（可整体回滚）。
// 单条转换失败保留原样并计数，不阻塞启动；读取侧双读兼容，半迁移状态照常可用。
function externalizeAllAttachments() {
  return attachments.externalizeAllAttachments({
    store,
    snapshot: () => {
      const meta = dataSnapshot('附件外置迁移前自动快照');
      console.log(`[attachments] 已保存迁移前快照：${meta.id}（回滚可恢复内嵌形态数据）`);
    },
  });
}

module.exports = { handle, reconcileStudentDate, backfillAllPunishments, externalizeAllAttachments };
