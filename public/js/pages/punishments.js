import { api } from '../api.js';
import { esc, ICONS, fmtTime, renderPager, modal, toast, PUNISHMENT_LEVELS, punishmentTagCls, upgradeSelectToCombo } from '../ui.js';

// 修改30：处分管理 —— 自动生成的处分记录查看（等级阈值见 ui.js PUNISHMENT_LEVELS，与后端口径一致）
// 触发链路：点名提交/更正、假单对账、异议改判 → 后端重算 → 自动生成/撤销（revokedAt 留痕）
const state = { page: 1, pageSize: 15, status: 'active', className: '', levelIndex: '', q: '', total: 0 };

let levelNames = PUNISHMENT_LEVELS.map((l) => l.level);
let classList = [];
// 修改65：班级组合框实例（bind 时创建，load 后置回填班级列表）
let punCombo = null;

function statusTagOf(p) {
  return p.revokedAt
    ? `<span class="tag tag-gray">已自动撤销</span>`
    : `<span class="tag tag-green">生效中</span>`;
}

function rowsHtml(list) {
  if (!list.length) {
    return `<tr><td colspan="9" class="table-empty">暂无处分记录${state.status === 'active' ? '（当前筛选：生效中）' : ''}</td></tr>`;
  }
  return list
    .map(
      (p) => `
    <tr>
      <td>${esc(p.className)}</td>
      <td>${esc(p.studentName)}<span class="muted small" style="margin-left:6px">${esc(p.sid)}</span></td>
      <td><span class="tag ${punishmentTagCls(p.levelIndex)}">${esc(p.level)}</span></td>
      <td class="num">${esc(p.levelRange || '')}</td>
      <td class="num" data-label="最早认定节数">${p.firstJie} 节</td>
      <td class="num" data-label="累计缺勤节数">${p.currentTotalJie} 节</td>
      <td class="muted small" data-label="达到时间">${fmtTime(p.firstReachAt || p.createdAt)}</td>
      <td>${statusTagOf(p)}</td>
      <td class="td-actions"><a href="javascript:;" data-detail="${esc(p.id)}">详情</a></td>
    </tr>`
    )
    .join('');
}

function pageHtml() {
  return `
  <div class="page">
    <div class="stat-cards" id="punStats"></div>
    <div class="card">
      <div class="card-title">处分记录</div>
      <div class="filter-bar">
        <select class="select" id="punClass">
          <option value="">全部班级</option>
          ${classList.map((c) => `<option value="${esc(c)}" ${state.className === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
        </select>
        <select class="select" id="punLevel">
          <option value="">全部等级</option>
          ${levelNames.map((n, i) => `<option value="${i}" ${String(state.levelIndex) !== '' && Number(state.levelIndex) === i ? 'selected' : ''}>${esc(n)}</option>`).join('')}
        </select>
        <div class="seg" id="punStatus">
          <button class="seg-btn ${state.status === 'active' ? 'active' : ''}" data-v="active">生效中</button>
          <button class="seg-btn ${state.status === 'revoked' ? 'active' : ''}" data-v="revoked">已撤销</button>
          <button class="seg-btn ${state.status === 'all' ? 'active' : ''}" data-v="all">全部</button>
        </div>
        <input class="input" id="punQ" placeholder="姓名 / 学号关键字" value="${esc(state.q)}" style="max-width:200px" />
        <button class="btn btn-primary btn-sm" id="punSearch">查询</button>
      </div>
      <div class="muted small" style="margin:8px 2px 12px">
        处分由系统按累计缺勤节数自动生成 / 自动撤销：缺勤按节次权重计（常规节次 2 节、早晚自习 1 节），迟到每次折 0.5 节；
        0.5~10 节通报批评、10.5~14.5 院级警告、15~20 校级警告、20.5~40 校级严重警告、40.5~60 校级记过、60.5~80 校级留校察看、80.5 以上校级劝退。
        异议改判、假单对账、记录修正导致节数回落时，高于当前节数的处分自动撤销并留痕。
      </div>
      <div class="table-wrap">
        <table class="table" data-card="s,t,g,-,-,n,a,d,x">
          <thead>
            <tr><th>班级</th><th>学生</th><th>处分等级</th><th>等级区间</th><th>最早认定节数</th><th>累计缺勤节数</th><th>达到时间</th><th>状态</th><th>操作</th></tr>
          </thead>
          <tbody id="punRows"><tr><td colspan="9" class="table-empty">加载中…</td></tr></tbody>
        </table>
      </div>
      <div id="punPager"></div>
      <div class="muted small" style="margin:10px 2px 0">
        「最早认定节数」= 按时间累计首次达到该等级区间下限时的节数；「累计缺勤节数」= 截止目前全历史累计（缺勤按节次权重、迟到每次折 0.5 节）；达到时间 = 首次达到该区间的时间点。
      </div>
    </div>
  </div>`;
}

async function load(root) {
  const qs = new URLSearchParams();
  qs.set('page', String(state.page));
  qs.set('pageSize', String(state.pageSize));
  qs.set('status', state.status);
  if (state.className) qs.set('className', state.className);
  if (String(state.levelIndex) !== '') qs.set('levelIndex', String(state.levelIndex));
  if (state.q) qs.set('q', state.q);
  const cls = state.className ? `&className=${encodeURIComponent(state.className)}` : '';
  const d = await api(`/api/punishments?${qs.toString()}`);
  levelNames = d.levelNames || levelNames;
  classList = d.classes || classList;
  // 修改65：班级列表首次 load 返回后回填组合框（替代原 select.innerHTML，保留当前选中）
  if (punCombo && classList.length) {
    // ⚠️ 单选组合框：set 接受字符串（非数组）；refresh 重建候选并清掉不在新列表里的旧值
    punCombo.refresh(classList.map((c) => ({ value: c, label: c })));
    punCombo.set(state.className || '');
  }
  state.total = d.total;
  // 统计卡：生效中 / 已撤销条数（按当前班级范围），涉及人数按当前页生效记录估算
  const [activeRes, allRes] = await Promise.all([
    api(`/api/punishments?status=active&pageSize=1&page=1${cls}`),
    api(`/api/punishments?status=all&pageSize=1&page=1${cls}`),
  ]);
  const stuSet = new Set(d.list.filter((p) => !p.revokedAt).map((p) => `${p.className}|${p.sid}`));
  const statsEl = root.querySelector('#punStats');
  if (statsEl) {
    statsEl.innerHTML = `
      <div class="stat-card"><div class="stat-icon si-red">${ICONS.gavel}</div><div><div class="stat-value">${activeRes.total}</div><div class="stat-label">生效中处分（条）</div></div></div>
      <div class="stat-card"><div class="stat-icon si-blue">${ICONS.users}</div><div><div class="stat-value">${stuSet.size}</div><div class="stat-label">涉及学生（当前页）</div></div></div>
      <div class="stat-card"><div class="stat-icon si-purple">${ICONS.list}</div><div><div class="stat-value">${allRes.total - activeRes.total}</div><div class="stat-label">已自动撤销（条）</div></div></div>`;
  }
  const rows = root.querySelector('#punRows');
  if (rows) rows.innerHTML = rowsHtml(d.list);
  renderPager(root.querySelector('#punPager'), { page: state.page, pageSize: state.pageSize, total: state.total }, (p) => {
    state.page = p;
    load(root);
  });
}

async function openDetail(id) {
  const d = await api(`/api/punishments/${encodeURIComponent(id)}`);
  const p = d.punishment;
  const recRows = (p.records || [])
    .map(
      (r) => `
      <tr>
        <td class="num">${esc(r.date)}</td>
        <td>${esc(r.weekday || '')}</td>
        <td>${(r.periods || []).map((x) => `<span class="tag tag-purple">${esc(x)}</span>`).join(' ')}</td>
        <td>${esc(r.courseName || '')}</td>
        <td><span class="tag ${r.status === '缺勤' ? 'tag-red' : 'tag-orange'}">${esc(r.status)}</span></td>
        <td class="num">${r.jie} 节</td>
        <td class="num">${r.runningTotal}</td>
      </tr>`
    )
    .join('');
  // 修改37b：移动端明细卡（参照用户参考图复合卡片）——桌面显示上方表格，≤720px 显示卡片
  const recCards = (p.records || [])
    .map(
      (r) => `
      <div class="pm-mcard">
        <div class="pmc-date">
          <div class="pmc-d1">${esc(r.date)}</div>
          <div class="pmc-d2">${esc(r.weekday || '')}</div>
        </div>
        <div class="pmc-mid">
          <div class="pmc-periods">${(r.periods || []).map((x) => `<span class="tag tag-purple">${esc(x)}</span>`).join('')}</div>
          <div class="pmc-course">${esc(r.courseName || '—')}</div>
        </div>
        <div class="pmc-side">
          <span class="tag ${r.status === '缺勤' ? 'tag-red' : 'tag-orange'}">${esc(r.status)}</span>
          <div class="pmc-jie">${r.jie} 节</div>
          <div class="pmc-acc">累计 ${r.runningTotal}</div>
        </div>
      </div>`
    )
    .join('');
  const jieSum = (p.records || []).reduce((s, r) => s + (Number(r.jie) || 0), 0);
  // 修改33 口径：最低等级=区间内切片；高等级=自首次缺勤至首次达到本区间下限为止（含达标那条）
  const isLowest = Number(p.levelIndex) === 0;
  const detailTitle = isLowest
    ? `触发明细（累计节数落在「${esc(p.levelRange || '')}」区间内的缺勤 / 迟到记录）`
    : `触发明细（自首次缺勤起、至累计节数首次达到「${esc(p.levelRange || '')}」下限为止）`;
  // 修改37b：头部参照参考图改为「学生行 + 三列信息卡」，字段名改为图标 + 小标签，避免逐字段堆叠
  const pmdIco = {
    cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    hash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg>',
  };
  const body = `
    <div class="pmd-head">
      ${p.revokedAt ? `<div class="pm-revoke">该处分已于 ${fmtTime(p.revokedAt)} 自动撤销：${esc(p.revokeInfo || '')}</div>` : ''}
      <div class="pmd-stu">
        <span class="tag ${punishmentTagCls(p.levelIndex)}">${esc(p.level)}</span>
        <b class="pmd-name">${esc(p.className)} · ${esc(p.studentName)}</b>
        <span class="pmd-sid">${esc(p.sid)}</span>
      </div>
      <div class="pmd-grid">
        <div class="pmd-col">
          <div class="pmd-label">${pmdIco.cal}<span>首次认定</span></div>
          <div class="pmd-value">${fmtTime(p.firstReachAt || p.createdAt)}</div>
          <div class="pmd-foot">达到时间</div>
        </div>
        <div class="pmd-col">
          <div class="pmd-label">${pmdIco.clock}<span>认定来源</span></div>
          <div class="pmd-value">${esc(p.createdBy || '系统（自动）')}</div>
          <div class="pmd-foot">最早认定 ${p.firstJie ?? p.totalJie} 节</div>
        </div>
        <div class="pmd-col">
          <div class="pmd-label">${pmdIco.hash}<span>当前累计缺勤</span></div>
          <div class="pmd-value">${p.currentTotalJie} 节</div>
          <div class="pmd-foot">本卡合计 ${jieSum} 节 / ${(p.records || []).length} 条</div>
        </div>
      </div>
      <div class="pdm-range muted small">等级区间：${esc(p.levelRange || '')}${p.grade ? ` · 年级 ${esc(p.grade)}` : ''}</div>
    </div>
    <div class="card-title" style="margin-top:14px">${detailTitle}</div>
    <div class="table-wrap pmd-tablewrap" style="max-height:42vh;overflow:auto">
      <table class="table">
        <thead><tr><th>日期</th><th>星期</th><th>节次</th><th>课程</th><th>状态</th><th>折算节数</th><th>累计节数</th></tr></thead>
        <tbody>${recRows || '<tr><td colspan="7" class="table-empty">无明细</td></tr>'}</tbody>
      </table>
    </div>
    <div class="pm-mcards">${recCards || '<div class="pm-mempty">无明细</div>'}</div>`;
  modal({
    title: '处分详情',
    body,
    width: 760,
    showFooter: false, // 头部 × 关闭即可；避免渲染空文本 footer 按钮（修改33）
  });
}

export default {
  async mount(root) {
    root.innerHTML = pageHtml();
    bind(root);
    await load(root);
  },
};

function bind(root) {
  // 修改65：班级筛选升级为可搜索组合框（升级须在下方事件绑定之前）。
  // 班级列表首次 load 后才拿到（见 load 内 classList 回填）→ 升级时列表为空，
  // 由 load 里的 punCombo.refresh(classList) 补齐，保留原有「后置回填」语义。
  punCombo = upgradeSelectToCombo(root.querySelector('#punClass'));
  root.querySelector('#punSearch')?.addEventListener('click', () => {
    state.className = root.querySelector('#punClass')?.value || '';
    const lv = root.querySelector('#punLevel')?.value;
    state.levelIndex = lv === '' ? '' : Number(lv);
    state.q = (root.querySelector('#punQ')?.value || '').trim();
    state.page = 1;
    load(root);
  });
  root.querySelector('#punQ')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') root.querySelector('#punSearch')?.click();
  });
  root.querySelectorAll('#punStatus .seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      state.status = b.dataset.v;
      state.page = 1;
      root.querySelectorAll('#punStatus .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
      load(root);
    })
  );
  root.addEventListener('click', (e) => {
    const a = e.target.closest('[data-detail]');
    if (a) openDetail(a.dataset.detail).catch((err) => toast(err.message || '加载详情失败', 'error'));
  });
}
