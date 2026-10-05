import { api, apiPostDownload } from '../api.js';
import { esc, modal, toast, renderPager, rateCell, today, enhanceTables, punishmentTagCls, ICONS, upgradeSelectToCombo } from '../ui.js';
// 修改69：年级 → 班级级联已抽取为共享模块，本页不再自持一份实现（roster.js 复用同一份）
import { createGradeClassCascade, deriveGrades } from '../gradeClassCascade.js';

// 班级汇总 / 学生明细（到课率统计）
const state = { from: '', to: '', className: '', tab: 'class', page: 1, pageSize: 15 };
let data = { byClass: [], byStudent: [] };

// 缺勤统计
const abs = { dimension: 'week', from: '', to: '', grade: '', className: '', student: '', min: '', max: '', data: null };

// 缺勤月报（修改36）：本月 / 本学期 / 本学年累计 + 生效中最高处分
const mo = { month: '', className: '', page: 1, pageSize: 20, data: null };

let grades = [];
let classList = [];

const CLASS_HEADERS = ['班级', '点名次数', '应到人次', '出勤', '迟到', '缺勤', '请假', '到课率(%)'];
const STU_HEADERS = ['班级', '学号', '姓名', '应到人次', '出勤', '迟到', '缺勤', '请假', '到课率(%)'];

function rowsForExport() {
  if (state.tab === 'class') {
    return data.byClass.map((c) => [c.className, c.sessions, c.should, c['出勤'], c['迟到'], c['缺勤'], c['请假'], c.rate]);
  }
  return data.byStudent.map((s) => [s.className, s.studentId, s.name, s.should, s['出勤'], s['迟到'], s['缺勤'], s['请假'], s.rate]);
}

function dstr(offset = 0, base = new Date()) {
  const t = new Date(base);
  t.setDate(t.getDate() + offset);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}
function mondayOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const day = d.getDay() === 0 ? 7 : d.getDay();
  d.setDate(d.getDate() - (day - 1));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default {
  async mount(root) {
    const meta = await api('/api/meta/classes');
    classList = meta.classes;
    grades = meta.grades || [];

    const end = today();
    const startD = new Date();
    startD.setDate(startD.getDate() - 29);
    const start = `${startD.getFullYear()}-${String(startD.getMonth() + 1).padStart(2, '0')}-${String(startD.getDate()).padStart(2, '0')}`;
    state.from = start;
    state.to = end;
    // 缺勤统计默认本周
    abs.from = mondayOf(end);
    abs.to = end;

    // 修改66：选项仅显示班级名称（移除「（人数）」括号人数信息），value 仍为 c.name 不变
    const clsOptions = (selected) => classList.map((c) => `<option value="${esc(c.name)}" ${selected === c.name ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    // 修改60：年级选项改由 classList 推导并归一化，替代 meta.grades 原值。
    // 原因：真实数据同一届可能混写「2025级」「2025」，原值直接列会出现两个并列选项，
    // 且与级联过滤用的归一化值对不上。归一化 + 去重 + 降序（新年级在前）。
    // 修改69：归一化/去重/排序规则移入共享模块 deriveGrades（原 normGradeAbs 已删除），
    //         「班级汇总」标签页的 #clsFilter / #mClsFilter 组合框不参与级联，此处逻辑未受影响。
    grades = deriveGrades(classList);
    const gradeOptions = (selected) => grades.map((g) => `<option value="${esc(g)}" ${selected === g ? 'selected' : ''}>${esc(g)}</option>`).join('');

    root.innerHTML = `
    <div class="page page-stats">
      <!-- 修改46：桌面层（4.6 原样）页头 -->
      <div class="d-layer">
        <div class="page-head">
          <div>
            <h2>数据统计</h2>
            <p class="page-desc">到课率 =（出勤 + 迟到）÷ 应到人次；缺勤节数按节次权重计（常规节次记 2 节，早自习/晚自习记 1 节），迟到一次折 0.5 节计入缺勤节数</p>
          </div>
          <div class="page-actions">
            <button class="btn btn-primary" id="btnExport">导出当前数据（Excel）</button>
          </div>
        </div>
      </div>
      <!-- 手机层 hero（设计稿，≤720px） -->
      <div class="m-layer">
        <div class="stats-hero">
          <div class="st-hero-ic si-blue">${ICONS.chart}</div>
          <div class="st-hero-tx">
            <h2>数据统计</h2>
            <p><span class="tx-d">统计考勤数据，掌握出勤情况</span><span class="tx-m">实时统计学生考勤情况，掌握班级出勤动态</span></p>
          </div>
          <div class="hero-bars" aria-hidden="true"><i></i><i></i><i></i></div>
          <div class="page-actions"><button class="btn btn-primary st-export" id="mBtnExport">${ICONS.download}<span class="tx-d">导出 Excel</span><span class="tx-m">导出当前数据（Excel）</span><span class="stx-arrow tx-m">${ICONS.chevronR}</span></button></div>
        </div>
      </div>

      <div class="card" style="padding:10px 16px; margin-bottom:12px">
        <div class="tabs">
          <button class="tab-btn active" data-tab="class"><span class="tab-ic tx-m">${ICONS.chart}</span>班级汇总</button>
          <button class="tab-btn" data-tab="student"><span class="tab-ic tx-m">${ICONS.user}</span>学生明细</button>
          <button class="tab-btn" data-tab="absence"><span class="tab-ic tx-m">${ICONS.calendar}</span>缺勤统计</button>
          <button class="tab-btn" data-tab="monthly"><span class="tab-ic tx-m">${ICONS.file}</span>缺勤月报</button>
        </div>
      </div>

      <div class="card" id="filterCard">
        <div class="toolbar tx-d" style="margin-bottom:8px">
          <input type="date" class="input" id="from" value="${state.from}" style="width:145px" />
          <span class="muted small">至</span>
          <input type="date" class="input" id="to" value="${state.to}" style="width:145px" />
          <select class="select" id="clsFilter" style="width:180px">
            <option value="">全部班级</option>
            ${clsOptions('')}
          </select>
          <button class="btn btn-primary" id="btnSearch">查询</button>
        </div>
        <div class="fc-grid fc-m">
          <div class="fc-field">${ICONS.calendar}<div class="fc-tx"><label for="mFrom">开始日期</label><input type="date" class="input" id="mFrom" value="${state.from}" /></div></div>
          <span class="fc-sep">至</span>
          <div class="fc-field">${ICONS.calendar}<div class="fc-tx"><label for="mTo">结束日期</label><input type="date" class="input" id="mTo" value="${state.to}" /></div></div>
          <div class="fc-field f-span">${ICONS.cap}<div class="fc-tx"><label for="mClsFilter">班级选择</label><select class="select" id="mClsFilter">
            <option value="">全部班级</option>
            ${clsOptions('')}
          </select></div></div>
          <button class="btn btn-primary fc-search" id="mBtnSearch">${ICONS.search} 查询</button>
        </div>
        <!-- 说明行：4.6 桌面无此行（说明在 page-head 副文），保留给手机层 -->
        <div class="m-layer"><div class="muted small">到课率 =（出勤 + 迟到）÷ 应到人次；缺勤节数按节次权重计（常规节次记 2 节，早自习/晚自习记 1 节），迟到一次折 0.5 节计入缺勤节数</div></div>
      </div>

      <div class="card st-filter" id="absenceCard" style="display:none">
        <!-- 修改46：桌面层筛选（4.6 原样：两行 toolbar + 内联说明） -->
        <div class="d-layer">
          <div class="toolbar" style="margin-bottom:8px">
            <select class="select" id="abDim" style="width:110px">
              <option value="week">按周统计</option>
              <option value="month">按月统计</option>
              <option value="year">按年统计</option>
              <option value="custom">自定义区间</option>
            </select>
            <input type="date" class="input" id="abFrom" style="width:145px" />
            <span class="muted small">至</span>
            <input type="date" class="input" id="abTo" style="width:145px" />
            <button class="btn btn-primary" id="abSearch">查询</button>
            <div class="spacer"></div>
          </div>
          <div class="toolbar" style="margin-bottom:0">
            <select class="select" id="abGrade" style="width:130px"><option value="">全部年级</option>${gradeOptions('')}</select>
            <select class="select" id="abCls" style="width:160px"><option value="">全部班级</option>${clsOptions('')}</select>
            <input type="text" class="input" id="abStudent" autocomplete="off" placeholder="学号 / 姓名关键字" style="width:170px" />
            <input type="number" class="input" id="abMin" placeholder="缺勤节数 ≥" style="width:120px" min="0.5" step="0.5" />
            <input type="number" class="input" id="abMax" placeholder="缺勤节数 ≤" style="width:120px" min="0.5" step="0.5" />
          </div>
          <div class="muted small mt14">缺勤节数按节次权重计（常规节次记 2 节，早自习/晚自习记 1 节），迟到一次折 0.5 节计入；统计"缺勤"记录次数与"迟到"折算节数；迟到次数按迟到记录条数计；早/晚自习缺勤次数=节次含早自习或晚自习的缺勤记录条数；按学生合计后可用缺勤节数区间过滤（支持小数）。</div>
        </div>
        <!-- 手机层筛选（设计稿；控件 m 前缀，共用同一 state） -->
        <div class="m-layer">
          <div class="ab-grid">
            <div class="ab-row2">
              <div class="icon-field has-tail">${ICONS.user}<input type="text" class="input" id="mAbStudent" autocomplete="off" placeholder="学号 / 姓名" /><span class="if-tail">${ICONS.search}</span></div>
              <div class="icon-field">${ICONS.calendar}<input type="number" class="input" id="mAbMin" placeholder="缺勤节数 ≥" min="0.5" step="0.5" /></div>
            </div>
            <div class="icon-field">${ICONS.clock}<input type="number" class="input" id="mAbMax" placeholder="缺勤节数 ≤" min="0.5" step="0.5" /></div>
            <button class="btn btn-primary ab-search" id="mAbSearch">${ICONS.search} 查询</button>
          </div>
          <button class="ab-more-btn" id="abMoreBtn" type="button">更多筛选：维度 / 日期 / 年级 / 班级 ${ICONS.chevron}</button>
          <div class="ab-more" id="abMore" hidden>
            <div class="ab-more-grid">
              <select class="select" id="mAbDim">
                <option value="week">按周统计</option>
                <option value="month">按月统计</option>
                <option value="year">按年统计</option>
                <option value="custom">自定义区间</option>
              </select>
              <select class="select" id="mAbGrade"><option value="">全部年级</option>${gradeOptions('')}</select>
              <input type="date" class="input" id="mAbFrom" />
              <input type="date" class="input" id="mAbTo" />
              <select class="select f-span" id="mAbCls"><option value="">全部班级</option>${clsOptions('')}</select>
            </div>
          </div>
        </div>
      </div>

      <!-- 手机层：规则说明卡（仅 ≤720px 缺勤 tab 显示，桌面恢复 4.6 内联说明） -->
      <div class="m-layer">
        <div class="card ab-rules-card" id="absRulesCard" style="display:none">
          <div class="ab-rules-head"><span class="ab-rules-ic">${ICONS.info}</span><b>统计规则说明</b></div>
          <p class="ab-rules-body">缺勤节数按节次权重计（常规节次记 2 节，早自习/晚自习记 1 节），迟到一次折 0.5 节计入；统计"缺勤"记录次数与"迟到"折算节数；迟到次数按迟到记录条数计；早/晚自习缺勤次数=节次含早自习或晚自习的缺勤记录条数；按学生合计后可用缺勤节数区间过滤（支持小数）。</p>
        </div>
      </div>

      <div class="card" id="monthlyCard" style="display:none">
        <div class="toolbar" style="margin-bottom:0">
          <label class="muted small" for="moYear">月份</label>
          <!-- 修改59：弃用原生 <input type="month">。
               根因：原生 month 控件在 Android Chrome / WebView 上唤起的是**系统 picker 弹窗**
               （标题「设置月份」+ 清除/取消/设置），属系统 UI，页面 CSS 无法控制其内部配色，
               于是渲染成「浅色字 + 浅色底」几乎不可见；:root 的 color-scheme: only light 也管不到它。
               改为自绘「年 + 月」双 <select>，视觉与项目其它筛选控件一致，配色完全由本页 CSS 控制。
               #moMonth 保留在包装容器上（不再是 input），下游契约 YYYY-MM 不变。 -->
          <span class="mo-month" id="moMonth">
            <select class="select mo-month-y" id="moYear" aria-label="年份"></select>
            <span class="mo-month-suf" aria-hidden="true">年</span>
            <select class="select mo-month-m" id="moMon" aria-label="月份"></select>
            <span class="mo-month-suf" aria-hidden="true">月</span>
          </span>
          <select class="select" id="moCls" style="width:180px">
            <option value="">全部班级</option>
            ${clsOptions('')}
          </select>
          <button class="btn btn-primary" id="moSearch">查询</button>
          <div class="spacer"></div>
        </div>
        <div class="muted small mt14" id="moRangeHint"></div>
        <div class="muted small">展示规则：仅列出「本月缺勤节数 &gt; 0」的学生，按本月缺勤节数降序排列；缺勤节数按节次权重计（常规节次记 2 节，早/晚自习记 1 节），迟到一次折 0.5 节；处分情况为该生截至目前<b>生效中</b>的最高等级处分（已自动撤销的不计），无处分则留空；「本学期 / 本学年」按查询月份所属学期与学年累计，学期起止沿用缺勤公示的学期配置。</div>
      </div>

      <div class="card" id="tableCard">
        <!-- 手机层：面板标题 + 四卡片容器（≤720px 由 mode-* 门控与表格互换） -->
        <div class="m-layer">
          <div class="panel-head">
            <span class="panel-title">${ICONS.cap}<span id="tableTitle">班级考勤汇总</span></span>
            <span class="st-badge" id="tableBadge" hidden></span>
          </div>
          <div class="abs-cards" id="absCardList" hidden></div>
          <div class="cls-cards" id="clsCardList" hidden></div>
          <div class="stu-cards" id="stuCardList" hidden></div>
          <div class="mo-cards" id="moCardList" hidden></div>
        </div>
        <div class="table-wrap" id="tableWrap"><div class="table-empty">加载中…</div></div>
        <div class="card-foot">
          <div class="table-info" id="info"></div>
          <div class="pager" id="pager"></div>
        </div>
      </div>
    </div>`;

    const filterCard = root.querySelector('#filterCard');
    const absenceCard = root.querySelector('#absenceCard');
    const monthlyCard = root.querySelector('#monthlyCard');
    const tableWrap = root.querySelector('#tableWrap');
    const pagerEl = root.querySelector('#pager');
    const infoEl = root.querySelector('#info');

    // ==================== 到课率统计（班级汇总 / 学生明细，原有功能） ====================
    // 修改45：移动端班级卡 / 学生卡（≤720px 由 CSS 门控显示，桌面表格不受影响）
    function buildClsCards(rows) {
      const range = `${state.from || '开始'} - ${state.to || '现在'}`;
      return rows
        .map(
          (r) => `
          <div class="cs-card">
            <div class="cs-head">
              <span class="cs-avatar">${esc(String(r.className).slice(0, 2))}</span>
              <div class="cs-tx"><b>${esc(r.className)}</b><span>考勤统计时间：${esc(range)}</span></div>
              <span class="cs-arrow">${ICONS.chevronR}</span>
            </div>
            <div class="cs-grid">
              <div class="cs-cell">${ICONS.user}<b>${r.sessions}</b><span>点名次数</span></div>
              <div class="cs-cell">${ICONS.users}<b>${r.should}</b><span>应到人次</span></div>
              <div class="cs-cell cc-green">${ICONS.checkC}<b>${r['出勤']}</b><span>出勤</span></div>
              <div class="cs-cell cc-orange">${ICONS.clock}<b>${r['迟到']}</b><span>迟到</span></div>
              <div class="cs-cell cc-red">${ICONS.alert}<b>${r['缺勤']}</b><span>缺勤</span></div>
            </div>
            <div class="cs-rate"><span>到课率</span><div class="cs-bar"><i style="width:${Math.min(100, r.rate)}%"></i></div><b>${r.rate}%</b></div>
          </div>`
        )
        .join('');
    }
    function buildStuCards(rows) {
      return rows
        .map(
          (r) => `
          <div class="su-card">
            <div class="su-head">
              <span class="su-avatar">${esc(String(r.name).slice(0, 1))}</span>
              <div class="su-tx"><b>${esc(r.name)}</b><span>学号：${esc(r.studentId)}</span></div>
              <span class="su-cls">${ICONS.users}${esc(r.className)}</span>
            </div>
            <div class="su-cols">
              <div class="su-col"><span>应到人次</span><b>${r.should}</b></div>
              <div class="su-col"><span>出勤</span><b class="cm-green">${r['出勤']}</b></div>
              <div class="su-col"><span>迟到</span><b class="${r['迟到'] ? 'cm-orange' : ''}">${r['迟到']}</b></div>
              <div class="su-col"><span>缺勤</span><b class="${r['缺勤'] ? 'cm-red' : ''}">${r['缺勤']}</b></div>
              <div class="su-col"><span>请假</span><b class="${r['请假'] ? 'cm-blue' : ''}">${r['请假']}</b></div>
            </div>
            <div class="cs-rate"><span class="has-pie">${ICONS.pie}到课率</span><div class="cs-bar"><i style="width:${Math.min(100, r.rate)}%"></i></div><b>${r.rate}%</b></div>
          </div>`
        )
        .join('');
    }

    function renderStatTable() {
      const rows = state.tab === 'class' ? data.byClass : data.byStudent;
      // 修改44/45：面板标题与徽章；四容器互斥显隐
      const titleEl = root.querySelector('#tableTitle');
      const badgeEl = root.querySelector('#tableBadge');
      if (titleEl) titleEl.textContent = state.tab === 'class' ? '班级考勤汇总' : '学生考勤明细';
      if (badgeEl) badgeEl.hidden = true;
      const absCardList = root.querySelector('#absCardList');
      if (absCardList) {
        absCardList.hidden = true;
        absCardList.innerHTML = '';
      }
      const moList = root.querySelector('#moCardList');
      if (moList) {
        moList.hidden = true;
        moList.innerHTML = '';
      }
      infoEl.textContent = `共 ${rows.length} 行`;
      if (!rows.length) {
        const emptyList = state.tab === 'class' ? root.querySelector('#clsCardList') : root.querySelector('#stuCardList');
        if (emptyList) {
          emptyList.hidden = true;
          emptyList.innerHTML = '';
        }
        tableWrap.innerHTML = '<div class="table-empty">所选范围内暂无考勤数据</div>';
        pagerEl.innerHTML = '';
        return;
      }
      const pageRows = rows.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);
      // 修改45：移动端卡片列表与表格同页渲染
      const clsList = root.querySelector('#clsCardList');
      const stuList = root.querySelector('#stuCardList');
      if (clsList) {
        const show = state.tab === 'class';
        clsList.hidden = !show;
        clsList.innerHTML = show ? buildClsCards(pageRows) : '';
      }
      if (stuList) {
        const show = state.tab === 'student';
        stuList.hidden = !show;
        stuList.innerHTML = show ? buildStuCards(pageRows) : '';
      }
      const head =
        state.tab === 'class'
          ? '<tr><th>班级</th><th>点名次数</th><th>应到人次</th><th>出勤</th><th>迟到</th><th>缺勤</th><th>请假</th><th>到课率</th></tr>'
          : '<tr><th>班级</th><th>学号</th><th>姓名</th><th>应到人次</th><th>出勤</th><th>迟到</th><th>缺勤</th><th>请假</th><th>到课率</th></tr>';
      const body = pageRows
        .map((r) =>
          state.tab === 'class'
            ? `<tr>
                <td><b>${esc(r.className)}</b></td>
                <td class="num">${r.sessions}</td>
                <td class="num">${r.should}</td>
                <td class="num cm-green"><b>${r['出勤']}</b></td>
                <td class="num cm-orange">${r['迟到']}</td>
                <td class="num cm-red">${r['缺勤']}</td>
                <td class="num cm-blue">${r['请假']}</td>
                <td>${rateCell(r.rate)}</td>
              </tr>`
            : `<tr>
                <td>${esc(r.className)}</td>
                <td class="num">${esc(r.studentId)}</td>
                <td><b>${esc(r.name)}</b></td>
                <td class="num">${r.should}</td>
                <td class="num cm-green"><b>${r['出勤']}</b></td>
                <td class="num cm-orange">${r['迟到']}</td>
                <td class="num cm-red">${r['缺勤']}</td>
                <td class="num cm-blue">${r['请假']}</td>
                <td>${rateCell(r.rate)}</td>
              </tr>`
        )
        .join('');
      tableWrap.innerHTML = `<table class="table" data-card="${state.tab === 'class' ? 't,m,m,m,m,m,m,n' : 's,a,t,m,m,m,m,m,n'}"><thead>${head}</thead><tbody>${body}</tbody></table>`;
      enhanceTables(tableWrap);
      renderPager(pagerEl, { page: state.page, pageSize: state.pageSize, total: rows.length }, (p) => {
        state.page = p;
        renderStatTable();
      });
    }

    async function loadStats() {
      tableWrap.innerHTML = '<div class="table-empty">加载中…</div>';
      const params = new URLSearchParams();
      if (state.from) params.set('from', state.from);
      if (state.to) params.set('to', state.to);
      if (state.className) params.set('className', state.className);
      data = await api(`/api/stats?${params}`);
      state.page = 1;
      renderStatTable();
    }

    // ==================== 缺勤统计（按 周 / 月 / 年 / 自定义） ====================
    async function loadAbsence() {
      tableWrap.innerHTML = '<div class="table-empty">加载中…</div>';
      pagerEl.innerHTML = '';
      const params = new URLSearchParams({ dimension: abs.dimension });
      if (abs.from) params.set('from', abs.from);
      if (abs.to) params.set('to', abs.to);
      if (abs.grade) params.set('grade', abs.grade);
      if (abs.className) params.set('className', abs.className);
      if (abs.student) params.set('student', abs.student);
      if (abs.min !== '') params.set('min', abs.min);
      if (abs.max !== '') params.set('max', abs.max);
      try {
        abs.data = await api(`/api/stats/absences?${params}`);
      } catch (e) {
        tableWrap.innerHTML = `<div class="table-empty">${esc(e.message)}</div>`;
        return;
      }
      renderAbsence();
    }

    // 修改44：设计稿面板的区间标签（按周 → 「2026 年第 N 周（起~止）」，其余 → 「起 ~ 止」）
    function isoWeek(dateStr) {
      const d = new Date(`${dateStr}T00:00:00`);
      const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
      const dayNum = t.getUTCDay() || 7;
      t.setUTCDate(t.getUTCDate() + 4 - dayNum);
      const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
      return { year: t.getUTCFullYear(), week: Math.ceil(((t - y0) / 86400000 + 1) / 7) };
    }
    function schoolYearOf(dateStr) {
      const d = new Date(`${dateStr}T00:00:00`);
      const start = d.getMonth() + 1 >= 9 ? d.getFullYear() : d.getFullYear() - 1;
      return `${start}-${start + 1} 学年`;
    }
    function absenceRangeLabel(from, to) {
      if (abs.dimension === 'week') {
        const w = isoWeek(from);
        return `${w.year} 年第 ${w.week} 周（${from}~${to}）`;
      }
      return `${from} ~ ${to}`;
    }

    function renderAbsence() {
      const d = abs.data;
      const students = d.students || [];
      const titleEl = root.querySelector('#tableTitle');
      const badgeEl = root.querySelector('#tableBadge');
      const absCardList = root.querySelector('#absCardList');
      titleEl.textContent = '学生考勤统计';
      badgeEl.textContent = schoolYearOf(d.from);
      badgeEl.hidden = false;
      infoEl.innerHTML = `${esc(d.from)} ~ ${esc(d.to)}：共 ${students.length} 名学生存在缺勤记录，点击<b>姓名</b>可查看缺勤明细`;
      const rangeLabel = absenceRangeLabel(d.from, d.to);
      // 移动端设计稿面板（双渲染：桌面表格 / ≤720px 卡片，CSS 门控）
      absCardList.innerHTML = students.length
        ? students
            .map((s) => {
              const chips = d.buckets.map((b) => ({ label: b.label, v: s.byBucket[b.key] ?? 0 })).filter((x) => x.v);
              return `
          <div class="as-card">
            <div class="as-id">
              <div class="as-kv"><span>班级</span><b>${esc(s.className)}</b></div>
              <div class="as-kv"><span>学号</span><b class="num">${esc(s.studentId)}</b></div>
              <div class="as-kv"><span>姓名</span><button class="btn-text as-name" data-act="absdetail" data-cls="${esc(s.className)}" data-sid="${esc(s.studentId)}">${esc(s.name)}</button></div>
            </div>
            <div class="as-stats">
              <div class="as-range">${esc(rangeLabel)}</div>
              <div class="as-cols">
                <div class="as-col"><span>缺勤节数合计</span><b class="cm-red">${s.total}</b></div>
                <div class="as-col"><span>缺勤记录次数</span><b>${s.sessions}</b></div>
                <div class="as-col"><span>迟到次数</span><b class="${s.lateSessions ? 'cm-orange' : ''}">${s.lateSessions ?? 0}</b></div>
              </div>
              <div class="as-col as-study"><span>早/晚自习缺勤次数</span><b class="${s.studySessions ? 'cm-red' : ''}">${s.studySessions ?? 0}</b></div>
              ${chips.length ? `<div class="as-buckets">${chips.map((c) => `<span>${esc(c.label)} <b>${c.v}</b></span>`).join('')}</div>` : ''}
            </div>
          </div>`;
            })
            .join('')
        : '';
      absCardList.hidden = !students.length;
      if (!students.length) {
        tableWrap.innerHTML = '<div class="table-empty">该范围内没有缺勤记录</div>';
        pagerEl.innerHTML = '';
        return;
      }
      const bucketLabels = d.buckets.map((b) => b.label);
      const head = ['年级', '班级', '学号', '姓名', ...bucketLabels, '缺勤节数合计', '缺勤记录次数', '迟到次数', '早/晚自习缺勤次数'];
      const body = students
        .map(
          (s) => `<tr>
            <td>${esc(s.grade) || '<span class="muted">—</span>'}</td>
            <td>${esc(s.className)}</td>
            <td class="num">${esc(s.studentId)}</td>
            <td><button class="btn-text" data-act="absdetail" data-cls="${esc(s.className)}" data-sid="${esc(s.studentId)}"><b>${esc(s.name)}</b></button></td>
            ${d.buckets.map((b) => `<td class="num ${s.byBucket[b.key] ? 'cm-red' : 'muted'}">${s.byBucket[b.key] ?? 0}</td>`).join('')}
            <td class="num cm-red"><b>${s.total}</b></td>
            <td class="num">${s.sessions}</td>
            <td class="num ${s.lateSessions ? 'cm-orange' : 'muted'}">${s.lateSessions ?? 0}</td>
            <td class="num ${s.studySessions ? 'cm-red' : 'muted'}">${s.studySessions ?? 0}</td>
          </tr>`
        )
        .join('');
      // 修改44：缺勤统计桌面表格不再 data-card（移动端由 as-card 面板承担，避免双渲染冲突）
      tableWrap.innerHTML = `<table class="table" data-card="-,s,a,t,${d.buckets.map(() => 'm').join(',')},n,m,m,m"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
      enhanceTables(tableWrap);
      pagerEl.innerHTML = '';
    }

    // 缺勤详情弹窗：日期 / 状态（缺勤·迟到）/ 节次 / 上课时间段 / 课程，支持时间排序与课程筛选
    // 修改20：迟到与早/晚自习记录一并展示（状态列区分，迟到显示折 0.5 节）
    function absenceDetailModal(stuRef) {
      modal({
        title: '缺勤详情查询',
        width: 900,
        showFooter: false,
        body: `<div id="absDetailBody" class="muted small">加载中…</div>`,
        onMount: async (wrap, close) => {
          const body = wrap.querySelector('#absDetailBody');
          const params = new URLSearchParams({
            className: stuRef.className,
            studentId: stuRef.studentId,
            from: abs.from,
            to: abs.to,
          });
          let d;
          try {
            d = await api(`/api/stats/absences/detail?${params}`);
          } catch (e) {
            body.innerHTML = `<div class="ir-line bad">✗ ${esc(e.message)}</div>`;
            return;
          }
          let sortDesc = true;
          let kw = '';
          const render = () => {
            let recs = d.records.slice();
            if (kw) recs = recs.filter((r) => `${r.courseName}${r.teacher}${r.note}`.includes(kw));
            recs.sort((a, b) => (sortDesc ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date)));
            const totalJie = recs.reduce((n, r) => n + r.jie, 0);
            const absCount = recs.filter((r) => r.status === '缺勤').length;
            const lateCount = recs.length - absCount;
            body.innerHTML = `
              <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
                <div class="small">${esc(d.student.name)}（${esc(d.student.className)}${d.student.grade ? ' / ' + esc(d.student.grade) : ''}）· 区间 ${esc(d.from)} ~ ${esc(d.to)} · 缺勤 <b>${absCount}</b> 条 / 迟到 <b>${lateCount}</b> 条 / 合计 <b>${totalJie}</b> 节（含迟到折算）</div>
                <div style="display:flex;gap:8px;align-items:center">
                  <input class="input input-sm" id="absKw" autocomplete="off" placeholder="筛选课程 / 老师 / 备注" style="width:170px" value="${esc(kw)}" />
                  <button class="btn btn-sm" id="absSort">时间${sortDesc ? '↓ 新→旧' : '↑ 旧→新'}</button>
                </div>
              </div>
              <div class="table-wrap" style="max-height:46vh;overflow-y:auto;border:1px solid var(--border-light);border-radius:8px">
                <table class="table" data-card="t,d,g,a,b,-,m">
                  <thead><tr><th>日期</th><th>状态</th><th>节次</th><th>上课时间段（基准）</th><th>课程名称</th><th>任课老师</th><th>备注</th></tr></thead>
                  <tbody>
                    ${recs.length ? recs.map((r) => `
                      <tr>
                        <td class="num">${esc(r.date)}（${esc(r.weekday)}）</td>
                        <td>${r.status === '迟到' ? `<span class="tag tag-orange">迟到</span><span class="muted small">折 ${r.jie} 节</span>` : `<span class="tag tag-red">缺勤</span><span class="muted small">${r.jie} 节</span>`}</td>
                        <td>${r.periods.map((p) => `<span class="tag tag-purple">${esc(p)}</span>`).join('')}</td>
                        <td class="num small">${r.times.map((t) => `${esc(t.period)} ${esc(t.start)}~${esc(t.end)}`).join('<br/>')}</td>
                        <td>${esc(r.courseName)}</td>
                        <td>${esc(r.teacher) || '<span class="muted">—</span>'}</td>
                        <td class="small" style="max-width:200px">${esc(r.note) || '<span class="muted">—</span>'}</td>
                      </tr>`).join('') : '<tr><td colspan="7" class="table-empty">没有符合条件的缺勤 / 迟到记录</td></tr>'}
                  </tbody>
                </table>
              </div>`;
            body.querySelector('#absSort').onclick = () => {
              sortDesc = !sortDesc;
              render();
            };
            const kwInput = body.querySelector('#absKw');
            kwInput.oninput = (e) => {
              kw = e.target.value.trim();
              render();
              const inp = body.querySelector('#absKw');
              inp.focus();
              inp.setSelectionRange(inp.value.length, inp.value.length);
            };
          };
          render();
        },
      });
    }

    tableWrap.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act="absdetail"]');
      if (btn) absenceDetailModal({ className: btn.dataset.cls, studentId: btn.dataset.sid });
    });

    // 修改44：移动端 as-card 面板的姓名点击同样打开缺勤详情（双渲染双容器委托）
    root.querySelector('#absCardList').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act="absdetail"]');
      if (btn) absenceDetailModal({ className: btn.dataset.cls, studentId: btn.dataset.sid });
    });

    // 修改44：更多筛选折叠开关
    const abMoreBtn = root.querySelector('#abMoreBtn');
    const abMore = root.querySelector('#abMore');
    abMoreBtn.onclick = () => {
      const open = abMore.hidden;
      abMore.hidden = !open;
      abMoreBtn.classList.toggle('open', open);
    };

    function exportAbsence() {
      const d = abs.data;
      if (!d || !d.students.length) return toast('当前没有可导出的缺勤数据', 'error');
      const headers = ['年级', '班级', '学号', '姓名', ...d.buckets.map((b) => b.label), '缺勤节数合计', '缺勤记录次数', '迟到次数', '早/晚自习缺勤次数'];
      const rows = d.students.map((s) => [s.grade, s.className, s.studentId, s.name, ...d.buckets.map((b) => s.byBucket[b.key] ?? 0), s.total, s.sessions, s.lateSessions ?? 0, s.studySessions ?? 0]);
      const filename = `缺勤节数统计_${abs.dimension}_${d.from}_${d.to}.xlsx`;
      apiPostDownload('/api/xlsx/build', { headers, rows, filename }, filename).then(() => toast('已导出 Excel（.xlsx）')).catch((e) => toast(e.message, 'error'));
    }

    function setAbsenceDefaults() {
      const now = new Date();
      const y = now.getFullYear();
      if (abs.dimension === 'week') {
        const mon = mondayOf(today());
        abs.from = mon;
        abs.to = today();
      } else if (abs.dimension === 'month') {
        abs.from = `${y}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
        abs.to = today();
      } else if (abs.dimension === 'year') {
        abs.from = `${y}-01-01`;
        abs.to = today();
      } else {
        abs.from = dstr(-29);
        abs.to = today();
      }
      root.querySelector('#abFrom').value = abs.from;
      root.querySelector('#abTo').value = abs.to;
      // 修改46：手机表单同步默认日期
      const mAbFrom = root.querySelector('#mAbFrom');
      if (mAbFrom) {
        mAbFrom.value = abs.from;
        root.querySelector('#mAbTo').value = abs.to;
      }
    }

    // ==================== 缺勤月报（修改36） ====================
    const MO_HEADERS = ['班级', '学号', '姓名', '本月缺勤节数', '本学期累计已缺勤节数', '本学年累计已缺勤节数', '处分情况'];

    async function loadMonthly() {
      tableWrap.innerHTML = '<div class="table-empty">加载中…</div>';
      pagerEl.innerHTML = '';
      const params = new URLSearchParams({ month: mo.month });
      if (mo.className) params.set('className', mo.className);
      try {
        mo.data = await api(`/api/stats/monthly?${params}`);
      } catch (e) {
        mo.data = null;
        tableWrap.innerHTML = `<div class="table-empty">${esc(e.message)}</div>`;
        return;
      }
      mo.page = 1;
      renderMonthly();
    }

    function renderMonthly() {
      const d = mo.data;
      if (!d) return;
      const rows = d.list || [];
      // 修改44/45：面板标题与徽章；四容器互斥显隐
      const titleEl = root.querySelector('#tableTitle');
      const badgeEl = root.querySelector('#tableBadge');
      if (titleEl) titleEl.textContent = '缺勤月报';
      if (badgeEl) badgeEl.hidden = true;
      const absCardList = root.querySelector('#absCardList');
      if (absCardList) {
        absCardList.hidden = true;
        absCardList.innerHTML = '';
      }
      const clsList = root.querySelector('#clsCardList');
      if (clsList) {
        clsList.hidden = true;
        clsList.innerHTML = '';
      }
      const stuList = root.querySelector('#stuCardList');
      if (stuList) {
        stuList.hidden = true;
        stuList.innerHTML = '';
      }
      const moListEl = root.querySelector('#moCardList');
      root.querySelector('#moRangeHint').innerHTML =
        `${esc(d.month)} 月（${esc(d.monthFrom)} ~ ${esc(d.monthTo)}）· ${esc(d.term.name)}：${esc(d.term.start)} ~ ${esc(d.term.end)} · ${esc(d.schoolYear.label)}：${esc(d.schoolYear.start)} ~ ${esc(d.schoolYear.end)}`;
      infoEl.innerHTML = `本月缺勤学生共 <b>${rows.length}</b> 人 · 每页 ${mo.pageSize} 条`;
      if (!rows.length) {
        tableWrap.innerHTML = '<div class="table-empty">该月没有学生存在缺勤记录</div>';
        pagerEl.innerHTML = '';
        if (moListEl) {
          moListEl.hidden = true;
          moListEl.innerHTML = '';
        }
        return;
      }
      const pageRows = rows.slice((mo.page - 1) * mo.pageSize, mo.page * mo.pageSize);
      // 修改45：月报移动卡片（与表格同页渲染）
      if (moListEl) {
        moListEl.hidden = false;
        moListEl.innerHTML = pageRows
          .map(
            (s) => `
          <div class="su-card">
            <div class="su-head">
              <span class="su-avatar">${esc(String(s.name).slice(0, 1))}</span>
              <div class="su-tx"><b>${esc(s.name)}</b><span>学号：${esc(s.studentId)}</span></div>
              <span class="su-cls">${ICONS.users}${esc(s.className)}</span>
            </div>
            <div class="su-cols">
              <div class="su-col"><span>本月缺勤节数</span><b class="cm-red">${s.monthJie}</b></div>
              <div class="su-col"><span>本学期累计</span><b class="${s.termJie ? 'cm-orange' : ''}">${s.termJie}</b></div>
              <div class="su-col"><span>本学年累计</span><b class="${s.yearJie ? 'cm-orange' : ''}">${s.yearJie}</b></div>
            </div>
            <div class="su-punish">${s.punishment ? `<span class="tag ${punishmentTagCls(s.punishment.levelIndex)}">${esc(s.punishment.level)}</span><span class="muted small">生效中最高处分</span>` : '<span class="muted small">暂无生效中处分</span>'}</div>
          </div>`
          )
          .join('');
      }
      const body = pageRows
        .map(
          (s) => `<tr>
            <td>${esc(s.className)}</td>
            <td class="num">${esc(s.studentId)}</td>
            <td><b>${esc(s.name)}</b></td>
            <td class="num cm-red"><b>${s.monthJie}</b></td>
            <td class="num ${s.termJie ? 'cm-orange' : 'muted'}">${s.termJie}</td>
            <td class="num ${s.yearJie ? 'cm-orange' : 'muted'}">${s.yearJie}</td>
            <td>${s.punishment ? `<span class="tag ${punishmentTagCls(s.punishment.levelIndex)}">${esc(s.punishment.level)}</span>` : '<span class="muted">—</span>'}</td>
          </tr>`
        )
        .join('');
      tableWrap.innerHTML = `<table class="table" data-card="s,a,t,n,m,m,d"><thead><tr>${MO_HEADERS.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
      enhanceTables(tableWrap);
      renderPager(pagerEl, { page: mo.page, pageSize: mo.pageSize, total: rows.length }, (p) => {
        mo.page = p;
        renderMonthly();
      });
    }

    function exportMonthly() {
      const d = mo.data;
      if (!d || !d.list.length) return toast('当前没有可导出的月报数据', 'error');
      const rows = d.list.map((s) => [s.className, s.studentId, s.name, s.monthJie, s.termJie, s.yearJie, s.punishment ? s.punishment.level : '']);
      const filename = `缺勤月报_${d.month}.xlsx`;
      apiPostDownload('/api/xlsx/build', { headers: MO_HEADERS, rows, filename }, filename).then(() => toast('已导出 Excel（.xlsx）')).catch((e) => toast(e.message, 'error'));
    }

    // ==================== 事件绑定 ====================
    const absRulesCard = root.querySelector('#absRulesCard');
    // 修改44/45：按 tab 切换页面模式 class——≤720px 时隐藏桌面表格、显示对应移动卡片面板
    const pageRoot = root.querySelector('.page-stats');
    function applyAbsenceMode(on) {
      applyTabMode(on ? 'absence' : 'class');
    }
    function applyTabMode(tab) {
      const isAbsence = tab === 'absence';
      if (pageRoot) {
        pageRoot.classList.toggle('absence-mode', isAbsence);
        pageRoot.classList.toggle('mode-class', tab === 'class');
        pageRoot.classList.toggle('mode-student', tab === 'student');
        pageRoot.classList.toggle('mode-monthly', tab === 'monthly');
      }
      if (absRulesCard) absRulesCard.style.display = isAbsence ? '' : 'none';
    }
    applyTabMode('class');

    root.querySelectorAll('.tab-btn').forEach((b) => {
      b.onclick = () => {
        root.querySelectorAll('.tab-btn').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        state.tab = b.dataset.tab;
        state.page = 1;
        const isAbsence = state.tab === 'absence';
        const isMonthly = state.tab === 'monthly';
        filterCard.style.display = isAbsence || isMonthly ? 'none' : '';
        absenceCard.style.display = isAbsence ? '' : 'none';
        monthlyCard.style.display = isMonthly ? '' : 'none';
        applyTabMode(state.tab);
        if (isAbsence) {
          setAbsenceDefaults();
          loadAbsence();
        } else if (isMonthly) {
          loadMonthly();
        } else {
          renderStatTable();
        }
      };
    });

    // 修改65：班级筛选升级为可搜索组合框（班级汇总/学生明细桌面+手机）。
    // input 迁移原 id，下方 .value 读取与手机→桌面回写零改动。
    upgradeSelectToCombo(root.querySelector('#clsFilter'));
    upgradeSelectToCombo(root.querySelector('#mClsFilter'));

    // 到课率查询：桌面表单（#btnSearch）与手机表单（#mBtnSearch）共用同一 state
    function applyStatFilter(from, to, className) {
      state.from = from;
      state.to = to;
      state.className = className;
      if (state.from && state.to && state.from > state.to) return toast('开始日期不能晚于结束日期', 'error');
      loadStats();
    }
    root.querySelector('#btnSearch').onclick = () => {
      applyStatFilter(root.querySelector('#from').value, root.querySelector('#to').value, root.querySelector('#clsFilter').value);
    };
    root.querySelector('#mBtnSearch').onclick = () => {
      // 手机端筛选后同步桌面表单值，避免旋转屏幕/切换断点时筛选条件丢失
      const f = root.querySelector('#mFrom');
      const t = root.querySelector('#mTo');
      const c = root.querySelector('#mClsFilter');
      root.querySelector('#from').value = f.value;
      root.querySelector('#to').value = t.value;
      root.querySelector('#clsFilter').value = c.value;
      applyStatFilter(f.value, t.value, c.value);
    };

    // 修改46：桌面表单（#abSearch）与手机表单（#mAbSearch）共用同一 state
    // 手机控件 id = 'm' + 首字母大写（abDim → mAbDim），用映射函数取值，避免前缀拼接错位
    function readAbsForm(mobile) {
      const q = (k) => root.querySelector(mobile ? `#m${k[0].toUpperCase()}${k.slice(1)}` : `#${k}`).value;
      return {
        dimension: q('abDim'),
        from: q('abFrom'),
        to: q('abTo'),
        grade: q('abGrade'),
        className: q('abCls'),
        student: q('abStudent').trim(),
        min: q('abMin'),
        max: q('abMax'),
      };
    }
    function applyAbsFilter(f) {
      abs.dimension = f.dimension;
      abs.from = f.from;
      abs.to = f.to;
      abs.grade = f.grade;
      abs.className = f.className;
      abs.student = f.student;
      abs.min = f.min;
      abs.max = f.max;
      if (abs.dimension === 'custom') {
        if (!abs.from || !abs.to) return toast('自定义区间需填写开始与结束日期', 'error');
        if (abs.from > abs.to) return toast('开始日期不能晚于结束日期', 'error');
      }
      loadAbsence();
    }
    root.querySelector('#abSearch').onclick = () => applyAbsFilter(readAbsForm(false));
    root.querySelector('#mAbSearch').onclick = () => {
      // 手机端筛选后回写桌面表单，跨断点不丢条件
      const f = readAbsForm(true);
      root.querySelector('#abDim').value = f.dimension;
      root.querySelector('#abFrom').value = f.from;
      root.querySelector('#abTo').value = f.to;
      root.querySelector('#abGrade').value = f.grade;
      root.querySelector('#abCls').value = f.className;
      root.querySelector('#abStudent').value = f.student;
      root.querySelector('#abMin').value = f.min;
      root.querySelector('#abMax').value = f.max;
      applyAbsFilter(f);
    };

    // ==================== 修改60：缺勤统计 年级 → 班级 级联筛选 ====================
    // Bug：年级与班级两枚下拉相互独立 —— 选了「2026级」后班级仍列出全部 5 个班，
    // 且可选中不属于该年级的班级（截图所示）。
    // 修改69：本段原先是 stats.js 自持的一份实现（normGradeAbs / gradeOfCls /
    //   syncAbsClsOptions / onAbsGradeChange / onAbsClsChange + 4 个 onchange 绑定），
    //   现已整体抽取为共享模块 public/js/gradeClassCascade.js，由本页与
    //   「班级名单管理」（roster.js）共同调用，消除重复实现。
    // 五条规则见共享模块顶部注释，与原实现逐条等价，**本页行为零变化**：
    //   ① 切年级 → 班级下拉只保留该年级的班级；已选班级不属于该年级时自动清空（含"全部班级"恢复）。
    //   ② 切班级 → 反向回写年级（按 classList 元数据的 grade 字段推导），两栏保持一致。
    //   ③ 未选年级 = 不限制班级（班级列出全部）。
    //   ④ 桌面（abGrade/abCls）与手机（mAbGrade/mAbCls）双向同步，跨断点状态一致。
    //   ⑤ 级联变更后自动刷新查询与统计结果（与 abDim 维度切换即时生效的行为一致）。
    // 注：本段必须位于 root.innerHTML 渲染之后 —— 四枚 select 此时才存在于 DOM 中。
    // 班级选项文案保持修改60 原样「班级名（N人）」（⛔ value 仍为 c.name，不含人数）。
    createGradeClassCascade({
      classList,
      gradeEls: [root.querySelector('#abGrade'), root.querySelector('#mAbGrade')],
      clsEls: [root.querySelector('#abCls'), root.querySelector('#mAbCls')],
      formatClsLabel: (c) => `${c.name}（${c.count}人）`,
      onChange: (g, c) => {
        abs.grade = g;
        abs.className = c;
        loadAbsence(); // 规则⑤：级联变更即时刷新查询与统计结果
      },
    }).sync({ keepValue: false, silent: true }); // 初始化：按空年级渲染一次级联选项（等价于"全部班级"全量列表）；silent 避免原实现没有的多余自动刷新


    // 修改46：维度切换桌面/手机两枚下拉共用；切后默认日期双表单同步
    root.querySelector('#abDim').onchange = () => {
      abs.dimension = root.querySelector('#abDim').value;
      setAbsenceDefaults();
    };
    root.querySelector('#mAbDim').onchange = () => {
      root.querySelector('#abDim').value = root.querySelector('#mAbDim').value;
      abs.dimension = root.querySelector('#abDim').value;
      setAbsenceDefaults();
    };

    // 月报：默认当前月，不能选未来月份
    // 修改59：原生 input[type=month] 换成自绘「年 select + 月 select」。
    //   · #moMonth 现在是包装容器（不再是 input），故 value/max 语义由下面两个 select 承担；
    //   · 「不能选未来月份」从原生 max 改为**选项截断**：选到当前年时月份只列到本月，
    //     选到往年时列全 12 个月 —— 未来月份在 UI 上根本无法选中；
    //   · #moSearch 里那两条 toast 校验原样保留作兜底。
    mo.month = today().slice(0, 7);
    const moMonthEl = root.querySelector('#moMonth');
    const moYearEl = root.querySelector('#moYear');
    const moMonEl = root.querySelector('#moMon');
    const curY = Number(mo.month.slice(0, 4));
    const curM = Number(mo.month.slice(5, 7));
    // 年份范围：当年及前 5 年（够用且不制造超长下拉）
    moYearEl.innerHTML = Array.from({ length: 6 }, (_, i) => curY - i)
      .map((y) => `<option value="${y}">${y}年</option>`).join('');
    // 按所选年份刷新可选月份：当前年截断到本月，往年全年 12 个月
    function fillMoMonths() {
      const y = Number(moYearEl.value);
      const maxM = y === curY ? curM : 12;
      moMonEl.innerHTML = Array.from({ length: maxM }, (_, i) => i + 1)
        .map((m) => `<option value="${String(m).padStart(2, '0')}">${m}月</option>`).join('');
      if (Number(moMonEl.value) > maxM) moMonEl.value = String(maxM).padStart(2, '0');
    }
    moYearEl.value = String(curY);
    fillMoMonths();
    moMonEl.value = mo.month.slice(5, 7);
    moYearEl.onchange = () => {
      fillMoMonths();
      // 年份切换后当前月可能已越界（如从往年切到当年），统一收敛到该年可用月份
      const y = Number(moYearEl.value);
      const maxM = y === curY ? curM : 12;
      if (Number(moMonEl.value) > maxM) moMonEl.value = String(maxM).padStart(2, '0');
    };
    // 唯一取值入口：把两个 select 合成下游契约要求的 YYYY-MM
    const readMoMonth = () => (moYearEl.value && moMonEl.value ? `${moYearEl.value}-${moMonEl.value}` : '');
    // 修改65：月报班级筛选升级为可搜索组合框（升级须在下方 #moSearch 绑定之前）
    upgradeSelectToCombo(root.querySelector('#moCls'));
    root.querySelector('#moSearch').onclick = () => {
      const m = readMoMonth();
      if (!m) return toast('请选择月份', 'error');
      if (m > today().slice(0, 7)) return toast('不能查看未来月份的月报', 'error');
      mo.month = m;
      mo.className = root.querySelector('#moCls').value;
      loadMonthly();
    };
    // 供测试/调试读取当前控件值（与 readMoMonth 同源）
    moMonthEl.value = readMoMonth();

    // 修改46：桌面 #btnExport 与手机 #mBtnExport 共用同一导出逻辑
    const onExport = () => {
      if (state.tab === 'monthly') return exportMonthly();
      if (state.tab === 'absence') {
        const d = abs.data;
        if (!d || !d.students.length) return toast('当前没有可导出的缺勤数据', 'error');
        const headers = ['年级', '班级', '学号', '姓名', ...d.buckets.map((b) => b.label), '缺勤节数合计', '缺勤记录次数', '迟到次数', '早/晚自习缺勤次数'];
        const rows = d.students.map((s) => [s.grade, s.className, s.studentId, s.name, ...d.buckets.map((b) => s.byBucket[b.key] ?? 0), s.total, s.sessions, s.lateSessions ?? 0, s.studySessions ?? 0]);
        const filename = `缺勤节数统计_${abs.dimension}_${d.from}_${d.to}.xlsx`;
        apiPostDownload('/api/xlsx/build', { headers, rows, filename }, filename).then(() => toast('已导出 Excel（.xlsx）')).catch((e) => toast(e.message, 'error'));
        return;
      }
      const rows = rowsForExport();
      if (!rows.length) return toast('当前没有可导出的数据', 'error');
      const headers = state.tab === 'class' ? CLASS_HEADERS : STU_HEADERS;
      const name = state.tab === 'class' ? '班级考勤汇总' : '学生考勤明细';
      const filename = `${name}_${state.from || '开始'}_至_${state.to || '现在'}.xlsx`;
      apiPostDownload('/api/xlsx/build', { headers, rows, filename }, filename).then(() => toast('已导出 Excel（.xlsx）')).catch((e) => toast(e.message, 'error'));
    };
    root.querySelector('#btnExport').onclick = onExport;
    const mBtnExport = root.querySelector('#mBtnExport');
    if (mBtnExport) mBtnExport.onclick = onExport;

    await loadStats();
  },
};
