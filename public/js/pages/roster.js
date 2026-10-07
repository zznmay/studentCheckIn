import { api, apiDownload } from '../api.js';
import { esc, modal, toast, confirmDialog, renderPager, importModal, ICONS } from '../ui.js';
// 修改69：年级 → 班级级联复用共享模块（与 stats 缺勤统计同一份实现，规则完全一致）
import { createGradeClassCascade, deriveGrades } from '../gradeClassCascade.js';

const state = { grade: '', className: '', q: '', page: 1, pageSize: 20 };
let listCache = [];
let classes = [];
let grades = [];

export default {
  async mount(root) {
    const classOptions = (selected) =>
      classes.map((c) => `<option value="${esc(c.name)}" ${selected === c.name ? 'selected' : ''}>${esc(c.name)}（${c.count}人）</option>`).join('');

    root.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <h2>班级名单管理</h2>
          <p class="page-desc">维护各班级学生名单，支持模板批量导入、批量删除与单条增改；班主任 / 辅导员 / 纪律委员在 <a href="#/classes">班级管理</a> 中按班级统一维护，本页只读展示</p>
        </div>
        <div class="page-actions">
          <button class="btn" id="btnTpl">${ICONS.download} 下载导入模板</button>
          <button class="btn" id="btnImport">${ICONS.upload} 批量导入</button>
          <button class="btn btn-primary" id="btnAdd">${ICONS.plus} 新增学生</button>
        </div>
      </div>
      <div class="card">
        <div class="toolbar">
          <select class="select" id="gradeFilter" style="width:130px"><option value="">全部年级</option></select>
          <select class="select" id="clsFilter" style="width:190px"><option value="">全部班级</option>${classOptions('')}</select>
          <input class="input" id="q" autocomplete="off" placeholder="搜索姓名 / 学号 / 辅导员等" style="width:210px" />
          <button class="btn" id="btnSearch">查询</button>
          <div class="spacer"></div>
          <button class="btn btn-danger-plain" id="btnBatchDel" disabled>删除选中</button>
          <button class="btn btn-danger-plain" id="btnClear" title="清空当前筛选班级（未筛选时为全部班级）的名单数据，不影响登录账号">${ICONS.trash} 清空全部数据</button>
        </div>
        <div class="table-wrap">
          <table class="table" data-card="k,-,s,t,n,m,m,m,x">
            <thead>
              <tr>
                <th style="width:36px"><input type="checkbox" id="checkAll" /></th>
                <th>年级</th>
                <th>班级</th><th>姓名</th><th>学号</th>
                <th title="取自班级管理">纪律委员</th><th title="取自班级管理">辅导员</th><th title="取自班级管理">班主任</th><th class="td-actions">操作</th>
              </tr>
            </thead>
            <tbody id="tbody"><tr><td colspan="8" class="table-empty">加载中…</td></tr></tbody>
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
    const batchBtn = root.querySelector('#btnBatchDel');
    const checkAll = root.querySelector('#checkAll');
    root.querySelector('#pageSizeSel').onchange = (e) => {
      state.pageSize = Number(e.target.value) || 20;
      state.page = 1;
      load();
    };

    // ==================== 修改69：年级 → 班级 级联筛选 ====================
    // 改造前：#gradeFilter 与 #clsFilter 是两枚互相独立的下拉 —— 选年级不联动班级，
    //         可以选出不属于该年级的班级。
    // 改造后：复用共享模块 public/js/gradeClassCascade.js（与 stats 缺勤统计同一份实现），
    //   ① 切年级 → 班级只列该年级班级；已选班级不属该年级则自动清空（含恢复「全部班级」）
    //   ② 切班级 → 年级反向回写为该班归属年级；选回「全部班级」只解班级、保留年级
    //   ③ 全部年级 = 不限制班级
    //   ④ 单层页面，仅 #gradeFilter / #clsFilter 两个元素
    //   ⑤ onChange 只把级联结果同步进 state，**不自动 load()** ——
    //      本页原语义是「点查询按钮（或搜索框回车）才查询」，此处保持原样不变。
    // 班级选项文案保持原样「班级名（N人）」，⛔ value 仍为 c.name（不含人数）。
    // 注：本段必须位于 root.innerHTML 之后 —— 两枚 select 此时才存在于 DOM 中。
    const cascade = createGradeClassCascade({
      classList: classes,
      gradeEls: [root.querySelector('#gradeFilter')],
      clsEls: [root.querySelector('#clsFilter')],
      formatClsLabel: (c) => `${c.name}（${c.count}人）`,
      onChange: (g, c) => {
        state.grade = g;
        state.className = c; // 规则⑤：只同步 state，不自动查询
      },
    });

    const selected = new Set();
    // 修改76：当前筛选范围（所选班级或全部）内的学生总数，供「清空全部数据」确认框展示
    let scopeTotal = 0;

    function syncBatchBtn() {
      batchBtn.disabled = selected.size === 0;
      batchBtn.textContent = selected.size ? `删除选中（${selected.size}）` : '删除选中';
      const boxes = tbody.querySelectorAll('input[type="checkbox"]');
      checkAll.checked = boxes.length > 0 && [...boxes].every((b) => b.checked);
    }

    async function load() {
      tbody.innerHTML = '<tr><td colspan="9" class="table-empty">加载中…</td></tr>';
      const params = new URLSearchParams({ page: state.page, pageSize: state.pageSize });
      if (state.grade) params.set('grade', state.grade);
      if (state.className) params.set('className', state.className);
      if (state.q) params.set('q', state.q);
      const d = await api(`/api/students?${params}`);
      listCache = d.list;
      selected.clear();
      scopeTotal = d.total; // 修改76：当前筛选范围（所选班级或全部）内的学生总数，供「清空全部数据」确认框展示
      infoEl.textContent = `共 ${d.total} 名学生`;
      renderPager(pagerEl, d, (p) => {
        state.page = p;
        load();
      });
      tbody.innerHTML = d.list.length
        ? d.list
            .map(
              (s) => `
        <tr data-id="${s.id}">
          <td><input type="checkbox" data-check="${s.id}" /></td>
          <td>${esc(s.grade) || '<span class="muted">—</span>'}</td>
          <td><span class="tag tag-gray">${esc(s.className)}</span></td>
          <td><b>${esc(s.name)}</b></td>
          <td class="num">${esc(s.studentId)}</td>
          <td>${esc(s.disciplineMember) || '<span class="muted">—</span>'}</td>
          <td>${esc(s.counselor) || '<span class="muted">—</span>'}</td>
          <td>${esc(s.classTeacher) || '<span class="muted">—</span>'}</td>
          <td class="td-actions">
            <button class="btn-text" data-act="edit">编辑</button>
            <button class="btn-text danger" data-act="del">删除</button>
          </td>
        </tr>`
            )
            .join('')
        : '<tr><td colspan="9" class="table-empty">暂无学生，点击右上角"新增学生"或"批量导入"添加</td></tr>';
      syncBatchBtn();
    }

    async function refreshClasses() {
      const meta = await api('/api/meta/classes');
      classes = meta.classes;
      // 修改69：年级选项不再直接用 meta.grades 原始值（同一届可能混写「2025级」「2025」
      // 会列成两个并列选项，且与级联过滤用的归一化值对不上），改用 deriveGrades 归一化去重降序。
      // 该结果同时供学生弹窗的 gradeOptions datalist 使用（自由输入联想，非级联）——
      // 与级联下拉同源，避免 datalist 里出现级联选不到的原始值。
      grades = deriveGrades(classes);
      // 修改69：交给级联统一重渲染年级 + 班级选项，并保留当前已选年级/班级；
      // 若已选班级在新数据里不存在或已不属当前年级，按规则①清空（这是正确行为）。
      cascade.setClassList(classes);
      cascade.renderGradeOptions(cascade.getGrade());
      cascade.sync({ keepValue: true });
    }

    // ---- 新增 / 编辑 ----
    function studentModal(s) {
      const isEdit = !!s;
      // 修改72：班级岗位（班主任 / 辅导员 / 纪律委员）改为在「班级管理」按班级维度统一维护，
      // 此处不再逐生录入。三岗位的展示值由后端按班级管理权威源覆盖后返回（只读镜像）。
      const rec = isEdit ? classes.find((c) => c.name === s.className) : null;
      const postLine = rec
        ? `班主任：${esc(rec.headTeacher || '—')} · 辅导员：${esc(rec.counselor || '—')} · 纪律委员：${esc(rec.disciplineMember || '—')}`
        : '该班级尚未在「班级管理」中登记，岗位信息为空';
      modal({
        title: isEdit ? `编辑学生：${s.name}` : '新增学生',
        width: 520,
        okText: isEdit ? '保存' : '添加',
        body: `
        <div class="form">
          <div class="form-row">
            <div class="form-item" style="flex:0 0 110px"><label>年级</label>
              <input class="input" name="grade" list="gradeOptions" value="${esc(s ? s.grade : '')}" placeholder="如：2023级" />
              <datalist id="gradeOptions">${grades.map((g) => `<option value="${esc(g)}"></option>`).join('')}</datalist></div>
            <div class="form-item"><label>班级<span class="req">*</span></label>
              <input class="input" name="className" list="clsOptions" value="${esc(s ? s.className : '')}" placeholder="选择或输入班级" />
              <datalist id="clsOptions">${classes.map((c) => `<option value="${esc(c.name)}"></option>`).join('')}</datalist></div>
          </div>
          <div class="form-row">
            <div class="form-item"><label>姓名<span class="req">*</span></label><input class="input" name="name" value="${esc(s ? s.name : '')}" /></div>
            <div class="form-item"><label>学号<span class="req">*</span></label><input class="input" name="studentId" value="${esc(s ? s.studentId : '')}" /></div>
          </div>
          <div class="form-item"><label>班级岗位信息</label>
            <div class="import-tip" style="margin:0">班主任 / 辅导员 / 纪律委员请在 <a href="#/classes">班级管理</a> 中按班级维度统一维护，本页只读展示。<br/>当前班级岗位：${postLine}</div>
          </div>
        </div>`,
        onOk: async (wrap, close) => {
          const f = wrap.querySelector('.modal-body');
          const body = {
            grade: f.querySelector('[name="grade"]').value.trim(),
            className: f.querySelector('[name="className"]').value.trim(),
            name: f.querySelector('[name="name"]').value.trim(),
            studentId: f.querySelector('[name="studentId"]').value.trim(),
          };
          if (isEdit) {
            await api(`/api/students/${s.id}`, { method: 'PUT', body });
            toast('学生信息已更新');
          } else {
            await api('/api/students', { method: 'POST', body });
            toast('学生已添加');
          }
          close();
          await refreshClasses();
          load();
        },
      });
    }

    // ---- 事件 ----
    root.querySelector('#btnAdd').onclick = () => studentModal(null);
    root.querySelector('#btnTpl').onclick = () => apiDownload('/api/templates/roster', '班级名单导入模板.xlsx');
    root.querySelector('#btnImport').onclick = () =>
      importModal({
        title: '批量导入班级名单',
        templateName: 'roster',
        templateFile: '班级名单导入模板.xlsx',
        // 修改74：导入口径说明 —— 班级必须是班级管理中已登记的班级（不再自动建档）；
        // 班级不匹配的行会被**跳过**（其余行照常导入），结束后逐条列出被跳过的行号与班级名；
        // 重复导入只对真正变化的字段写库，统计条数与真实写库结果一致。
        tip: '模板字段：<b>年级、班级、姓名、学号</b>（班级 + 姓名 + 学号为必填）。<br/>导入时按"班级 + 学号"匹配：已存在则更新发生变动的字段，不存在则新增；内容完全一致的条目计为"无变化"，不会重复写库。<br/><b>班级必须已在 <a href="#/classes">班级管理</a> 中登记</b>：班级不匹配的行会被<b>跳过</b>（不会自动建档），其余行照常导入；导入结束后会逐条列出被跳过的行号与班级名，请先到班级管理登记后再次导入这些行。<br/>班主任 / 辅导员 / 纪律委员请统一在班级管理中维护，本页只读展示，模板中不含这三列。请上传 .xlsx 格式的 Excel 文件。',
        doImport: (rows) => api('/api/students/import', { method: 'POST', body: { rows } }),
        onDone: () => {
          refreshClasses().then(load);
        },
      });

    root.querySelector('#btnSearch').onclick = () => {
      state.grade = root.querySelector('#gradeFilter').value;
      state.className = root.querySelector('#clsFilter').value;
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

    batchBtn.onclick = async () => {
      if (!selected.size) return;
      const ok = await confirmDialog(`确定删除选中的 <b>${selected.size}</b> 名学生吗？删除后不可恢复。`, { danger: true, title: '批量删除' });
      if (!ok) return;
      const r = await api('/api/students/batch-delete', { method: 'POST', body: { ids: [...selected] } });
      toast(`已删除 ${r.deleted} 名学生`);
      load();
    };

    // 修改76：清空名单数据 —— 仅删除 students（按所选班级或全部），登录账号 / 考勤 / 假单不受影响
    root.querySelector('#btnClear').onclick = async () => {
      const scopeName = state.className || '';
      const n = scopeTotal;
      if (!n) return toast('当前范围为空，无需清空', 'info');
      const scopeLine = scopeName
        ? `将删除班级 <b>${esc(scopeName)}</b> 名单中的全部 <b>${n}</b> 名学生。`
        : `当前未筛选班级：将删除 <b>全部班级</b> 共 <b>${n}</b> 名学生的名单数据。`;
      const ok = await confirmDialog(
        `${scopeLine}<br/>清空范围仅限<b>班级名单数据</b>：<b>登录账号、考勤与假单记录均不受影响</b>；名单删除后需重新导入。<br/><b>此操作不可恢复，请确认。</b>`,
        { danger: true, title: '清空全部数据', okText: '确认清空' }
      );
      if (!ok) return;
      const r = await api('/api/students/clear', { method: 'POST', body: { className: scopeName } });
      toast(`已清空 ${r.deleted} 条名单数据${scopeName ? `（${scopeName}）` : '（全部班级）'}`);
      state.page = 1;
      await refreshClasses();
      load();
    };

    tbody.onclick = async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      // 修复52：手机端卡片化会把操作按钮移出 <tr> 移入 .rc-card，故不能只找 tr
      const id = e.target.closest('tr, .rc-card')?.dataset.id;
      if (!id) return;
      const s = listCache.find((x) => x.id === id);
      if (!s) return;
      if (act === 'edit') return studentModal(s);
      if (act === 'del') {
        const ok = await confirmDialog(`确定删除学生 <b>${esc(s.name)}</b>（${esc(s.studentId)}）吗？`, { danger: true, title: '删除学生' });
        if (!ok) return;
        await api(`/api/students/${s.id}`, { method: 'DELETE' });
        toast('学生已删除');
        await refreshClasses();
        load();
      }
    };

    await refreshClasses();
    // 修改69：初始化后再显式渲染一次班级全量选项（空年级 = 全部班级），silent 不触发查询
    cascade.sync({ keepValue: false, silent: true });
    await load();
  },
};
