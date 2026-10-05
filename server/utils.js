'use strict';
const crypto = require('crypto');

// ---------- 业务常量 ----------
// 节次（修改18 扩展：早自习在最前，9-10节/晚自习在 7-8节 之后）
const PERIODS = ['早自习', '1-2节', '3-4节', '5-6节', '7-8节', '9-10节', '晚自习'];
// 节数权重：常规节次记 2 节，早自习/晚自习记 1 节
const PERIOD_JIE = { 早自习: 1, '1-2节': 2, '3-4节': 2, '5-6节': 2, '7-8节': 2, '9-10节': 2, 晚自习: 1 };
// 迟到折算：按"次"计，一条迟到记录恒折 0.5 节（与记录覆盖几个节次无关）
const LATE_JIE = 0.5;
/** 缺勤记录节数：各节次按权重求和 */
function jieSumOf(periods) {
  return (Array.isArray(periods) ? periods : []).reduce((sum, p) => sum + (PERIOD_JIE[p] || 0), 0);
}
const STATUSES = ['出勤', '迟到', '缺勤', '请假'];
const LEAVE_TYPES = ['公假', '病假', '事假', '其他'];

// ---------- 处分等级（修改30）----------
// 与用户提供的处分对照表一致：0-10 通报批评 / 10.5-14.5 院级警告 / 15-20 校级警告 /
// 20.5-40 校级严重警告 / 40.5-60 校级记过 / 60.5-80 校级留校察看 / >80 校级劝退。
// min 为「达标下限」：累计缺勤节数（含迟到每次折 0.5 节，与统计/公示口径一致）≥ min 即触发该等级；
// 0 节（无任何缺勤/迟到）不产生处分，故最低档 min 取 0.5。
// 数组顺序即等级从低到高，levelIndex 越大处分越重。
const PUNISHMENT_LEVELS = [
  { level: '通报批评', min: 0.5, max: 10 },
  { level: '院级警告', min: 10.5, max: 14.5 },
  { level: '校级警告', min: 15, max: 20 },
  { level: '校级严重警告', min: 20.5, max: 40 },
  { level: '校级记过', min: 40.5, max: 60 },
  { level: '校级留校察看', min: 60.5, max: 80 },
  { level: '校级劝退', min: 80.5, max: Infinity },
];
/** 累计缺勤节数对应的最高处分等级下标（未达任何等级返回 -1） */
function punishmentIndexOf(totalJie) {
  let idx = -1;
  for (let i = 0; i < PUNISHMENT_LEVELS.length; i++) {
    if (totalJie >= PUNISHMENT_LEVELS[i].min) idx = i;
    else break;
  }
  return idx;
}
const ROLE_NAMES = { admin: '管理员', rights: '权益部', discipline: '纪律委员', headTeacher: '班主任', counselor: '辅导员', collegeOfficer: '学院考勤负责老师' };
// 特权角色：仅 admin 可创建/修改/删除此类账号，或把账号角色改为其中之一（防 collegeOfficer 提权）
const PRIVILEGED_ROLES = ['admin', 'collegeOfficer'];

// ---------- 基础工具 ----------
function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}
function nowISO() {
  return new Date().toISOString();
}
function fmtDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ---------- 密码 ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(8).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `${salt}$${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split('$');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(String(password), salt, 32).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
  } catch {
    return false;
  }
}

// ---------- HTTP 工具 ----------
function json(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('JSON 格式错误'));
      }
    });
    req.on('error', reject);
  });
}

// ---------- 业务字段归一化 ----------
/**
 * 修改69：归一化年级 —— 把混写的「2025级」「2025」「人工智能2502」统一为「2025级」。
 * 规则与前端 public/js/gradeClassCascade.js 的 normGrade 逐字符等价（前后端口径必须一致）。
 * 用途：① 缺勤统计的 gradeN 比较；② 班级元数据的 grade 字段；③ /api/students 的 grade 过滤。
 * 背景：前端年级下拉统一传归一化值「YYYY级」，若库里存的是「2025」，精确相等会一条都查不到。
 */
function normGrade(v) {
  const m = String(v || '').match(/(19|20)\d{2}/);
  return m ? `${m[0]}级` : String(v || '');
}

/** 归一化日期：支持 2026-9-1 / 2026/9/1 / 2026年9月1日，返回 YYYY-MM-DD 或 null */
function normDate(s) {
  const t = String(s ?? '').trim().replace(/年|月|\//g, '-').replace(/日/g, '');
  const m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (d.getFullYear() !== +m[1] || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) return null;
  return `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
}

/** 归一化节次：支持 "1-2节/3-4节/9-10节"、"早自习/晚自习"、"1-2、9-10"、"全天"、空（视为全天） */
function normPeriods(s) {
  const t = String(s ?? '').trim();
  if (!t || t.includes('全天') || t.includes('全部')) return { periods: [...PERIODS] };
  const parts = t.split(/[/、,，;；|\s]+/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    let label = PERIODS.includes(p) ? p : null;
    if (!label) {
      const m = p.match(/^([1-9]|10)\s*[-—~]\s*([1-9]|10)$/);
      if (m) label = PERIODS.find((x) => x === `${m[1]}-${m[2]}节`) || null;
    }
    if (!label) return { error: `无法识别节次"${p}"（可用：早自习、1-2节、3-4节、5-6节、7-8节、9-10节、晚自习，多节用 / 分隔，或填"全天"）` };
    if (!out.includes(label)) out.push(label);
  }
  if (!out.length) return { error: '节次为空' };
  out.sort((a, b) => PERIODS.indexOf(a) - PERIODS.indexOf(b));
  return { periods: out };
}

/** 归一化时间：支持 8:00 / 08:00 / 8：30，返回 HH:MM 或 null */
function normTime(s) {
  const m = String(s ?? '').trim().match(/^(\d{1,2})[:：.](\d{1,2})(?::\d{1,2})?$/);
  if (!m) return null;
  const h = +m[1];
  const min = +m[2];
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** 归一化假别 */
function normLeaveType(s) {
  const t = String(s ?? '').trim();
  if (!t) return '其他';
  if (t.includes('公')) return '公假';
  if (t.includes('病')) return '病假';
  if (t.includes('事')) return '事假';
  if (LEAVE_TYPES.includes(t)) return t;
  return '其他';
}

// ---------- 学年 / 学期（缺勤公示用） ----------
/**
 * 计算某日期所属学年：9/1 ~ 次年 7/31（8 月归属旧学年）。
 * 返回 { startYear, start, end, label }，日期均为 YYYY-MM-DD。
 */
function schoolYearOf(d = new Date()) {
  const y = d.getFullYear();
  const startYear = d.getMonth() + 1 >= 9 ? y : y - 1;
  return {
    startYear,
    start: `${startYear}-09-01`,
    end: `${startYear + 1}-07-31`,
    label: `${startYear}-${startYear + 1}学年`,
  };
}

/**
 * 学年默认学期划分：第一学期 9/1~次年1/31，第二学期 次年2/1~7/31。
 * 管理员未在 settings.semesterTerms 配置时使用。
 */
function defaultTerms(sy) {
  const startYear = sy && sy.startYear != null ? sy.startYear : schoolYearOf().startYear;
  return [
    { name: '第一学期', start: `${startYear}-09-01`, end: `${startYear + 1}-01-31` },
    { name: '第二学期', start: `${startYear + 1}-02-01`, end: `${startYear + 1}-07-31` },
  ];
}

function paginate(list, page, pageSize) {
  page = Math.max(1, parseInt(page, 10) || 1);
  pageSize = Math.min(200, Math.max(1, parseInt(pageSize, 10) || 20));
  return {
    page,
    pageSize,
    total: list.length,
    list: list.slice((page - 1) * pageSize, page * pageSize),
  };
}

module.exports = {
  PERIODS,
  PERIOD_JIE,
  LATE_JIE,
  jieSumOf,
  STATUSES,
  LEAVE_TYPES,
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
  normGrade,
  normTime,
  normPeriods,
  normLeaveType,
  schoolYearOf,
  defaultTerms,
  paginate,
};
