import { api, apiDownload } from '../api.js';
import { esc, modal, toast, confirmDialog, renderPager, importModal, ICONS } from '../ui.js';
// 修改72：年级 → 班级级联复用共享模块（与班级名单 / 数据统计同一份实现，规则完全一致）
import { createGradeClassCascade, deriveGrades } from '../gradeClassCascade.js';

const PAGE_STYLES = `
  .cls-posts { display: flex; flex-wrap: wrap; gap: 4px; }
  .cls-post { font-weight: 400; }
  .cls-links { display: flex; flex-wrap: wrap; gap: 4px 10px; }
  .cls-link { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; font-size: 12.5px; color: var(--text-3); }
  .cls-link .tag { font-size: 11.5px; padding: 1px 7px; }
  .cls-name { font-weight: 600; }
  .cls-sub { display: block; font-size: 11.5px; font-weight: 400; color: var(--text-3); margin-top: 2px; }
  .cls-count { font-variant-numeric: tabular-nums; font-weight: 700; font-size: 15px; }
  .cls-empty { color: var(--text-3); }
`;

const state = { grade: '', q: '', status: '', page: 1, pageSize: 20 };
let listCache = [];
let classes = [];
let grades = [];

const POST_LABELS = [
  { key: 'headTeacher', label: '班主任', nameKey: 'headTeacherName' },
  { key: 'counselor', label: '辅导员', nameKey: 'counselorName' },
  { key: 'disciplineMember', label: '纪律委员', nameKey: 'disciplineMemberName' },
];
const LINK_CLS = { linked: 'tag-green', 'no-account': 'tag-gray', mismatch: 'tag-orange', empty: 'tag-gray' };
const LINK_TEXT = { linked: '已关联', 'no-account': '未建账号', mismatch: '班级不一致', empty: '—' };
// 修改77：同步账号结果四档动作（单班弹窗与批量结果共用）
const SYNC_ACT = {
  created: { cls: 'tag-green', text: '新建账号' },
  linked: { cls: 'tag-blue', text: '已关联' },
  skipped: { cls: 'tag-gray', text: '无需处理' },
  failed: { cls: 'tag-red', text: '失败' },
};

/** 班级岗位：三枚标签，缺失显示灰色「—」（移动端归入 rc-g 标签组，自动换行） */
function postCell(c) {
  return `<span class="cls-posts">${POST_LABELS.map(
    (p) => (c[p.nameKey]
      ? `<span class="tag tag-blue cls-post">${p.label} ${esc(c[p.nameKey])}</span>`
      : `<span class="tag tag-gray cls-post">${p.label} —</span>`)
  ).join('')}</span>`;
}

/** 账号联动三态：已关联 / 未建账号 / 班级不一致 */
function linkCell(c) {
  const links = c.links || {};
  return `<span class="cls-links">${POST_LABELS.map((p) => {
    const l = links[p.key] || { state: 'empty' };
    return `<span class="cls-link">${p.label} <span class="tag ${LINK_CLS[l.state] || 'tag-gray'}">${LINK_TEXT[l.state] || '—'}</span></span>`;
  }).join('')}</span>`;
}

function statusCell(c) {
  if (c.status === 'unregistered') return '<span class="tag tag-orange">未登记</span>';
  return c.status === 'active'
    ? '<span class="tag tag-green">信息完整</span>'
    : '<span class="tag tag-orange">待补信息</span>';
}

export default {
  async mount(root) {
    if (!document.getElementById('clsStyles')) {
      const style = document.createElement('style');
      style.id = 'clsStyles';
      style.textContent = PAGE_STYLES;
      document.head.appendChild(style);
    }

    root.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <h2>班级管理</h2>
          <p class="page-desc">以班级维度统一维护年级、专业与班主任 / 辅导员 / 纪律委员；班级名单中的相关字段直接取自此处</p>
        </div>
        <div class="page-actions">
          <button class="btn" id="btnTpl">${ICONS.download} 下载导入模板</button>
          <button class="btn" id="btnImport">${ICONS.upload} 批量导入</button>
          <button class="btn btn-primary" id="btnAdd">${ICONS.plus} 新增班级</button>
        </div>
      </div>
      <div class="card">
        <div class="toolbar">
          <select class="select" id="gradeFilter" style="width:130px"><option value="">全部年级</option></select>
          <select class="select" id="statusFilter" style="width:130px">
            <option value="">全部状态</option>
            <option value="incomplete">待补信息 / 未登记</option>
            <option value="active">信息完整</option>
          </select>
          <input class="input" id="q" autocomplete="off" placeholder="搜索班级 / 年级 / 专业 / 教师姓名" style="width:230px" />
          <button class="btn" id="btnSearch">查询</button>
          <div class="spacer"></div>
          <button class="btn" id="btnBatchSync" title="勾选班级=同步所选；未勾选=同步当前筛选范围内的全部班级">${ICONS.refresh} 批量同步账号</button>
          <button class="btn" id="btnMigrate" title="把班级名单中逐学生冗余的三岗位聚合进班级管理">存量迁移</button>
        </div>
        <div class="table-wrap">
          <table class="table" data-card="k,t,n,g,d,m,x">
            <thead>
              <tr>
                <th style="width:36px"><input type="checkbox" id="checkAll" /></th>
                <th>班级</th><th style="width:76px">人数</th><th>班级岗位</th>
                <th style="width:96px">状态</th><th style="width:210px">账号联动</th><th class="td-actions">操作</th>
              </tr>
            </thead>
            <tbody id="tbody"><tr><td colspan="7" class="table-empty">加载中…</td></tr></tbody>
          </table>
        </div>
        <div class="card-foot">
          <div class="table-info">
            <span id="info"></span>
            <span class="muted small" style="margin-left:14px">每页</span>
            <select class="select" id="pageSizeSel" style="width:74px;height:30px">
              <option value="20" ${state.pageSize === 20 ? 'selected' : ''}>20</option>
              <option value="50" ${state.pageSize === 50 ? 'selected' : ''}>50</option>
              <option value="100" ${state.pageSize === 100 ? 'selected' : ''}>100</option>
            </select>
            <span class="muted small">条</span>
          </div>
          <div class="pager" id="pager"></div>
        </div>
      </div>
    </div>`;

    const tbody = root.querySelector('#tbody');
    const pagerEl = root.querySelector('#pager');
    const infoEl = root.querySelector('#info');
    const batchBtn = root.querySelector('#btnBatchSync');
    const checkAll = root.querySelector('#checkAll');
    root.querySelector('#pageSizeSel').onchange = (e) => {
      state.pageSize = Number(e.target.value) || 20;
      state.page = 1;
      load();
    };

    // 年级筛选：单层下拉（班级管理以班级为主键，不做年级→班级级联，保持查询按钮触发语义）
    const gradeSel = root.querySelector('#gradeFilter');
    const cascade = createGradeClassCascade({
      classList: classes,
      gradeEls: [gradeSel],
      clsEls: [],
      onChange: (g) => {
        state.grade = g; // 只同步 state，不自动查询
      },
    });

    const selected = new Set();
    // 修改77：批量同步按钮不再要求勾选 —— 未勾选时同步「当前筛选范围内的全部班级」
    function syncBatchBtn() {
      const n = selected.size;
      batchBtn.innerHTML = `${ICONS.refresh} ${n ? `批量同步账号（${n}）` : '批量同步账号'}`;
      const boxes = tbody.querySelectorAll('input[type="checkbox"]');
      checkAll.checked = boxes.length > 0 && [...boxes].every((b) => b.checked);
    }

    /** 当前筛选条件的文字描述（批量同步确认框用） */
    function filterDesc() {
      const parts = [];
      if (state.grade) parts.push(`年级「${state.grade}」`);
      if (state.status === 'active') parts.push('信息完整');
      if (state.status === 'incomplete') parts.push('待补信息 / 未登记');
      if (state.q) parts.push(`关键词「${state.q}」`);
      return parts.length ? parts.join(' · ') : '全部班级（无筛选条件）';
    }

    async function load() {
      tbody.innerHTML = '<tr><td colspan="7" class="table-empty">加载中…</td></tr>';
      const params = new URLSearchParams({ page: state.page, pageSize: state.pageSize });
      if (state.grade) params.set('grade', state.grade);
      if (state.status) params.set('status', state.status);
      if (state.q) params.set('q', state.q);
      const d = await api(`/api/classes?${params}`);
      listCache = d.list;
      selected.clear();
      const incomplete = d.list.filter((c) => c.status !== 'active').length;
      infoEl.textContent = `共 ${d.total} 个班级${incomplete ? `，其中 ${incomplete} 个待补信息` : ''}`;
      renderPager(pagerEl, d, (p) => {
        state.page = p;
        load();
      });
      tbody.innerHTML = d.list.length
        ? d.list
            .map(
              (c) => `
        <tr data-id="${esc(c.name)}">
          <td><input type="checkbox" data-check="${esc(c.name)}" /></td>
          <td><span class="cls-name">${esc(c.name)}</span><span class="cls-sub">${esc([c.grade, c.major].filter(Boolean).join(' · ') || '未填写年级 / 专业')}</span></td>
          <td class="num"><span class="cls-count">${c.count}</span><span class="muted small"> 人</span></td>
          <td>${postCell(c)}</td>
          <td>${statusCell(c)}</td>
          <td>${linkCell(c)}</td>
          <td class="td-actions">
            <button class="btn-text" data-act="edit">编辑</button>
            <button class="btn-text" data-act="sync">同步账号</button>
            <button class="btn-text danger" data-act="del">删除</button>
          </td>
        </tr>`
            )
            .join('')
        : '<tr><td colspan="7" class="table-empty">暂无班级，点击右上角"新增班级"或"批量导入"添加</td></tr>';
      syncBatchBtn();
    }

    async function refreshMeta() {
      const meta = await api('/api/meta/classes');
      classes = meta.classes;
      grades = deriveGrades(classes);
      cascade.setClassList(classes);
      cascade.renderGradeOptions(cascade.getGrade());
      cascade.sync({ keepValue: true });
    }

    // ---- 新增 / 编辑 ----
    function classModal(c) {
      const isEdit = !!c;
      const v = (k, f) => esc((isEdit && c[k] && c[k][f]) || '');
      modal({
        title: isEdit ? `编辑班级：${c.name}` : '新增班级',
        width: 560,
        okText: isEdit ? '保存' : '添加',
        body: `
        <div class="form">
          <div class="form-row">
            <div class="form-item"><label>班级<span class="req">*</span></label>
              <input class="input" name="name" list="clsOptions" value="${esc(isEdit ? c.name : '')}" placeholder="如：软件2301班" ${isEdit ? '' : 'autofocus'} />
              <datalist id="clsOptions">${classes.map((x) => `<option value="${esc(x.name)}"></option>`).join('')}</datalist></div>
            <div class="form-item" style="flex:0 0 130px"><label>年级</label>
              <input class="input" name="grade" list="gradeOptions" value="${esc(isEdit ? c.grade || '' : '')}" placeholder="如：2023级" />
              <datalist id="gradeOptions">${grades.map((g) => `<option value="${esc(g)}"></option>`).join('')}</datalist></div>
          </div>
          <div class="form-item"><label>专业</label><input class="input" name="major" value="${esc(isEdit ? c.major || '' : '')}" placeholder="如：软件工程" /></div>
          <div class="form-row">
            <div class="form-item"><label>班主任</label><input class="input" name="htName" value="${v('headTeacher', 'name')}" placeholder="姓名" /></div>
            <div class="form-item"><label>班主任工号</label><input class="input" name="htId" value="${v('headTeacher', 'staffId')}" placeholder="用于关联账号" /></div>
          </div>
          <div class="form-row">
            <div class="form-item"><label>辅导员</label><input class="input" name="coName" value="${v('counselor', 'name')}" placeholder="姓名" /></div>
            <div class="form-item"><label>辅导员工号</label><input class="input" name="coId" value="${v('counselor', 'staffId')}" placeholder="用于关联账号" /></div>
          </div>
          <div class="form-row">
            <div class="form-item"><label>纪律委员</label><input class="input" name="dmName" value="${v('disciplineMember', 'name')}" placeholder="姓名" /></div>
            <div class="form-item"><label>纪律委员学号</label><input class="input" name="dmSid" value="${v('disciplineMember', 'studentId')}" placeholder="选填" /></div>
          </div>
          <div class="import-tip" style="margin-top:4px">保存后，班级名单中该班学生的班主任 / 辅导员 / 纪律委员字段会自动同步为此处的值（学生表中这三个字段已改为只读）。</div>
        </div>`,
        onOk: async (wrap, close) => {
          const f = wrap.querySelector('.modal-body');
          const g = (n) => f.querySelector(`[name="${n}"]`).value.trim();
          const body = {
            name: g('name'),
            grade: g('grade'),
            major: g('major'),
            headTeacher: { name: g('htName'), staffId: g('htId') },
            counselor: { name: g('coName'), staffId: g('coId') },
            disciplineMember: { name: g('dmName'), studentId: g('dmSid') },
          };
          if (!body.name) return toast('请填写班级名称', 'error');
          if (isEdit) {
            await api(`/api/classes/${encodeURIComponent(c.name)}`, { method: 'PUT', body });
            toast('班级信息已更新，学生名单相关字段已同步');
          } else {
            await api('/api/classes', { method: 'POST', body });
            toast('班级已添加');
          }
          close();
          await refreshMeta();
          load();
        },
      });
    }

    // ---- 同步到账号 ----
    // 修改76：后端会自动补建缺失账号（幂等），结果按 created/linked/skipped/failed 四档汇总展示；
    // 新建账号附带初始密码（首登强制改密），供管理员告知本人。
    async function syncAccount(name) {
      try {
        const r = await api(`/api/classes/${encodeURIComponent(name)}/sync-account`, { method: 'POST', body: {} });
        const s = r.summary || { created: 0, linked: 0, skipped: 0, failed: 0 };
        modal({
          title: `同步结果：${name}`,
          width: 560,
          showFooter: false,
          body: `<div class="import-result">
            <div class="ir-line ok">✓ 同步完成：新建账号 <b>${s.created}</b>，关联班级 <b>${s.linked}</b>，无需处理 <b>${s.skipped}</b>${s.failed ? `，<b style="color:var(--danger)">失败 ${s.failed}</b>` : ''}</div>
            ${r.results.map((x) => {
              const a = SYNC_ACT[x.action] || { cls: 'tag-gray', text: x.action || '' };
              return `<div class="ir-line ${x.ok ? 'ok' : 'bad'}">${x.ok ? '✓' : '✗'} <span class="tag ${a.cls}">${a.text}</span> ${esc(x.post)}·${esc(x.name)}：${esc(x.message)}${x.initialPassword ? `<div class="muted small" style="margin-top:2px">初始密码：<b>${esc(x.initialPassword)}</b>（首次登录将强制修改，请告知本人）</div>` : ''}</div>`;
            }).join('')}
          </div>
          <div style="margin-top:14px;text-align:right"><button class="btn" data-act="closeX">关闭</button></div>`,
          onMount(wrap, close) {
            wrap.querySelector('[data-act="closeX"]').onclick = close;
          },
        });
        toast(
          s.created || s.linked ? `同步完成：新建 ${s.created}，关联 ${s.linked}${s.failed ? `，失败 ${s.failed}` : ''}` : '同步完成：无需处理项',
          s.failed ? 'info' : 'success'
        );
        load();
      } catch (e) {
        toast(e.message, 'error');
      }
    }

    // ---- 事件 ----
    root.querySelector('#btnAdd').onclick = () => classModal(null);
    root.querySelector('#btnTpl').onclick = () => apiDownload('/api/templates/classes', '班级管理导入模板.xlsx');
    root.querySelector('#btnImport').onclick = () =>
      importModal({
        title: '批量导入班级',
        templateName: 'classes',
        templateFile: '班级管理导入模板.xlsx',
        tip: '模板字段：班级（必填）、年级、专业、班主任、班主任工号、辅导员、辅导员工号、纪律委员、纪律委员学号。<br/>按"班级"匹配：已存在则更新（<b>表格留空表示不改动原值</b>），不存在则新增。三岗位缺任一会标记为"待补信息"。请上传 .xlsx 格式的 Excel 文件。',
        doImport: (rows) => api('/api/classes/import', { method: 'POST', body: { rows } }),
        onDone: () => {
          refreshMeta().then(load);
        },
      });

    root.querySelector('#btnMigrate').onclick = async () => {
      const ok = await confirmDialog(
        '将把<b>班级名单</b>中逐学生冗余的班主任 / 辅导员 / 纪律委员信息，按班级聚合迁移到班级管理。<br/>同一班级内若存在不同值，取出现次数最多的（众数）。<br/>迁移不会删除学生数据，可重复执行。',
        { title: '存量迁移', okText: '开始迁移' }
      );
      if (!ok) return;
      try {
        const r = await api('/api/classes/migrate', { method: 'POST', body: {} });
        modal({
          title: '迁移完成',
          width: 560,
          showFooter: false,
          body: `<div class="import-result">
            <div class="ir-line ok">✓ 共 ${r.total} 个班级：新增 ${r.created}，补全 ${r.updated}，无变化 ${r.unchanged}${r.conflicts ? `，字段冲突 ${r.conflicts} 处（已按众数取值）` : ''}</div>
          </div>
          <div style="max-height:280px;overflow:auto;margin-top:10px">
            <table class="table"><thead><tr><th>班级</th><th>处理</th></tr></thead><tbody>
              ${r.report.map((x) => `<tr><td>${esc(x.name)}</td><td>${x.action === 'created' ? '<span class="tag tag-green">新增</span>' : x.action === 'updated' ? '<span class="tag tag-blue">补全</span>' : '<span class="tag tag-gray">无变化</span>'}</td></tr>`).join('')}
            </tbody></table>
          </div>
          <div style="margin-top:14px;text-align:right"><button class="btn" data-act="closeX">关闭</button></div>`,
          onMount(wrap, close) {
            wrap.querySelector('[data-act="closeX"]').onclick = close;
          },
        });
        await refreshMeta();
        load();
      } catch (e) {
        toast(e.message, 'error');
      }
    };

    root.querySelector('#btnSearch').onclick = () => {
      state.grade = gradeSel.value;
      state.status = root.querySelector('#statusFilter').value;
      state.q = root.querySelector('#q').value.trim();
      state.page = 1;
      load();
    };
    root.querySelector('#q').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') root.querySelector('#btnSearch').click();
    });

    checkAll.onchange = () => {
      tbody.querySelectorAll('input[data-check]').forEach((b) => {
        b.checked = checkAll.checked;
        if (checkAll.checked) selected.add(b.dataset.check);
        else selected.delete(b.dataset.check);
      });
      syncBatchBtn();
    };
    tbody.addEventListener('change', (e) => {
      const b = e.target.closest('input[data-check]');
      if (!b) return;
      if (b.checked) selected.add(b.dataset.check);
      else selected.delete(b.dataset.check);
      syncBatchBtn();
    });
    // ---- 批量同步账号（修改77）----
    // 勾选班级 → 同步所选；未勾选 → 同步当前筛选范围内的全部班级（与列表同口径）。
    // 明细只列出「新建账号」与「失败项」（跳过项通常很多，用每班汇总数字表达）。
    function showBatchResult(r) {
      const s = r.summary || { created: 0, linked: 0, skipped: 0, failed: 0 };
      const blocks = (r.classes || [])
        .map((c) => {
          const cs = c.summary || {};
          const head = c.empty
            ? `<div class="ir-line warn">⚠ ${esc(c.name)}：未维护岗位人员，已跳过</div>`
            : `<div class="ir-line ok">${esc(c.name)}：新建 <b>${cs.created}</b>，关联 <b>${cs.linked}</b>，跳过 ${cs.skipped}${cs.failed ? `，<b style="color:var(--danger)">失败 ${cs.failed}</b>` : ''}</div>`;
          const lines = (c.results || [])
            .filter((x) => x.action === 'created' || !x.ok)
            .map((x) => {
              const a = SYNC_ACT[x.action] || { cls: 'tag-gray', text: '' };
              return `<li><span class="tag ${a.cls}">${a.text}</span> ${esc(x.post)}·${esc(x.name)}：${esc(x.message)}${x.initialPassword ? `　初始密码 <b>${esc(x.initialPassword)}</b>` : ''}</li>`;
            })
            .join('');
          return head + (lines ? `<ul class="ir-errs ir-notices">${lines}</ul>` : '');
        })
        .join('');
      modal({
        title: `批量同步结果（${r.total} 个班级）`,
        width: 620,
        showFooter: false,
        body: `<div class="import-result">
            <div class="ir-line ok">✓ 汇总：新建账号 <b>${s.created}</b>，关联班级 <b>${s.linked}</b>，无需处理 <b>${s.skipped}</b>${s.failed ? `，<b style="color:var(--danger)">失败 ${s.failed}</b>` : ''}</div>
            ${(r.missingNames || []).length ? `<div class="ir-line warn">⚠ 以下班级已不存在，未同步：${esc(r.missingNames.join('、'))}</div>` : ''}
            <div class="muted small" style="margin-top:6px">明细仅列出「新建账号」与「失败项」；新建账号的初始密码请告知本人，首次登录将强制修改。</div>
          </div>
          <div style="max-height:340px;overflow:auto;margin-top:10px">${blocks}</div>
          <div style="margin-top:14px;text-align:right"><button class="btn" data-act="closeX">关闭</button></div>`,
        onMount(wrap, close) {
          wrap.querySelector('[data-act="closeX"]').onclick = close;
        },
      });
    }

    batchBtn.onclick = async () => {
      const names = [...selected];
      const scope = names.length
        ? `所选 <b>${names.length}</b> 个班级`
        : `当前筛选范围内的<b>全部班级</b>（${esc(filterDesc())}）`;
      const ok = await confirmDialog(
        `将对 ${scope} 执行「批量同步账号」：<br/>缺失的班主任 / 辅导员 / 纪律委员账号会<b>自动创建</b>（按工号 / 学号，首登强制改密）；<br/>已存在的账号不重复创建，只把对应班级加入其可点名班级。`,
        { title: '批量同步账号', okText: '开始同步' }
      );
      if (!ok) return;
      batchBtn.disabled = true;
      try {
        const r = await api('/api/classes/sync-account-batch', {
          method: 'POST',
          body: { names, grade: state.grade, status: state.status, q: state.q },
        });
        const s = r.summary || {};
        showBatchResult(r);
        toast(
          s.created || s.linked ? `批量同步完成：新建 ${s.created}，关联 ${s.linked}${s.failed ? `，失败 ${s.failed}` : ''}` : '批量同步完成：无需处理项',
          s.failed ? 'info' : 'success'
        );
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        batchBtn.disabled = false;
        syncBatchBtn();
      }
      load();
    };

    tbody.onclick = async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      const name = e.target.closest('tr, .rc-card')?.dataset.id;
      if (!name) return;
      const c = listCache.find((x) => x.name === name);
      if (!c) return;
      if (act === 'edit') return classModal(c);
      if (act === 'sync') return syncAccount(c.name);
      if (act === 'del') {
        const ok = await confirmDialog(`确定删除班级 <b>${esc(c.name)}</b> 吗？<br/>仅在该班无任何学生 / 教职工 / 账号引用时才能删除。`, { danger: true, title: '删除班级' });
        if (!ok) return;
        try {
          await api(`/api/classes/${encodeURIComponent(c.name)}`, { method: 'DELETE' });
          toast('班级已删除');
          await refreshMeta();
          load();
        } catch (err) {
          toast(err.message, 'error');
        }
      }
    };

    await refreshMeta();
    cascade.sync({ keepValue: false, silent: true });
    await load();
  },
};
