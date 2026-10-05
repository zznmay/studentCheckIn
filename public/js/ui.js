// ==================== 业务常量 ====================
import { api, apiDownload } from './api.js';

export const PERIODS = ['早自习', '1-2节', '3-4节', '5-6节', '7-8节', '9-10节', '晚自习'];
export const STATUSES = ['出勤', '迟到', '缺勤', '请假'];
export const STATUS_CLS = { 出勤: 'green', 迟到: 'orange', 缺勤: 'red', 请假: 'blue' };
export const ROLE_NAMES = { admin: '管理员', rights: '权益部', discipline: '纪律委员', headTeacher: '班主任', counselor: '辅导员', collegeOfficer: '学院考勤负责老师' };
// 特权角色：账号的创建/修改/删除仅管理员可为（与服务端 server/utils.js 保持一致）
export const PRIVILEGED_ROLES = ['admin', 'collegeOfficer'];
export const LEAVE_TYPES = ['公假', '病假', '事假', '其他'];

// 修改30：处分等级（与后端 utils.js PUNISHMENT_LEVELS 保持一致；数组顺序 = 等级从低到高）
export const PUNISHMENT_LEVELS = [
  { level: '通报批评', min: 0.5, max: 10 },
  { level: '院级警告', min: 10.5, max: 14.5 },
  { level: '校级警告', min: 15, max: 20 },
  { level: '校级严重警告', min: 20.5, max: 40 },
  { level: '校级记过', min: 40.5, max: 60 },
  { level: '校级留校察看', min: 60.5, max: 80 },
  { level: '校级劝退', min: 80.5, max: Infinity },
];
// 处分等级 → 标签配色（由轻到重：灰 → 蓝 → 橙 → 红）
export function punishmentTagCls(levelIndex) {
  if (levelIndex <= 0) return 'tag-gray';
  if (levelIndex === 1) return 'tag-blue';
  if (levelIndex === 2 || levelIndex === 3) return 'tag-orange';
  return 'tag-red';
}

// ==================== 图标（feather 风格） ====================
// width/height 显式给定，避免 SVG 无尺寸时按 300×150 默认值渲染成巨大图形
const I = (inner) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
export const ICONS = {
  logo: I('<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>'),
  grid: I('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>'),
  chevron: I('<polyline points="15 18 9 12 15 6"/>'),
  users: I('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  list: I('<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>'),
  check: I('<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
  file: I('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>'),
  chart: I('<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>'),
  logout: I('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>'),
  back: I('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'),
  download: I('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
  upload: I('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>'),
  plus: I('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  search: I('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  menu: I('<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>'),
  book: I('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>'),
  database: I('<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>'),
  message: I('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="13" y2="12"/>'),
  gavel: I('<path d="M14 13l-8.5 8.5a2.12 2.12 0 0 1-3-3L11 10"/><path d="M16 16l6-6"/><path d="M8 8l6-6"/><path d="M9 7l8 8"/><path d="M21 11l-8-8"/><path d="M2 21h9"/>'),
  shield: I('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 11.5 11 13.5 15 9.5"/>'),
  // 修改40：设计稿两页所需补充图标（纯增量，不影响既有键）
  trash: I('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>'),
  refresh: I('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>'),
  funnel: I('<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>'),
  school: I('<path d="M3 21h18"/><path d="M5 21V8l7-5 7 5v13"/><path d="M10 21v-5h4v5"/>'),
  user: I('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  chevronR: I('<polyline points="9 18 15 12 9 6"/>'),
  // 修改44：数据统计页设计稿所需（纯增量）
  info: I('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'),
  cap: I('<path d="M22 10L12 5 2 10l10 5 10-5z"/><path d="M6 12.5V17c0 1.5 2.7 2.8 6 2.8s6-1.3 6-2.8v-4.5"/>'),
  clock: I('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
  calendar: I('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
  // 修改45：班级汇总/学生明细/月报卡所需（纯增量）
  checkC: I('<circle cx="12" cy="12" r="10"/><polyline points="8 12.5 11 15.5 16 9.5"/>'),
  alert: I('<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16.5" x2="12.01" y2="16.5"/>'),
  pie: I('<path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>'),
  // 修改49：点名详情手机端（设计图底部操作栏 / 备注行 / 确认链接）
  save: I('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>'),
  gear: I('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  pencil: I('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  link: I('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  // 修改53：手机端主题开关（白天 / 暗夜）
  moon: I('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'),
  sun: I('<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>'),
  // 修改63：可搜索组合框清空钮（纯增量）
  close: I('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
};

// ==================== 工具 ====================
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function debounce(fn, wait = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}
export function statusTag(s) {
  return `<span class="tag tag-${STATUS_CLS[s] || 'gray'}">${esc(s)}</span>`;
}
export function periodTags(periods) {
  return (periods || []).map((p) => `<span class="tag tag-purple">${esc(p)}</span>`).join('');
}
export function roleTag(role) {
  const map = { admin: 'tag-red', rights: 'tag-blue', discipline: 'tag-green', headTeacher: 'tag-purple', counselor: 'tag-orange', collegeOfficer: 'tag-cyan' };
  return `<span class="tag ${map[role] || 'tag-gray'}">${ROLE_NAMES[role] || role}</span>`;
}
export function leaveTypeTag(t) {
  const map = { 公假: 'tag-blue', 病假: 'tag-orange', 事假: 'tag-gray', 其他: 'tag-gray' };
  return `<span class="tag ${map[t] || 'tag-gray'}">${esc(t)}</span>`;
}
export function countMini(counts) {
  const c = counts || {};
  return `<span class="count-mini">
    <span class="cm-green">出勤<b>${c['出勤'] ?? 0}</b></span>
    <span class="cm-orange">迟到<b>${c['迟到'] ?? 0}</b></span>
    <span class="cm-red">缺勤<b>${c['缺勤'] ?? 0}</b></span>
    <span class="cm-blue">请假<b>${c['请假'] ?? 0}</b></span>
  </span>`;
}

/** 为单张表格补 data-label（移动端卡片式布局显示字段名用） */
export function enhanceTable(table) {
  if (!table) return;
  const ths = [...table.querySelectorAll('thead th')];
  if (!ths.length) return;
  table.querySelectorAll('tbody tr').forEach((tr) => {
    [...tr.children].forEach((td, i) => {
      // 跨列单元格（空态 / 提示行）不对应任何单一字段，贴标签会显示成“日期：无明细”
      if (td.hasAttribute('colspan') || td.classList.contains('table-empty')) {
        td.removeAttribute('data-label');
        return;
      }
      const label = ths[i] ? ths[i].textContent.trim() : '';
      td.setAttribute('data-label', label);
    });
  });
}

/** 为作用域内所有表格补 data-label（移动端卡片式布局显示字段名用） */
export function enhanceTables(scope) {
  (scope || document).querySelectorAll('table').forEach(enhanceTable);
}

// ==================== 移动端记录卡片（修改38：统一复合卡片机制） ====================
/**
 * 记录型表格 → 复合卡片。仅对带 data-card 属性的表格生效：
 * 属性值为列角色映射（与 thead <th> 顺序一一对应，逗号分隔）：
 *   t 主标题   s 副标题   g 标签组   b 中部大字   d 徽章   n 右侧数值   a 右侧小字
 *   m 底部小字（整行）   x 操作区（整行）   k 勾选框   '-' 隐藏该列
 * 同一角色可出现多次（按列序依次追加）。
 * 【视口门控（修改38 补丁）】卡片仅在移动断点（≤720px）构建：单元格子节点【原样移动】
 * 进卡片以保留事件与状态（checkbox 勾选、容器委托监听不受影响）；桌面端绝不掏空 td，
 * 否则表格只剩表头和空行。跨越断点时反向还原：卡片内节点按 slot 记录的 data-td 列号
 * 移回原 td，卡片容器销毁、rcDone 标记清除，桌面表格完整如初。
 * 卡片容器 .rc-list 留在 tbody 内，保证 tbody 上的委托与查询继续命中。
 * tbody 动态重绘由 MutationObserver 兜底重建（"出现未处理 tr"判断，防自触发循环）。
 */
const rcMq = (typeof window !== 'undefined' && window.matchMedia)
  ? window.matchMedia('(max-width: 720px)')
  : { matches: false, addEventListener() {} };

/** 把已构建卡片内的节点按 data-td 列号还原回各自 td（桌面端恢复原始表格 DOM） */
function restoreCards(table) {
  const tbody = table.querySelector('tbody');
  const list = tbody && tbody.querySelector(':scope > .rc-list');
  if (!list) return;
  const trs = [...tbody.querySelectorAll(':scope > tr')];
  const cards = [...list.querySelectorAll(':scope > .rc-card')];
  // 卡片序即行序（构建时按行序生成）。行数不一致说明构建后发生过整表重绘，
  // 此时新 td 自带完整内容、旧卡片是被遗弃的孤儿，直接销毁即可。
  const pairs = cards.length === trs.length
    ? cards.map((c, i) => [c, trs[i]])
    : cards.map((c, i) => [c, trs[i]]).filter(([, tr]) => tr);
  pairs.forEach(([card, tr]) => {
    card.querySelectorAll('[data-td]').forEach((slot) => {
      const td = tr.children[Number(slot.dataset.td)];
      if (td) while (slot.firstChild) td.appendChild(slot.firstChild);
    });
  });
  list.remove();
  trs.forEach((tr) => { delete tr.dataset.rcDone; });
}

export function mobilizeCards(scope) {
  (scope || document).querySelectorAll('table[data-card]').forEach((table) => {
    const tbody = table.querySelector('tbody');
    if (!tbody) return;
    if (table._rcObs) { table._rcObs.disconnect(); table._rcObs = null; }
    // 桌面端：还原卡片 DOM（若曾从移动端切回），表格保持原样
    if (!rcMq.matches) { restoreCards(table); return; }

    const cols = (table.getAttribute('data-card') || '').split(',').map((x) => x.trim());
    const build = () => {
      const trs = [...tbody.querySelectorAll(':scope > tr')];
      if (!trs.length) return;
      let list = tbody.querySelector(':scope > .rc-list');
      // 已全部处理过且卡片仍在：跳过。卡片内节点是从 td【移入】的原始节点，
      // 盲目重建会先销毁它们、再从已被掏空的 td 里移（拿到空），因此绝不能重复构建。
      const pending = trs.some((tr) => tr.dataset.rcDone !== '1');
      if (!pending && list) return;
      const isEmpty = trs.length === 1 && trs[0].querySelector('.table-empty, td[colspan]');
      const html = isEmpty
        ? `<div class="rc-empty">${esc(trs[0].textContent.trim())}</div>`
        : trs.map((tr, ri) => rcCardHtml(tr, cols, ri)).join('');
      if (!list) {
        list = document.createElement('div');
        list.className = 'rc-list';
        tbody.appendChild(list);
      }
      list.innerHTML = html;
      // 把各 td 的子节点移动进卡片占位（保持事件与状态）
      const slots = list.querySelectorAll('[data-move-idx]');
      slots.forEach((slot) => {
        const tr = trs[Number(slot.closest('.rc-card')?.dataset.row || 0)];
        const td = tr?.children[Number(slot.dataset.moveIdx)];
        // 语义色彩继承：td 上的 cm-*/muted 传给占位项，供 CSS 圆点/配色标识
        if (td) {
          const cm = [...td.classList].filter((c) => c.startsWith('cm-') || c === 'muted');
          if (cm.length) slot.classList.add(...cm);
          while (td.firstChild) slot.appendChild(td.firstChild);
        }
      });
      // data-move-idx 用完移除；data-td 列号保留，供跨断点还原（restoreCards）定位原 td
      slots.forEach((s) => { s.dataset.td = s.dataset.moveIdx; s.removeAttribute('data-move-idx'); });
      trs.forEach((tr) => { tr.dataset.rcDone = '1'; });
      list.dataset.rcRows = String(trs.length);
    };

    build();
    // tbody 重绘（分页 / 筛选 / 轮询）后重建卡片。判断依据是"出现了未处理的 tr"，
    // 而非内容签名——节点移入卡片会改变 tbody 文本，内容签名会误判并引发自毁循环。
    table._rcObs = new MutationObserver(() => {
      if (!rcMq.matches) return; // 桌面端不构建（视口切换由全局监听处理）
      const trs = [...tbody.querySelectorAll(':scope > tr')];
      if (trs.length && trs.every((tr) => tr.dataset.rcDone === '1')) return;
      build();
    });
    table._rcObs.observe(tbody, { childList: true });
  });
}
// 跨断点（旋转屏幕 / 拖动窗口）全局重跑：移动→全量构建，桌面→全量还原。
// mobilizeCards 幂等（rcDone + pending 判断），重复调用无副作用。
if (rcMq.addEventListener) {
  rcMq.addEventListener('change', () => mobilizeCards(document));
}

/** 单行 → 卡片 DOM（占位标记后续填充，见 mobilizeCards.build） */
function rcCardHtml(tr, cols, rowIndex) {
  const zones = {};
  [...tr.children].forEach((td, i) => {
    const r = cols[i] || '-';
    if (!r || r === '-') return;
    (zones[r] = zones[r] || []).push(i);
  });
  const slot = (idx) => `<span class="rc-item" data-move-idx="${idx}"></span>`;
  const seq = (idxs) => (idxs || []).map(slot).join('');
  const has = (r) => (zones[r] || []).length;
  // 修复52：把行的 data-* 原样带到卡片上（data-id / data-staff-id 等）。
  // 手机端卡片化会把 td 里的操作按钮【移出 <tr>】移入 .rc-card，若处理器用
  // e.target.closest('tr').dataset.id 取行 id，就会拿到 null 并抛错中断——表现为
  // 「手机上点编辑/重置密码/停用/删除都没反应」。带上同名属性后，处理器改用
  // closest('tr, .rc-card') 即可两层通吃（卡片自身属性由 data-row 提供，不复制）。
  const trAttrs = [...tr.attributes]
    .filter((a) => a.name.startsWith('data-') && a.name !== 'data-rc-done' && a.name !== 'data-row')
    .map((a) => ` ${a.name}="${esc(a.value)}"`)
    .join('');
  let html = `<div class="rc-card" data-row="${rowIndex}"${trAttrs}>`;
  if (has('k')) html += `<div class="rc-k">${seq(zones.k)}</div>`;
  if (has('t') || has('s')) {
    html += `<div class="rc-id">${has('t') ? `<div class="rc-t">${seq(zones.t)}</div>` : ''}${has('s') ? `<div class="rc-s">${seq(zones.s)}</div>` : ''}</div>`;
  }
  if (has('g') || has('b')) {
    html += `<div class="rc-mid">${has('g') ? `<div class="rc-g">${seq(zones.g)}</div>` : ''}${has('b') ? `<div class="rc-b">${seq(zones.b)}</div>` : ''}</div>`;
  }
  if (has('d') || has('n') || has('a')) {
    html += `<div class="rc-side">${has('d') ? `<div class="rc-d">${seq(zones.d)}</div>` : ''}${has('n') ? `<div class="rc-n">${seq(zones.n)}</div>` : ''}${has('a') ? `<div class="rc-a">${seq(zones.a)}</div>` : ''}</div>`;
  }
  if (has('m') || has('x')) {
    html += `<div class="rc-foot">${has('m') ? `<div class="rc-m">${seq(zones.m)}</div>` : ''}${has('x') ? `<div class="rc-x">${seq(zones.x)}</div>` : ''}</div>`;
  }
  return html + '</div>';
}
export function rateCell(rate) {
  const cls = rate >= 90 ? 'good' : rate >= 80 ? 'mid' : 'bad';
  return `<div class="rate ${cls}"><div class="rate-bar"><i style="width:${Math.min(100, rate)}%"></i></div><span>${rate}%</span></div>`;
}

// ==================== 轻提示 ====================
export function toast(msg, type = 'success') {
  let box = document.querySelector('.toast-box');
  if (!box) {
    box = document.createElement('div');
    box.className = 'toast-box';
    document.body.appendChild(box);
  }
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 320);
  }, 2600);
}

// ==================== 弹窗 ====================
export function modal({ title, body, width = 520, okText = '确定', cancelText = '取消', showFooter = true, onOk, onMount }) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-mask';
  wrap.innerHTML = `
    <div class="modal" style="width:${width}px">
      <div class="modal-head"><span>${esc(title)}</span><button class="modal-x" data-act="close">×</button></div>
      <div class="modal-body">${body}</div>
      ${showFooter ? `<div class="modal-foot"><button class="btn" data-act="cancel">${esc(cancelText)}</button><button class="btn btn-primary" data-act="ok">${esc(okText)}</button></div>` : ''}
    </div>`;
  document.body.appendChild(wrap);
  // 修改37：弹窗内表格的字段名自动补齐。主视图由 app.js 的 enhanceTables(view) 兜底，
  // 但弹窗（尤其是 fetch 后异步渲染的详情表）此前依赖各页面手动调用，多处遗漏导致
  // 移动端卡片模式下字段名消失（如处分详情的触发明细）。这里统一兜底：
  // 同步内容立即扫描一次，Observer 覆盖后续异步填充；弹窗关闭时断开监听。
  // #stuBody（点名状态表）有专属紧凑布局，注入字段名反而破坏排版，跳过；
  // 需要 “thead 不转字段名” 的表格可加 data-no-card-label 属性豁免。
  const scanLabels = () => {
    wrap.querySelectorAll('table').forEach((t) => {
      if (t.closest('#stuBody') || t.closest('[data-no-card-label]')) return;
      enhanceTable(t);
    });
    mobilizeCards(wrap); // 修改38：弹窗内记录型表格同步转复合卡片
  };
  scanLabels();
  const obs = new MutationObserver(scanLabels);
  obs.observe(wrap, { childList: true, subtree: true });
  // 修改58：Esc 关闭弹窗。此前弹窗只能靠遮罩 / × / 取消 关闭，
  // 按 Esc 无反应 → 弹窗节点残留在 DOM 中不断累积（且 id 重复），
  // 后续 document.querySelector 可能命中已失效的旧弹窗。
  // 这里只关闭最上层弹窗，保证多层弹窗逐层退出。
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    const masks = document.querySelectorAll('.modal-mask');
    if (!masks.length || masks[masks.length - 1] !== wrap) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  document.addEventListener('keydown', onKey, true);
  const close = () => {
    obs.disconnect();
    document.removeEventListener('keydown', onKey, true);
    wrap.remove();
  };
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) return close();
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close' || act === 'cancel') close();
    if (act === 'ok' && onOk) {
      Promise.resolve(onOk(wrap, close)).catch((err) => toast(err.message || String(err), 'error'));
    }
  });
  if (onMount) onMount(wrap, close);
  return { close, el: wrap };
}

export function confirmDialog(message, { title = '确认操作', danger = false, okText = '确定' } = {}) {
  return new Promise((resolve) => {
    modal({
      title,
      width: 420,
      showFooter: false,
      body: `<div class="confirm-msg">${message}</div>
        <div class="modal-foot" style="border-top:0;padding:16px 0 0">
          <button class="btn" data-act="cancel">取消</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${esc(okText)}</button>
        </div>`,
      onMount(wrap, close) {
        wrap.addEventListener('click', (e) => {
          const act = e.target.closest('[data-act]')?.dataset.act;
          if (act === 'cancel') {
            close();
            resolve(false);
          }
          if (act === 'ok') {
            close();
            resolve(true);
          }
        });
      },
    });
  });
}

// ==================== 分页 ====================
export function renderPager(container, { page, pageSize, total }, onPage) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) {
    container.innerHTML = total ? '' : '';
    return;
  }
  const btns = [];
  const push = (p, label, opts = {}) =>
    btns.push(`<button data-page="${p}" ${opts.cur ? 'class="cur"' : ''} ${opts.disabled ? 'disabled' : ''}>${label}</button>`);
  push(page - 1, '‹', { disabled: page <= 1 });
  const windowStart = Math.max(1, Math.min(page - 2, pages - 4));
  const windowEnd = Math.min(pages, windowStart + 4);
  if (windowStart > 1) {
    push(1, 1);
    if (windowStart > 2) btns.push('<span class="pg-info">…</span>');
  }
  for (let p = windowStart; p <= windowEnd; p++) push(p, p, { cur: p === page });
  if (windowEnd < pages) {
    if (windowEnd < pages - 1) btns.push('<span class="pg-info">…</span>');
    push(pages, pages);
  }
  push(page + 1, '›', { disabled: page >= pages });
  container.innerHTML = btns.join('');
  container.onclick = (e) => {
    const b = e.target.closest('button[data-page]');
    if (!b || b.disabled) return;
    const p = Number(b.dataset.page);
    if (p >= 1 && p <= pages && p !== page) onPage(p);
  };
}

// ==================== Excel (.xlsx) ====================
export function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** 通用 Excel 导入弹窗：
 * - doImport(rows)：上传后由服务端解析出表头键值行，再交给 doImport
 * - upload(dataBase64)：直接把文件 base64 交给 upload（如"系统请假数据"导入）
 * - noticeTitle：修改35新增，自定义 notices 区域的提示语（不传则沿用默认文案） */
export function importModal({ title, templateName, templateFile, tip, doImport, upload, onDone, noticeTitle: noticeTitleArg }) {
  modal({
    title,
    width: 620,
    showFooter: false,
    body: `
      <div class="import-tip">${tip}</div>
      <div class="import-actions">
        ${templateName ? `<button class="btn btn-sm" id="dlTpl">${ICONS.download} 下载导入模板</button>` : ''}
        <label class="file-pick btn btn-primary btn-sm">${ICONS.upload} 选择 Excel（.xlsx）文件<input type="file" accept=".xlsx" hidden></label>
      </div>
      <div class="import-file" id="impFile"></div>
      <div id="impResult"></div>`,
    onMount(wrap, close) {
      const resultBox = wrap.querySelector('#impResult');
      const fileBox = wrap.querySelector('#impFile');
      const tplBtn = wrap.querySelector('#dlTpl');
      if (tplBtn) tplBtn.onclick = () => apiDownload(`/api/templates/${templateName}`, templateFile);
      wrap.querySelector('input[type="file"]').onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (!/\.xlsx$/i.test(file.name)) {
          fileBox.textContent = `已选择：${file.name}`;
          resultBox.innerHTML = `<div class="import-result"><div class="ir-line bad">✗ 请选择 .xlsx 格式的 Excel 文件</div></div>`;
          e.target.value = '';
          return;
        }
        fileBox.textContent = `已选择：${file.name}`;
        resultBox.innerHTML = `<div class="muted small">正在解析并导入，请稍候…</div>`;
        try {
          const dataBase64 = arrayBufferToBase64(await file.arrayBuffer());
          let r;
          if (upload) {
            r = await upload(dataBase64);
          } else {
            const parsed = await api('/api/xlsx/parse', { method: 'POST', body: { dataBase64 } });
            r = await doImport(parsed.rows);
          }
          const errs = r.errors || [];
          const notices = r.notices || [];
          // 修改35：noticeTitle / showUpdated 供调用方定制提示语；
          // 账号 / 教职工批量导入需要展示"更新"计数与三类结果分区（完全 / 部分 / 不予导入）。
          const noticeTitle =
            noticeTitleArg ??
            (r.noticesCount || notices.length
              ? `${r.noticesCount || notices.length} 条学号与名单不一致，已按姓名自动匹配（请核对班级名单中的学号）：`
              : '');
          const partition = r.fullyImported != null
            ? `<div class="ir-line ok">结果分区：完全导入 ${r.fullyImported} 条${r.partialImported ? `，部分导入（字段已跳过）${r.partialImported} 条` : ''}${r.notImported ? `，不予导入 ${r.notImported} 条` : ''}</div>`
            : '';
          resultBox.innerHTML = `
            <div class="import-result">
              <div class="ir-line ok">✓ 共 ${r.total} 条${r.skipped ? `，跳过 ${r.skipped} 条非"已通过"记录` : ''}${r.duplicates ? `，跳过重复 ${r.duplicates} 条` : ''}，导入 ${r.imported ?? r.total - r.failed} 条${r.updated ? `，更新 ${r.updated} 条` : ''}${r.applied != null ? (r.reverted != null ? `，${r.applied} 条假单生效` : `，其中 ${r.applied} 条已自动更新考勤状态`) : ''}${r.reverted ? `，${r.reverted} 条无效请假已改判缺勤` : ''}</div>
              ${partition}
              ${r.failed || errs.length ? `<div class="ir-line bad">✗ 以下 ${errs.length} 条未处理：</div><ul class="ir-errs">${errs.map((x) => `<li>第 ${x.row} 行：${esc(x.message)}</li>`).join('')}</ul>` : ''}
              ${notices.length ? `<div class="ir-line warn">⚠ ${noticeTitle}</div><ul class="ir-errs ir-notices">${notices.map((x) => `<li>第 ${x.row} 行：${esc(x.message)}</li>`).join('')}</ul>` : ''}
            </div>`;
          toast(`导入完成：导入 ${r.imported ?? r.total - r.failed} 条${r.updated ? `，更新 ${r.updated} 条` : ''}${r.failed ? `，未处理 ${errs.length} 条` : ''}`, errs.length ? 'info' : 'success');
          onDone && onDone(r);
        } catch (err) {
          resultBox.innerHTML = `<div class="import-result"><div class="ir-line bad">✗ ${esc(err.message)}</div></div>`;
        }
        e.target.value = '';
      };
    },
  });
}

// ==================== 可搜索下拉（姓名 / 编号模糊匹配，实时过滤） ====================
/* 修改24：SS_STYLES 飞地治理——硬编码 #fff/#f1f5f9 换全局 token，面板玻璃浮层化 */
const SS_STYLES = `
    .ss-wrap { position: relative; }
    .ss-wrap .input { width: 100%; }
    .ss-panel {
      position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 120;
      background: var(--glass-strong);
      -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px);
      border: 1px solid var(--glass-stroke); border-radius: 12px;
      box-shadow: var(--neu-float); max-height: 230px; overflow-y: auto; padding: 4px;
    }
    .ss-item { padding: 8px 10px; font-size: 13px; border-radius: 8px; cursor: pointer; }
    .ss-item:hover, .ss-item.active { background: var(--primary-light); color: var(--primary); }
    .ss-empty { padding: 8px 10px; font-size: 12.5px; color: var(--text-3); }
`;

/** 可搜索下拉：输入关键字实时过滤（姓名 / 编号模糊匹配），点击选项完成选择。
 *  返回 { el, getValue }；onSelect(value, option) 在选中时回调。 */
export function createSearchSelect({ placeholder = '输入关键字筛选', options = [], emptyText = '无匹配结果', onSelect } = {}) {
  if (!document.getElementById('ssStyles')) {
    const style = document.createElement('style');
    style.id = 'ssStyles';
    style.textContent = SS_STYLES;
    document.head.appendChild(style);
  }
  const wrap = document.createElement('div');
  wrap.className = 'ss-wrap';
  wrap.innerHTML = `
    <input class="input" autocomplete="off" placeholder="${esc(placeholder)}" />
    <div class="ss-panel" hidden></div>`;
  const input = wrap.querySelector('input');
  const panel = wrap.querySelector('.ss-panel');
  let list = options.slice();
  let current = '';

  const render = () => {
    const kw = input.value.trim().toLowerCase();
    const hits = list.filter((o) => `${o.value} ${o.label}`.toLowerCase().includes(kw));
    panel.innerHTML = hits.length
      ? hits.map((o) => `<div class="ss-item" data-value="${esc(o.value)}">${esc(o.label)}</div>`).join('')
      : `<div class="ss-empty">${esc(emptyText)}</div>`;
    panel.hidden = false;
  };
  input.addEventListener('focus', render);
  input.addEventListener('input', render);
  panel.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.ss-item');
    if (!item) return;
    e.preventDefault();
    current = item.dataset.value;
    const hit = list.find((o) => String(o.value) === current);
    input.value = hit ? hit.label : current;
    panel.hidden = true;
    if (onSelect) onSelect(current, hit);
  });
  input.addEventListener('blur', () => setTimeout(() => { panel.hidden = true; }, 150));

  return {
    el: wrap,
    getValue: () => current,
    /** 更新候选列表（切换班级 / 加载名单后调用） */
    setOptions(opts) {
      list = (opts || []).slice();
      current = '';
      input.value = '';
    },
  };
}

// ==================== 修改63：可搜索组合框（Combobox，参照设计稿） ====================
/** 样式参照附图：放大镜输入框 + 过滤浮层（选中行高亮）+ 可清空。
 *  全部走 token（项目惯例：布局/交互照设计图，配色除外）；
 *  可隐藏容器基座不写 display（铁律 2），仅用 :not([hidden]) 打开。 */
const CB_STYLES = `
.cb { position: relative; display: block; }
.cb-input-wrap { position: relative; display: flex; align-items: center; }
.cb-input {
  width: 100%; padding-right: 58px;
  /* 触发器长文本（多选摘要「已选 N 个班级 · 首项」）优雅省略而非硬截断；输入时文本可在框内滚动 */
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* ⚠️ app.css:296 有 .toolbar .input / .toolbar .select { width: auto }（特异性 0,2,0），
 *   会覆盖 .cb-input 的 width:100%（0,1,0）→ 输入框按内容撑宽、溢出 170px 容器，
 *   把考勤点名筛选栏里后面的日期框挤歪（Bug1 错位）。
 *   本规则特异性 (0,3,0) 更高，用组合框容器后代选择器夺回宽度。
 *   ⚠️ 本段位于模板字符串内，注释中不可出现反引号。 */
.toolbar .cb .input, .toolbar .cb .select { width: 100%; }
.cb-ic {
  position: absolute; right: 8px; display: inline-flex; align-items: center;
  color: var(--text-3); pointer-events: none;
}
.cb-ic svg { width: 15px; height: 15px; }
/* 有值时显示清空钮（占位符可见 = 空值）；程序性 .value 赋值同样生效 */
.cb-clear {
  position: absolute; right: 30px; display: none; align-items: center; justify-content: center;
  width: 26px; height: 26px; padding: 0; border: 0; border-radius: 50%;
  background: var(--surface-3); color: var(--text-2); cursor: pointer;
}
.cb-input:not(:placeholder-shown) ~ .cb-clear { display: inline-flex; }
.cb-clear:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }
/* 浮层：与项目既有下拉面板 .multi-panel（app.css）同一惯例 —— 毛玻璃 + 滚动。
 * ⚠️ 曾用半透明 var(--surface)=rgba(255,255,255,.88) → 下方表格/日期框内容轮廓透出（Bug2），
 *    必须补 backdrop-filter（.multi-panel 同样用 blur(20px)）。
 * 定位由 JS 控制（修改66：panel 挂到 document.body + position:fixed，跟随输入框 rect），
 *   以逃出 .card 的 backdrop-filter 层叠上下文（否则弹层会被下方卡片遮挡）。
 *   此处不再写 position/left/right/top —— 全由组件内 positionPanel() 行内样式接管。 */
.cb-panel {
  z-index: 9999;
  max-height: min(250px, 46vh); overflow-y: auto; overscroll-behavior: contain;
  padding: 4px;
  background: var(--glass-strong);
  -webkit-backdrop-filter: blur(20px);
  backdrop-filter: blur(20px);
  border: 1px solid var(--glass-stroke); border-radius: 14px;
  box-shadow: var(--neu-float);
}
/* 滚动条可见性：选项过多时须让用户看得出「可滚」（thin + token 色，兼容 WebKit/Firefox） */
.cb-panel { scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent; }
.cb-panel::-webkit-scrollbar { width: 8px; }
.cb-panel::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 999px; }
.cb-panel::-webkit-scrollbar-track { background: transparent; }
.cb-item {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border-radius: 7px; cursor: pointer;
  font-size: 13.5px; color: var(--text);
  /* 修改66：选项单行完整显示（各屏宽不换行）；超长班级名在面板内用 ellipsis 优雅省略，
     点开即见完整（必要时面板随内容自适应加宽，见 positionPanel） */
  white-space: nowrap;
}
.cb-item:hover, .cb-item.on { background: var(--primary-light); }
.cb-item .cb-item-ck { margin-left: auto; color: var(--primary); display: inline-flex; }
.cb-item .cb-item-ck svg { width: 14px; height: 14px; }
.cb-empty { padding: 10px; font-size: 12.5px; color: var(--text-3); text-align: center; }
/* 多选态（假单管理）：浮层项左侧复选框，勾选后不收起浮层 */
.cb-item-check {
  flex: 0 0 auto; width: 16px; height: 16px; border-radius: 4px;
  border: 1.5px solid var(--border-strong); background: transparent;
  display: inline-flex; align-items: center; justify-content: center;
}
.cb-item.is-on .cb-item-check { background: var(--primary); border-color: var(--primary); }
.cb-item-check svg { width: 11px; height: 11px; color: #fff; }
.cb-item:not(.is-on) .cb-item-check svg { display: none; }
.cb-count { font-size: 11.5px; color: var(--text-3); flex: 0 0 auto; font-variant-numeric: tabular-nums; }
.cb-item-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 720px) {
  .cb-input { min-height: 44px; }
  .cb-item { min-height: 44px; }
  .cb-clear { width: 30px; height: 30px; }
}
`;

/** 修改66：组合框浮层定位助手。panel 挂到 document.body（position:fixed），逃出祖先层叠上下文，
 *  跟随输入框视口坐标定位；空间不足翻转到上方；右侧越界回缩。面板宽与输入框等宽（班级名单行可完整显示）。 */
function cbEnsureBody(panel) {
  if (panel.parentNode !== document.body) document.body.appendChild(panel);
}
function cbPositionPanel(input, panel) {
  const rect = input.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  panel.style.position = 'fixed';
  panel.style.right = 'auto';
  // 宽度：按内容 max-content 展开（保证各屏宽下班级名单行完整显示，不被输入框窄宽裁掉），
  //   至少与输入框等宽，封顶视口-16px
  panel.style.width = 'max-content';
  let w = Math.max(panel.offsetWidth, rect.width);
  w = Math.min(w, vw - 16);
  panel.style.width = Math.round(w) + 'px';
  let left = rect.left;
  if (left + w > vw - 4) left = Math.max(8, vw - w - 8);
  panel.style.left = Math.round(left) + 'px';
  const ph = panel.offsetHeight;
  const below = vh - rect.bottom - 6;
  const top = (ph <= below || rect.top - 6 < ph) ? rect.bottom + 6 : rect.top - ph - 6;
  panel.style.top = Math.round(top) + 'px';
}

/** 可搜索组合框：输入关键字实时过滤、浮层展示匹配项、点选回填、可清空。
 *  语义对齐原生 select：值只能来自选项（失焦不匹配则回退上次选中值）；
 *  仅「选中 / 清空」派发 change 事件（与 select 选中才触发一致）。
 *  返回 { el, input, get, set, refresh }。 */
export function createSearchCombo({ options = [], value = '', placeholder = '请输入关键字筛选', id = '', ariaLabel = '', onChange } = {}) {
  if (!document.getElementById('cbStyles')) {
    const style = document.createElement('style');
    style.id = 'cbStyles';
    style.textContent = CB_STYLES;
    document.head.appendChild(style);
  }
  let list = (options || []).map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  let current = list.some((o) => o.value === value) ? value : '';

  const wrap = document.createElement('div');
  wrap.className = 'cb';
  wrap.innerHTML = `
    <div class="cb-input-wrap">
      <input class="input cb-input" type="text" autocomplete="off" role="combobox"
        aria-expanded="false" aria-autocomplete="list" ${id ? `id="${esc(id)}"` : ''}
        ${ariaLabel ? `aria-label="${esc(ariaLabel)}"` : ''} placeholder="${esc(placeholder)}" />
      <button type="button" class="cb-clear" aria-label="清空已选">${ICONS.close}</button>
      <span class="cb-ic" aria-hidden="true">${ICONS.search}</span>
    </div>`;
  // 修改66：浮层挂 document.body（portal，position:fixed），逃出 .card 的 backdrop-filter 层叠上下文，
  //   否则弹层会被下方卡片遮挡（web+手机端通用）。仅在打开时挂、关闭时摘，保持 DOM 干净。
  const panel = document.createElement('div');
  panel.className = 'cb-panel';
  panel.setAttribute('role', 'listbox');
  panel.hidden = true;
  const input = wrap.querySelector('.cb-input');
  const clearBtn = wrap.querySelector('.cb-clear');
  input.value = current;

  let listenersOn = false;
  const onScrollOrResize = () => { if (!panel.hidden) cbPositionPanel(input, panel); };
  const addOpenListeners = () => {
    if (listenersOn) return;
    listenersOn = true;
    window.addEventListener('scroll', onScrollOrResize, true); // 捕获：捕捉任意滚动容器
    window.addEventListener('resize', onScrollOrResize);
  };
  const removeOpenListeners = () => {
    if (!listenersOn) return;
    listenersOn = false;
    window.removeEventListener('scroll', onScrollOrResize, true);
    window.removeEventListener('resize', onScrollOrResize);
  };

  let hits = [];
  let hi = -1;
  const render = () => {
    const kw = input.value.trim().toLowerCase();
    hits = list.filter((o) => `${o.value} ${o.label}`.toLowerCase().includes(kw));
    hi = hits.findIndex((o) => o.value === current);
    panel.innerHTML = hits.length
      ? hits.map((o, i) => `<div class="cb-item${i === hi ? ' on' : ''}" role="option" aria-selected="${o.value === current}" data-value="${esc(o.value)}"><span class="cb-item-name">${esc(o.label)}</span>${o.value === current ? `<span class="cb-item-ck" aria-hidden="true">${ICONS.check}</span>` : ''}</div>`).join('')
      : `<div class="cb-empty">无匹配结果</div>`;
    panel.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    syncHi();
    cbEnsureBody(panel);
    cbPositionPanel(input, panel);
    addOpenListeners();
  };
  const close = () => {
    panel.hidden = true;
    if (panel.parentNode) panel.parentNode.removeChild(panel);
    input.setAttribute('aria-expanded', 'false');
    hi = -1;
    removeOpenListeners();
  };
  const syncHi = () => {
    [...panel.querySelectorAll('.cb-item')].forEach((el, i) => el.classList.toggle('on', i === hi));
    const onEl = panel.querySelector('.cb-item.on');
    if (onEl) onEl.scrollIntoView({ block: 'nearest' });
  };
  const commit = (v) => {
    const hit = list.find((o) => o.value === v);
    current = hit ? hit.value : '';
    input.value = hit ? hit.label : '';
    close();
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (onChange) onChange(current, hit || null);
  };

  input.addEventListener('focus', render);
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (panel.hidden) { render(); return; }
      if (!hits.length) return;
      hi = e.key === 'ArrowDown'
        ? (hi + 1) % hits.length
        : (hi <= 0 ? hits.length - 1 : hi - 1);
      syncHi();
    } else if (e.key === 'Enter') {
      if (!panel.hidden && hi >= 0 && hits[hi]) {
        e.preventDefault();
        commit(hits[hi].value);
      }
    } else if (e.key === 'Escape') {
      if (!panel.hidden) {
        e.stopPropagation();
        close();
      }
    }
  });
  // mousedown 先于 blur：确保点选项能完成选中
  panel.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.cb-item');
    if (!item) return;
    e.preventDefault();
    commit(item.dataset.value);
  });
  // 失焦规范化：值不属于选项 → 回退上次选中值（对齐 select 语义，防非法值入查询）
  input.addEventListener('blur', () => {
    setTimeout(() => {
      close();
      const typed = input.value.trim();
      const hit = list.find((o) => o.value === typed || o.label === typed);
      const next = hit ? hit.value : current;
      const changed = next !== current;
      current = next;
      input.value = hit ? hit.label : (list.some((o) => o.value === current) ? (list.find((o) => o.value === current) || {}).label || '' : '');
      if (changed) {
        input.dispatchEvent(new Event('change', { bubbles: true }));
        if (onChange) onChange(current, hit || null);
      }
    }, 120);
  });
  clearBtn.addEventListener('mousedown', (e) => e.preventDefault());
  clearBtn.addEventListener('click', () => {
    input.value = '';
    current = '';
    close();
    input.focus();
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (onChange) onChange('', null);
  });

  return {
    el: wrap,
    input,
    get: () => current,
    set(v) {
      const hit = list.find((o) => o.value === v);
      current = hit ? hit.value : '';
      input.value = hit ? hit.label : '';
      close();
    },
    refresh(opts) {
      if (opts) list = opts.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
      if (!list.some((o) => o.value === current)) {
        current = '';
        input.value = '';
      }
    },
  };
}

/** 多选版可搜索组合框（假单管理「可点名班级」等场景）。
 *  与 createSearchCombo 同视觉/交互规范，差异：浮层项带复选框、勾选不收起、可多选。
 *  触发器显示「已选 N 个」摘要（与原「全部班级」按钮语义一致）；onChange(names[]) 每次勾选即回调。
 *  返回 { el, input, get, set, refresh }。 */
export function createMultiCombo({ options = [], values = [], placeholder = '全部班级（不限）', id = '', ariaLabel = '选择班级', countLabel = '', onChange } = {}) {
  if (!document.getElementById('cbStyles')) {
    const style = document.createElement('style');
    style.id = 'cbStyles';
    style.textContent = CB_STYLES;
    document.head.appendChild(style);
  }
  let list = (options || []).map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  let sel = new Set((values || []).filter((v) => list.some((o) => o.value === v)));

  const wrap = document.createElement('div');
  wrap.className = 'cb cb-multi';
  wrap.innerHTML = `
    <div class="cb-input-wrap">
      <input class="input cb-input" type="text" autocomplete="off" role="combobox"
        aria-expanded="false" aria-autocomplete="list" ${id ? `id="${esc(id)}"` : ''}
        ${ariaLabel ? `aria-label="${esc(ariaLabel)}"` : ''} placeholder="${esc(placeholder)}" />
      <button type="button" class="cb-clear" aria-label="清空已选">${ICONS.close}</button>
      <span class="cb-ic" aria-hidden="true">${ICONS.search}</span>
    </div>`;
  // 修改66：浮层挂 body（portal，position:fixed），逃出 .card 的 backdrop-filter 层叠上下文
  const panel = document.createElement('div');
  panel.className = 'cb-panel';
  panel.setAttribute('role', 'listbox');
  panel.setAttribute('aria-multiselectable', 'true');
  panel.hidden = true;
  const input = wrap.querySelector('.cb-input');
  const clearBtn = wrap.querySelector('.cb-clear');

  let listenersOn = false;
  const onScrollOrResize = () => { if (!panel.hidden) cbPositionPanel(input, panel); };
  const addOpenListeners = () => {
    if (listenersOn) return;
    listenersOn = true;
    window.addEventListener('scroll', onScrollOrResize, true); // 捕获：捕捉任意滚动容器
    window.addEventListener('resize', onScrollOrResize);
  };
  const removeOpenListeners = () => {
    if (!listenersOn) return;
    listenersOn = false;
    window.removeEventListener('scroll', onScrollOrResize, true);
    window.removeEventListener('resize', onScrollOrResize);
  };

  // 触发器摘要：空=占位符文案；非空=「已选 N 个[ + 首项]」（长首项由 .cb-input ellipsis 优雅省略）
  const syncTrigger = () => {
    if (document.activeElement === input && panel.hidden === false) return; // 搜索中不覆盖输入
    if (!sel.size) {
      input.value = '';
      input.placeholder = placeholder;
      return;
    }
    const first = list.find((o) => o.value === [...sel][0]);
    input.placeholder = `已选 ${sel.size} 个班级${first ? ' · ' + first.label : ''}`;
    input.value = '';
  };

  let hits = [];
  const render = () => {
    const kw = input.value.trim().toLowerCase();
    hits = list.filter((o) => `${o.value} ${o.label}`.toLowerCase().includes(kw));
    panel.innerHTML = hits.length
      ? hits.map((o) => {
          const on = sel.has(o.value);
          return `<div class="cb-item${on ? ' is-on' : ''}" role="option" aria-selected="${on}" data-value="${esc(o.value)}">
            <span class="cb-item-check" aria-hidden="true">${ICONS.check}</span>
            <span class="cb-item-name">${esc(o.label)}</span>
            ${o.count ? `<span class="cb-count">${o.count} 人</span>` : ''}
          </div>`;
        }).join('')
      : `<div class="cb-empty">无匹配结果</div>`;
    panel.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    cbEnsureBody(panel);
    cbPositionPanel(input, panel);
    addOpenListeners();
  };
  const close = () => {
    panel.hidden = true;
    if (panel.parentNode) panel.parentNode.removeChild(panel);
    input.setAttribute('aria-expanded', 'false');
    syncTrigger();
    removeOpenListeners();
  };
  const emit = () => {
    const names = [...sel];
    syncTrigger();
    // 兼容既有消费方：change 事件 detail 带数组，onChange 回调同名数组
    input.dispatchEvent(new CustomEvent('change', { bubbles: true, detail: names }));
    if (onChange) onChange(names);
  };

  input.addEventListener('focus', () => {
    input.value = '';
    render();
  });
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!panel.hidden) {
        e.stopPropagation();
        close();
      }
    } else if (e.key === 'Enter') {
      // 键盘多选：Enter 勾选首个匹配项（同样只翻转该项，不重绘浮层）
      if (!panel.hidden && hits.length) {
        e.preventDefault();
        const v = hits[0].value;
        const on = !sel.has(v);
        if (on) sel.add(v); else sel.delete(v);
        const el = panel.querySelector(`.cb-item[data-value="${CSS.escape(v)}"]`);
        if (el) {
          el.classList.toggle('is-on', on);
          el.setAttribute('aria-selected', String(on));
        }
        emit();
      }
    }
  });
  panel.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.cb-item');
    if (!item) return;
    e.preventDefault(); // 阻止 input 失焦，保持浮层与搜索词
    const v = item.dataset.value;
    const on = !sel.has(v);
    if (on) sel.add(v); else sel.delete(v);
    // 只翻转该项状态，不整体重绘 —— 保持浮层不闪、滚动位置与搜索词不丢（连续勾选体验）
    item.classList.toggle('is-on', on);
    item.setAttribute('aria-selected', String(on));
    emit();
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  clearBtn.addEventListener('mousedown', (e) => e.preventDefault());
  clearBtn.addEventListener('click', () => {
    sel.clear();
    input.value = '';
    render();
    emit();
    input.focus();
  });

  syncTrigger();
  return {
    el: wrap,
    input,
    get: () => [...sel],
    set(names) {
      sel = new Set((names || []).filter((v) => list.some((o) => o.value === v)));
      syncTrigger();
    },
    refresh(opts) {
      if (opts) list = opts.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
      sel = new Set([...sel].filter((v) => list.some((o) => o.value === v)));
      syncTrigger();
    },
  };
}

/** 运行时把 <select> 升级为组合框：保留 id / 首个空 option 作 placeholder / 既有 change 消费方零改动。
 *  返回 createSearchCombo 的实例。 */
export function upgradeSelectToCombo(sel, { onChange } = {}) {
  const options = [...sel.options].filter((o) => o.value !== '').map((o) => ({ value: o.value, label: o.textContent }));
  const phOpt = [...sel.options].find((o) => o.value === '');
  const combo = createSearchCombo({
    options,
    value: sel.value || '',
    placeholder: phOpt ? phOpt.textContent : '请输入关键字筛选',
    id: sel.id,
    ariaLabel: sel.getAttribute('aria-label') || (phOpt ? phOpt.textContent : sel.id),
    onChange,
  });
  if (sel.style.width) combo.el.style.width = sel.style.width;
  if (sel.className) combo.input.className += ' ' + sel.className.replace(/\bselect\b/g, ' ').trim();
  sel.replaceWith(combo.el);
  return combo;
}

// ==================== 手写签名板（触摸 + 鼠标，零依赖 canvas） ====================
/** 创建手写签名板。返回 { el, clear, isEmpty, toDataURL }。
 *  toDataURL() 导出 PNG base64（空签名导出会抛错由调用方处理）。 */
export function createSignaturePad({ width = 0, height = 160, line = '#1f2937' } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'sig-pad';
  wrap.innerHTML = `
    <canvas class="sig-canvas"></canvas>
    <div class="sig-foot"><button type="button" class="btn btn-sm" data-act="clear">清除重签</button></div>`;
  const canvas = wrap.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  let drawing = false;
  let hasInk = false;
  let lastX = 0;
  let lastY = 0;

  const setupCanvas = () => {
    const cssW = width || (canvas.parentElement.clientWidth || 500);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cssW * dpr;
    canvas.height = height * dpr;
    canvas.style.width = cssW + 'px';
    canvas.style.height = height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = line;
  };
  setupCanvas();

  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    const p = e.touches && e.touches[0] ? e.touches[0] : e;
    return { x: p.clientX - r.left, y: p.clientY - r.top };
  };
  const start = (e) => {
    drawing = true;
    const { x, y } = pos(e);
    lastX = x;
    lastY = y;
  };
  const move = (e) => {
    if (!drawing) return;
    e.preventDefault();
    const { x, y } = pos(e);
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(x, y);
    ctx.stroke();
    hasInk = true;
    lastX = x;
    lastY = y;
  };
  const end = () => {
    drawing = false;
  };

  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  canvas.addEventListener('touchstart', start, { passive: true });
  canvas.addEventListener('touchmove', move, { passive: false });
  canvas.addEventListener('touchend', end);

  wrap.querySelector('[data-act="clear"]').addEventListener('click', () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    hasInk = false;
  });

  return {
    el: wrap,
    clear: () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      hasInk = false;
    },
    isEmpty: () => !hasInk,
    toDataURL: () => {
      if (!hasInk) throw new Error('请先在签名区域手写签名');
      return canvas.toDataURL('image/png');
    },
  };
}
