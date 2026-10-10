'use strict';
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { uid, nowISO, hashPassword, PERIODS } = require('./utils');

const DATA_DIR = path.join(__dirname, '..', 'data');
// 修改81：attendanceLogs（考勤修改日志）为后增集合，随通用 load/save 生效
const COLLECTIONS = ['users', 'students', 'attendance', 'leaves', 'tokens', 'appeals', 'punishments', 'attendanceLogs'];
const db = {};

// 登录态签名密钥：持久化于 data/secret.key。无状态签名 token 依赖它；
// 进程重启 / 平台多实例调度（共享同一 data 卷）时密钥保持一致，登录态不丢失。
let SECRET = '';
function loadSecret() {
  const f = path.join(DATA_DIR, 'secret.key');
  try {
    const s = fs.readFileSync(f, 'utf8').trim();
    if (s) return s;
  } catch {
    /* 不存在则生成 */
  }
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(f, s, 'utf8');
  return s;
}
function secret() {
  if (!SECRET) SECRET = loadSecret();
  return SECRET;
}

// 上课时间段基准（权益部可在"假单管理 → 上课时间段设置"中调整）
const DEFAULT_PERIOD_TIMES = {
  早自习: { start: '07:00', end: '07:40' },
  '1-2节': { start: '08:00', end: '09:40' },
  '3-4节': { start: '10:00', end: '11:40' },
  '5-6节': { start: '14:00', end: '15:40' },
  '7-8节': { start: '16:00', end: '17:40' },
  '9-10节': { start: '18:30', end: '20:10' },
  晚自习: { start: '20:30', end: '21:30' },
};

function fileOf(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

/** 原子写入（先写临时文件再改名），避免写一半损坏 */
function save(name) {
  const target = fileOf(name);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db[name], null, 2), 'utf8');
  fs.renameSync(tmp, target);
}

function load(name) {
  const f = fileOf(name);
  if (fs.existsSync(f)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
      // ⚠️ tokens 是对象映射（token -> {userId}），其余集合均为数组；此前"非数组一律置空"
      // 会把 tokens 表在每次重启时清空 → 所有登录态失效（用户表现为登录约 2 分钟后被踢）
      const ok = name === 'tokens'
        ? (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        : Array.isArray(parsed);
      if (ok) {
        db[name] = parsed;
        return;
      }
    } catch (e) {
      console.error(`[store] 读取 ${name}.json 失败，将重新初始化：`, e.message);
    }
  }
  db[name] = name === 'tokens' ? {} : [];
}

function init() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  COLLECTIONS.forEach(load);
  // 多角色兼容迁移：为旧账号补 roles 数组（主角色在前，保持 role 字段不变）
  let rolesMigrated = false;
  for (const u of db.users || []) {
    const extra = Array.isArray(u.roles) ? u.roles.filter((r) => r && r !== u.role) : [];
    const roles = u.role ? [u.role, ...extra] : extra;
    if (JSON.stringify(u.roles) !== JSON.stringify(roles)) {
      u.roles = roles;
      rolesMigrated = true;
    }
  }
  if (rolesMigrated) save('users');
  // 上课时间段配置（对象结构，与数组型集合分开处理）
  const settingsFile = fileOf('settings');
  if (fs.existsSync(settingsFile)) {
    try {
      db.settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    } catch {
      db.settings = null;
    }
  }
  if (!db.settings || !db.settings.periodTimes) {
    db.settings = { periodTimes: JSON.parse(JSON.stringify(DEFAULT_PERIOD_TIMES)) };
    save('settings');
  }
  // 节次扩展加法迁移（修改18）：periodTimes 缺失的节次键用默认值补齐，保留用户已自定义的时间（只增不改不删）
  let timesMigrated = false;
  for (const p of PERIODS) {
    const t = db.settings.periodTimes[p];
    if (!t || !t.start || !t.end) {
      db.settings.periodTimes[p] = { ...DEFAULT_PERIOD_TIMES[p] };
      timesMigrated = true;
    }
  }
  if (timesMigrated) save('settings');
  // 教职工名单：文件缺失时以空名单初始化（在「账号管理 → 教职工名单」中维护）
  const staffFile = fileOf('staffs');
  if (!fs.existsSync(staffFile)) {
    db.staffs = defaultStaffs();
    save('staffs');
  } else {
    try {
      const parsed = JSON.parse(fs.readFileSync(staffFile, 'utf8'));
      db.staffs = Array.isArray(parsed) ? parsed : defaultStaffs();
    } catch {
      db.staffs = defaultStaffs();
    }
    if (!Array.isArray(db.staffs)) db.staffs = defaultStaffs();
  }

  // 修改72：班级管理集合（classes）—— 游离于 COLLECTIONS 之外，与 staffs 同构的独立分支。
  // 班级名为主键（与 students.className / user.classes 同口径字符串），默认空表，
  // 由「班级管理」页维护或从学生名单存量迁移生成。
  const clsFile = fileOf('classes');
  if (!fs.existsSync(clsFile)) {
    db.classes = [];
    save('classes');
  } else {
    try {
      const parsed = JSON.parse(fs.readFileSync(clsFile, 'utf8'));
      db.classes = Array.isArray(parsed) ? parsed : [];
    } catch {
      db.classes = [];
    }
    if (!Array.isArray(db.classes)) db.classes = [];
  }

  // 假单日期字段迁移：旧版单日 date → startDate/endDate
  let migrated = false;
  for (const lv of db.leaves) {
    if (!lv.startDate && lv.date) {
      lv.startDate = lv.date;
      lv.endDate = lv.endDate || lv.date;
      delete lv.date;
      migrated = true;
    }
  }
  if (migrated) save('leaves');
  // 学生年级回填：旧数据无年级时按学号前四位推导（如 202301001 → 2023级）
  let graded = false;
  for (const s of db.students) {
    if (s.grade === undefined) {
      s.grade = /^\d{4}/.test(s.studentId || '') ? `${s.studentId.slice(0, 4)}级` : '';
      graded = true;
    }
  }
  if (graded) save('students');
  // 点名确认令牌回填：旧记录无 confirmToken 时生成（任课老师免登录签字确认用）
  let tokened = false;
  for (const a of db.attendance) {
    if (!a.confirmToken) {
      a.confirmToken = uid('ctk') + uid('ctk').slice(4);
      if (!a.confirmStatus) a.confirmStatus = 'pending';
      tokened = true;
    }
  }
  if (tokened) save('attendance');
  if (!db.users.length) {
    seed();
    console.log('[store] 初始化完成：已创建管理员账号（admin / admin123），请登录后在界面中导入班级名单');
  }
}

function getPeriodTimes() {
  return (db.settings && db.settings.periodTimes) || DEFAULT_PERIOD_TIMES;
}

/** 默认教职工名单（生产模式为空，由用户在「账号管理 → 教职工名单」中维护） */
function defaultStaffs() {
  return [];
}

// ==================== 首次启动初始化（生产模式） ====================
/**
 * 仅确保存在管理员账号（admin / admin123）。
 * ⚠️ 修改58 数据安全加固：原实现在这里把 students / attendance / leaves / tokens /
 *    appeals / punishments 全部重置为 [] 并立即落盘。触发条件只有一个——users.json
 *    为空（首次部署，或 users.json 损坏 / 数据卷异常）。后者会把「账号文件损坏」
 *    放大成「全库数据被清空」，违反数据安全铁律（任何修改不得导致数据被重置/清空）。
 *    首次部署时这些集合本来就是空数组，行为不变；数据异常场景则只补管理员、不碰业务数据。
 */
function seed() {
  if (!db.users.some((u) => u.username === 'admin')) {
    db.users.push({
      id: uid('u'),
      username: 'admin',
      name: '系统管理员',
      role: 'admin',
      classes: [],
      enabled: true,
      passwordHash: hashPassword('admin123'),
      createdAt: nowISO(),
    });
  }
  if (!db.settings || !db.settings.periodTimes) {
    db.settings = { periodTimes: JSON.parse(JSON.stringify(DEFAULT_PERIOD_TIMES)) };
  }
  if (!Array.isArray(db.staffs)) db.staffs = [];
  if (!Array.isArray(db.classes)) db.classes = [];
  save('users');
  save('settings');
  save('staffs');
  save('classes');
}

module.exports = { db, init, save, getPeriodTimes, DEFAULT_PERIOD_TIMES, secret };
