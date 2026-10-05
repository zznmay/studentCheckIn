import { api } from '../api.js';
import { getUser, hasRole, hasAnyRole } from '../session.js';
import { esc, toast, confirmDialog, renderPager, PERIODS, STATUSES, STATUS_CLS, countMini, periodTags, fmtTime, today, statusTag, ICONS, enhanceTables, upgradeSelectToCombo } from '../ui.js';

// ==================== 公共 ====================
function segCell(item, disabled) {
  return `<div class="seg" data-sid="${esc(item.studentId)}">
    ${STATUSES.map(
      (s) =>
        `<button type="button" class="seg-btn ${item.status === s ? `on sg-${STATUS_CLS[s]}` : ''}" data-v="${s}" ${disabled ? 'disabled' : ''}>${s}</button>`
    ).join('')}
  </div>`;
}

/** 在容器上代理状态按钮点击，更新 items 中对应学生状态并刷新按钮组样式 */
function bindSeg(container, items, onChange) {
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn || btn.disabled) return;
    const seg = btn.closest('.seg');
    const sid = seg.dataset.sid;
    const item = items.find((x) => String(x.studentId) === sid);
    if (!item) return;
    item.status = btn.dataset.v;
    seg.querySelectorAll('.seg-btn').forEach((b) => {
      const on = b.dataset.v === item.status;
      b.className = `seg-btn ${on ? `on sg-${STATUS_CLS[b.dataset.v]}` : ''}`;
    });
    onChange && onChange(item);
  });
}

/** 可发起 / 筛选的班级选项。
 *  mode="launch"（发起点名）：仅账号配置的可点名班级（权益部未配置则为空）。
 *  mode="view"（列表筛选）：权益部等学院级角色返回全部，纪律委员返回其班级。 */
async function myClassOptions(mode = "launch") {
  const user = getUser();
  const { classes } = await api("/api/meta/classes");
  if (hasAnyRole(user, ["admin", "collegeOfficer"])) return classes.map((c) => ({ name: c.name }));
  const mine = (user.classes || []).filter(Boolean);
  if (mode === "view" && hasRole(user, "rights")) return classes.map((c) => ({ name: c.name }));
  return classes.filter((c) => mine.includes(c.name)).map((c) => ({ name: c.name }));
}

// ==================== 点名记录列表 ====================
export const RollcallListView = {
  async mount(root) {
    const user = getUser();
    const isAdmin = hasRole(user, 'admin');
    const state = { className: '', from: '', to: '', q: '', page: 1, pageSize: 20 };
    const classOptions = (await myClassOptions("view")).map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');

    root.innerHTML = `
    <div class="page page-roll">
      <!-- 修改46：桌面层（4.6 原样）页头，操作按钮位于页头内 -->
      <div class="d-layer">
        <div class="page-head">
          <div>
            <h2>考勤点名</h2>
            <p class="page-desc">${hasAnyRole(user, ['admin', 'collegeOfficer', 'rights']) ? '查看全院考勤记录，可发起点名并更正考勤状态' + (hasRole(user, 'admin') ? '，管理员可批量删除点名记录' : '') : hasRole(user, 'discipline') ? '对本班学生发起课堂点名，记录出勤情况' : '查看所带班级的考勤记录'}</p>
          </div>
          <div class="page-actions">
            ${isAdmin ? '<button class="btn btn-danger-plain" id="btnBatchDel" disabled>删除选中</button>' : ''}
            <a class="btn btn-primary" href="#/rollcall/new">${ICONS.plus} 发起点名</a>
          </div>
        </div>
      </div>
      <!-- 手机层页头 + 操作按钮（设计稿样式） -->
      <div class="m-layer">
        <div class="page-head">
          <div>
            <h2>考勤点名</h2>
            <p class="page-desc">${hasAnyRole(user, ['admin', 'collegeOfficer', 'rights']) ? '查看全院考勤记录，可发起点名并更正考勤状态' + (hasRole(user, 'admin') ? '，管理员可批量删除点名记录' : '') : hasRole(user, 'discipline') ? '对本班学生发起课堂点名，记录出勤情况' : '查看所带班级的考勤记录'}</p>
          </div>
        </div>
        <div class="page-actions">
          ${isAdmin ? `<button class="btn btn-danger-plain" id="mBtnBatchDel" disabled>${ICONS.trash}<span id="batchDelTx">删除选中</span></button>` : ''}
          <a class="btn btn-primary" href="#/rollcall/new">${ICONS.plus} 发起点名</a>
        </div>
      </div>
      <div class="card">
        <!-- 修改46：桌面层筛选行（4.6 原样） -->
        <div class="d-layer">
          <div class="toolbar">
            <select class="select" id="clsFilter" style="width:170px"><option value="">全部班级</option>${classOptions}</select>
            <input type="date" class="input" id="from" style="width:145px" />
            <span class="muted small">至</span>
            <input type="date" class="input" id="to" style="width:145px" />
            <input class="input" id="q" placeholder="课程 / 老师 / 发起人" style="width:180px" />
            <button class="btn" id="btnSearch">查询</button>
            <button class="btn" id="btnReset">重置</button>
          </div>
        </div>
        <!-- 手机层筛选（设计稿；控件 m 前缀与桌面区分，共用同一 state） -->
        <div class="m-layer">
          <div class="filter">
            <div class="filter-head">
              <span class="filter-title">${ICONS.funnel}筛选条件</span>
              <button class="filter-reset" id="mBtnReset" type="button">${ICONS.refresh}重置全部</button>
            </div>
            <div class="filter-grid">
              <div class="filter-range">
                <label class="range-item">
                  <span class="range-tag">起</span>
                  <span class="date-field"><input type="date" class="input" id="mFrom" aria-label="开始日期" /><span class="date-ph">年/月/日</span></span>
                </label>
                <span class="filter-sep">至</span>
                <label class="range-item">
                  <span class="range-tag">止</span>
                  <span class="date-field"><input type="date" class="input" id="mTo" aria-label="结束日期" /><span class="date-ph">年/月/日</span></span>
                </label>
              </div>
              <select class="select f-span" id="mClsFilter"><option value="">全部班级</option>${classOptions}</select>
              <div class="search-row">
                <div class="search-field">${ICONS.search}<input class="input" id="mQ" placeholder="课程 / 老师 / 发起人关键字" /></div>
                <button class="btn btn-primary" id="mBtnSearch" type="button">查询</button>
              </div>
            </div>
          </div>
        </div>
        <div class="rk-list" id="rkList"></div>
        <div class="table-wrap">
          <table class="table" data-card="${isAdmin ? 'k,' : ''}t,s,g,b,-,m,m,m,m,x">
            <thead>
              <tr>${isAdmin ? '<th style="width:36px"><input type="checkbox" id="checkAll" /></th>' : ''}<th>日期</th><th>班级</th><th>节次</th><th>课程</th><th>任课老师</th><th>出勤情况</th><th>任课老师确认</th><th>发起人</th><th>最后更新</th><th class="td-actions">操作</th></tr>
            </thead>
            <tbody id="tbody"><tr><td colspan="${isAdmin ? 10 : 9}" class="table-empty">加载中…</td></tr></tbody>
          </table>
        </div>
        <div class="card-foot">
          <div class="table-info">
            <span id="info"></span>
            <span class="muted small" style="margin-left:14px">每页</span>
            <select class="select" id="pageSizeSel" style="width:74px;height:30px">
              <option value="20" selected>20</option>
              <option value="50">50</option>
              <option value="100">100</option>
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
    root.querySelector('#pageSizeSel').onchange = (e) => {
      state.pageSize = Number(e.target.value) || 20;
      state.page = 1;
      load();
    };

    // 管理员批量删除：勾选集合与控件（修改46：桌面/手机两枚按钮共用）
    const selected = new Set();
    const batchBtn = root.querySelector('#btnBatchDel');
    const batchBtnM = root.querySelector('#mBtnBatchDel');
    const batchTx = root.querySelector('#batchDelTx');
    const rkList = root.querySelector('#rkList');
    function syncBatchBtn() {
      for (const b of [batchBtn, batchBtnM]) if (b) b.disabled = selected.size === 0;
      const tx = selected.size ? `删除选中（${selected.size}）` : '删除选中';
      if (batchBtn) batchBtn.textContent = tx; // 桌面（4.6 原样：无内层 span）
      if (batchTx) batchTx.textContent = tx; // 手机（内层 span，保住图标）
    }

    // 任课老师确认：状态标签 + 复制确认链接
    function confirmCell(s) {
      const link = `${location.origin}/#/confirm/${s.confirmToken}`;
      const status = s.confirmStatus === 'confirmed'
        ? `<span class="tag tag-green" title="${esc(s.confirmedName || '')} ${esc((s.confirmedAt || '').replace('T', ' ').slice(0, 16))}">已确认</span>`
        : '<span class="tag tag-orange">待确认</span>';
      return `${status}<button class="btn-text" data-act="copylink" data-token="${esc(s.confirmToken)}">复制链接</button>`;
    }
    async function copyConfirmLink(token) {
      const link = `${location.origin}/#/confirm/${token}`;
      try {
        await navigator.clipboard.writeText(link);
        toast('确认链接已复制，可发送给任课老师（微信等）');
      } catch {
        // 剪贴板不可用（如非 HTTPS 环境）时降级为手动复制
        const input = document.createElement('input');
        input.value = link;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        input.remove();
        toast('确认链接已复制，可发送给任课老师（微信等）');
      }
    }

    // 修改40：移动端设计稿卡片（rk-card）与桌面表格共用同一份数据双渲染；
    // rk-list 仅在 ≤720px 显示（CSS 门控），表格仅 >720px 显示。
    const rkCardHtml = (s) => `
      <div class="rk-card" data-id="${s.id}">
        <div class="rk-head">
          ${isAdmin ? `<input type="checkbox" data-check="${s.id}" aria-label="选中该记录" />` : ''}
          <span class="rk-date">${esc(s.date)}</span>
          <span class="rk-badge">${esc((s.periods || []).join('、'))}</span>
        </div>
        <div class="rk-title">${esc(s.courseName)}</div>
        <div class="rk-meta">
          <span>${ICONS.school}${esc(s.className)}</span>
          ${s.teacher ? `<span>${ICONS.user}${esc(s.teacher)}</span>` : ''}
          <span>${ICONS.user}${esc(s.createdBy)}</span>
        </div>
        <div class="rk-stats">${countMini(s.counts)}</div>
        <div class="rk-foot">
          <div class="rk-foot-l">
            <div class="rk-conf">${confirmCell(s)}</div>
            <div class="rk-upd">更新: ${fmtTime(s.updatedAt)}</div>
          </div>
          <a class="rk-detail" href="#/rollcall/${s.id}">详情${ICONS.chevronR}</a>
        </div>
      </div>`;

    async function load() {
      tbody.innerHTML = `<tr><td colspan="${isAdmin ? 11 : 10}" class="table-empty">加载中…</td></tr>`;
      rkList.innerHTML = '<div class="rk-empty">加载中…</div>';
      const params = new URLSearchParams({ page: state.page, pageSize: state.pageSize });
      if (state.className) params.set('className', state.className);
      if (state.from) params.set('from', state.from);
      if (state.to) params.set('to', state.to);
      if (state.q) params.set('q', state.q);
      const d = await api(`/api/attendance?${params}`);
      infoEl.textContent = `共 ${d.total} 条记录`;
      renderPager(pagerEl, d, (p) => {
        state.page = p;
        load();
      });
      selected.clear();
      const headCheck = root.querySelector('#checkAll');
      if (headCheck) headCheck.checked = false;
      rkList.innerHTML = d.list.length
        ? d.list.map(rkCardHtml).join('')
        : '<div class="rk-empty">暂无点名记录，点击"发起点名"开始</div>';
      tbody.innerHTML = d.list.length
        ? d.list
            .map(
              (s) => `
        <tr data-id="${s.id}">
          ${isAdmin ? `<td><input type="checkbox" data-check="${s.id}" /></td>` : ''}
          <td class="num"><b>${esc(s.date)}</b></td>
          <td>${esc(s.className)}</td>
          <td>${periodTags(s.periods)}</td>
          <td>${esc(s.courseName)}</td>
          <td>${esc(s.teacher) || '<span class="muted">—</span>'}</td>
          <td>${countMini(s.counts)}</td>
          <td>${confirmCell(s)}</td>
          <td>${esc(s.createdBy)}</td>
          <td class="muted small">${fmtTime(s.updatedAt)}</td>
          <td class="td-actions"><a href="#/rollcall/${s.id}">详情</a></td>
        </tr>`
            )
            .join('')
        : `<tr><td colspan="${isAdmin ? 11 : 10}" class="table-empty">暂无点名记录，点击右上角"发起点名"开始</td></tr>`;
      if (isAdmin) {
        enhanceTables(tbody.closest('.table-wrap'));
        syncBatchBtn();
      }
    }

    // 复制确认链接：桌面表格与移动卡片两处委托（修改40 双渲染）
    const onListClick = (e) => {
      const btn = e.target.closest('[data-act="copylink"]');
      if (btn) copyConfirmLink(btn.dataset.token);
    };
    tbody.addEventListener('click', onListClick);
    rkList.addEventListener('click', onListClick);

    if (isAdmin) {
      const headCheck = root.querySelector('#checkAll');
      headCheck.onchange = () => {
        // 全选覆盖桌面表格与移动卡片两份勾选框（同记录双实例，同选状态）
        root.querySelectorAll('input[data-check]').forEach((b) => {
          b.checked = headCheck.checked;
          if (headCheck.checked) selected.add(b.dataset.check);
          else selected.delete(b.dataset.check);
        });
        syncBatchBtn();
      };
      const onListChange = (e) => {
        const b = e.target.closest('input[data-check]');
        if (!b) return;
        if (b.checked) selected.add(b.dataset.check);
        else selected.delete(b.dataset.check);
        syncBatchBtn();
      };
      tbody.addEventListener('change', onListChange);
      rkList.addEventListener('change', onListChange);
      // 修改46：桌面/手机两枚删除按钮共用同一处理器
      const onBatchDel = async () => {
        if (!selected.size) return;
        const ok = await confirmDialog(`确定删除选中的 <b>${selected.size}</b> 条点名记录吗？删除后统计将不再计入。`, { danger: true, title: '批量删除点名记录' });
        if (!ok) return;
        const r = await api('/api/attendance/batch-delete', { method: 'POST', body: { ids: [...selected] } });
        toast(`已删除 ${r.deleted} 条点名记录`);
        load();
      };
      if (batchBtn) batchBtn.onclick = onBatchDel;
      if (batchBtnM) batchBtnM.onclick = onBatchDel;
    }

    // 修改43：日期框空态提示自绘。部分机型（iOS/Safari 等）在窄内边距下不渲染原生
    // 日期占位，文本区被压没只剩右侧箭头；此处用 .date-ph 自绘「年/月/日」兜底，
    // 选中日期后隐藏。Gecko（Firefox）原生占位正常，不注入避免重复文字。
    const dateInputs = [...root.querySelectorAll('.filter-range input[type="date"]')];
    const gecko = /firefox|fxios/i.test(navigator.userAgent || '');
    const syncDatePh = (el) => {
      const box = el.closest('.date-field');
      if (!box || gecko) return;
      box.classList.toggle('is-empty', !el.value);
    };
    dateInputs.forEach((el) => {
      el.addEventListener('input', () => syncDatePh(el));
      el.addEventListener('change', () => syncDatePh(el));
      syncDatePh(el);
    });

    // 修改63：班级筛选升级为可搜索组合框（参照设计稿）。
    // input 迁移原 id，#clsFilter/#mClsFilter 的 .value 读写、查询/重置/手机回写桌面零改动。
    upgradeSelectToCombo(root.querySelector('#clsFilter'));
    upgradeSelectToCombo(root.querySelector('#mClsFilter'));

    // 修改46：桌面表单（#btnSearch）与手机表单（#mBtnSearch）共用同一 state
    function applyRollFilter(className, from, to, q) {
      state.className = className;
      state.from = from;
      state.to = to;
      state.q = q;
      state.page = 1;
      load();
    }
    root.querySelector('#btnSearch').onclick = () => {
      applyRollFilter(
        root.querySelector('#clsFilter').value,
        root.querySelector('#from').value,
        root.querySelector('#to').value,
        root.querySelector('#q').value.trim()
      );
    };
    root.querySelector('#mBtnSearch').onclick = () => {
      // 手机端筛选后回写桌面表单，跨断点不丢条件
      const cls = root.querySelector('#mClsFilter').value;
      const from = root.querySelector('#mFrom').value;
      const to = root.querySelector('#mTo').value;
      const q = root.querySelector('#mQ').value.trim();
      root.querySelector('#clsFilter').value = cls;
      root.querySelector('#from').value = from;
      root.querySelector('#to').value = to;
      root.querySelector('#q').value = q;
      applyRollFilter(cls, from, to, q);
    };
    // 重置：两套表单一起清空（桌面/手机按钮共用）
    const onRollReset = () => {
      root.querySelector('#clsFilter').value = '';
      root.querySelector('#from').value = '';
      root.querySelector('#to').value = '';
      root.querySelector('#q').value = '';
      root.querySelector('#mClsFilter').value = '';
      root.querySelector('#mFrom').value = '';
      root.querySelector('#mTo').value = '';
      root.querySelector('#mQ').value = '';
      // 程序性清空不会触发 input/change，需主动同步空态提示
      dateInputs.forEach((el) => syncDatePh(el));
      applyRollFilter('', '', '', '');
    };
    root.querySelector('#btnReset').onclick = onRollReset;
    root.querySelector('#mBtnReset').onclick = onRollReset;
    const onRollSearchKey = (e) => {
      if (e.key === 'Enter') root.querySelector('#btnSearch').click();
    };
    root.querySelector('#q').addEventListener('keydown', onRollSearchKey);
    root.querySelector('#mQ').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') root.querySelector('#mBtnSearch').click();
    });

    await load();
  },
};

// ==================== 发起点名 ====================
export const RollcallNewView = {
  async mount(root) {
    const user = getUser();
    const classes = await myClassOptions();
    const items = []; // {studentId, name, status, note}
    const form = { className: '', date: today(), periods: [], courseName: '', teacher: '' };

    if (hasRole(user, 'discipline') && !hasAnyRole(user, ['admin', 'rights', 'collegeOfficer']) && !classes.length) {
      root.innerHTML = `<div class="page"><div class="card empty-card">暂无可点名的班级，请联系管理员在"账号管理"中为你的账号分配班级权限。</div></div>`;
      return;
    }

    root.innerHTML = `
    <div class="page">
      <!-- 修改50：手机层页头（桌面页头在 .d-layer 内保持 4.6 原样） -->
      <div class="m-layer rn-head">
        <h2>发起点名</h2>
        <p>选择日期与节次，逐个标记学生出勤状态后保存</p>
      </div>
      <div class="d-layer">
        <div class="page-head">
          <div>
            <h2>发起点名</h2>
            <p class="page-desc">选择日期与节次，逐个标记学生出勤状态后保存</p>
          </div>
          <div class="page-actions"><a class="btn" href="#/rollcall">${ICONS.back} 返回列表</a></div>
        </div>
      </div>
      <!-- 点名信息：桌面/手机共用同一表单节点（表单是状态源，不可双实例，避免两套控件同步问题） -->
      <div class="card">
        <div class="card-title">点名信息</div>
        <div class="form">
          <div class="form-row">
            <div class="form-item"><label>班级<span class="req">*</span></label>
              <select class="select" id="rcClass"><option value="">请选择班级</option>${classes.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('')}</select></div>
            <div class="form-item"><label>上课日期<span class="req">*</span></label>
              <input type="date" class="input" id="rcDate" value="${form.date}" /></div>
          </div>
          <div class="form-item"><label>节次（可多选）<span class="req">*</span></label>
            <div class="check-list" id="rcPeriods">
              ${PERIODS.map((p) => `<label><input type="checkbox" value="${p}" ${form.periods.includes(p) ? 'checked' : ''}/>${p}</label>`).join('')}
            </div></div>
          <div class="form-row">
            <div class="form-item"><label>课程名称<span class="req">*</span></label>
              <input class="input" id="rcCourse" placeholder="如：高等数学" /></div>
            <div class="form-item"><label>任课老师</label>
              <input class="input" id="rcTeacher" placeholder="选填" /></div>
          </div>
        </div>
      </div>
      <div class="hint-box mt14">假单自动校验：已被已通过假单覆盖的学生，点名时自动预标记为"请假"并备注事由（切换日期 / 节次按假单重新预填，手动标记保留）；保存点名后系统按假单复核——未被假单覆盖的"请假"立即改判"缺勤"，覆盖的"缺勤"自动改为"请假"。</div>
      <div class="d-layer">
        <div class="card" id="stuCard" style="display:none">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:10px">
            <div class="card-title" style="margin:0">学生考勤（<span id="stuCount" class="muted">0</span> 人）</div>
            <div style="display:flex;gap:8px">
              <button class="btn btn-sm" id="btnAllOn">全部出勤</button>
              <button class="btn btn-sm" id="btnAllOff">全部缺勤</button>
            </div>
          </div>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th style="width:60px">#</th><th>学号</th><th>姓名</th><th>考勤状态</th><th>备注</th></tr></thead>
              <tbody id="stuBody"></tbody>
            </table>
          </div>
        </div>
        <div class="mt14" style="display:flex;justify-content:flex-end;gap:10px">
          <button class="btn btn-primary" id="btnSave" style="width:160px;height:40px">保存点名记录</button>
        </div>
      </div>

      <!-- 修改50：手机层学生考勤（设计图行卡组件；与点名详情页共用 rd-* 组件） -->
      <div class="m-layer rd-root">
        <div class="rd-tools" id="mRnTools" style="display:none">
          <div class="rd-search">${ICONS.search}<input class="input" id="mRnQ" autocomplete="off" placeholder="搜索姓名或学号" /></div>
          <select class="select" id="mRnStatus">
            <option value="">全部状态</option>
            ${STATUSES.map((st) => `<option value="${esc(st)}">${esc(st)}</option>`).join('')}
          </select>
        </div>
        <div class="rd-sec" id="mStuCard" style="display:none">
          <div class="rd-label-row">${ICONS.users}<span>学生考勤（<span id="mStuCount">0</span> 人）</span></div>
          <div class="rd-list" id="mStuList"></div>
        </div>
      </div>

      <!-- 修改51：底部吸附操作栏 + 「原地融化」形变面板。
           面板是底栏的绝对定位子元素（bottom:100%），随 sticky 底栏始终贴在屏幕底部；
           遮罩同法锚定（bottom:100%; height:100vh），覆盖当前可视区且**不遮挡底栏按钮**。 -->
      <div class="rd-bar" id="mRnBar" style="display:none">
        <div class="rd-scrim" data-morph-close></div>
        <div class="rd-morph" id="mRnPanel">
          <div class="rd-morph-hd"><b>批量操作</b><span class="rd-morph-tip" id="mRnTip">将应用到全部学生</span></div>
          <div class="rd-morph-grid">
            ${STATUSES.map((st) => `<button type="button" class="btn rd-morph-op st-${STATUS_CLS[st]}" data-batch="${esc(st)}">全部${esc(st)}</button>`).join('')}
          </div>
          <button type="button" class="btn rd-morph-danger" data-batch="__clear">清空全部备注</button>
          <button type="button" class="btn rd-morph-cancel" data-morph-close>取消</button>
        </div>
        <button class="btn rd-bar-batch" id="mBtnBatch" type="button">${ICONS.gear}<span>批量操作</span></button>
        <button class="btn btn-primary rd-bar-save" id="mBtnSave" type="button">${ICONS.save}<span>保存点名记录</span></button>
      </div>
    </div>`;

    const stuCard = root.querySelector('#stuCard');
    const stuBody = root.querySelector('#stuBody');
    const stuCount = root.querySelector('#stuCount');
    // 修改50：手机层节点（学生考勤行卡 / 工具栏 / 底部操作栏）
    const mStuCard = root.querySelector('#mStuCard');
    const mStuList = root.querySelector('#mStuList');
    const mStuCount = root.querySelector('#mStuCount');
    const mRnTools = root.querySelector('#mRnTools');
    const mRnQ = root.querySelector('#mRnQ');
    const mRnStatus = root.querySelector('#mRnStatus');
    const mRnBar = root.querySelector('#mRnBar');

    // 修改50：手机层名单（搜索 / 状态筛选为客户端过滤；名次沿用原始序，不因筛选重排）
    function renderMobileList() {
      if (!mStuList) return;
      const kw = String((mRnQ && mRnQ.value) || '').trim();
      const st = String((mRnStatus && mRnStatus.value) || '');
      const rows = items.filter(
        (it) => (!kw || String(it.name).includes(kw) || String(it.studentId).includes(kw)) && (!st || it.status === st)
      );
      mStuCount.textContent = items.length;
      mStuList.innerHTML = rows.length
        ? rows.map((it) => rdRowHtml(it, items.indexOf(it), true)).join('')
        : '<div class="rd-empty">没有符合条件的学生</div>';
    }

    function renderStudents() {
      stuCount.textContent = items.length;
      stuBody.innerHTML = items.length
        ? items
            .map(
              (it, i) => `
        <tr>
          <td class="muted num">${i + 1}</td>
          <td class="num">${esc(it.studentId)}</td>
          <td><b>${esc(it.name)}</b></td>
          <td>${segCell(it, false)}</td>
          <td><input class="input input-sm note-input" data-note="${esc(it.studentId)}" value="${esc(it.note)}" placeholder="备注（如请假事由）" /></td>
        </tr>`
            )
            .join('')
        : '<tr><td colspan="5" class="table-empty">请先选择班级加载学生名单</td></tr>';
      renderMobileList(); // 修改50：同一 items 双渲染（桌面表格 + 手机行卡）
    }

    const overrides = new Map(); // 手动改动记录：换日期 / 节次重新预填时予以保留

    async function loadRoster() {
      items.length = 0;
      if (!form.className) {
        stuCard.style.display = 'none';
        if (mStuCard) mStuCard.style.display = 'none';
        if (mRnTools) mRnTools.style.display = 'none';
        if (mRnBar) mRnBar.style.display = 'none';
        return;
      }
      stuCard.style.display = '';
      if (mStuCard) mStuCard.style.display = '';
      if (mRnTools) mRnTools.style.display = '';
      if (mRnBar) mRnBar.style.display = '';
      stuBody.innerHTML = '<tr><td colspan="5" class="table-empty">正在加载名单…</td></tr>';
      if (mStuList) mStuList.innerHTML = '<div class="rd-empty">正在加载名单…</div>';
      try {
        const params = new URLSearchParams({ className: form.className, date: form.date || '', periods: form.periods.join(',') });
        const d = await api(`/api/attendance/roster?${params}`);
        items.push(
          ...d.students.map((s) =>
            s.leaveCovered
              ? { studentId: s.studentId, name: s.name, status: '请假', note: s.leaveNote }
              : { studentId: s.studentId, name: s.name, status: '出勤', note: '' }
          )
        );
      } catch (e) {
        stuBody.innerHTML = `<tr><td colspan="5" class="table-empty">${esc(e.message)}</td></tr>`;
        return;
      }
      // 保留用户手动标记过的状态 / 备注
      for (const it of items) {
        const ov = overrides.get(it.studentId);
        if (!ov) continue;
        if (ov.status) it.status = ov.status;
        if (ov.note !== undefined) it.note = ov.note;
      }
      renderStudents();
    }

    const onSegChange = (item) => overrides.set(item.studentId, { ...overrides.get(item.studentId), status: item.status });
    bindSeg(stuBody, items, onSegChange);
    // 修改50：手机层名单复用 bindSeg（与桌面表格共用同一 items）；改动后同步重渲染两层
    if (mStuList) bindSeg(mStuList, items, (item) => { onSegChange(item); renderStudents(); });
    const onNoteInput = (e) => {
      const input = e.target.closest('input[data-note]');
      if (!input) return;
      const item = items.find((x) => x.studentId === input.dataset.note);
      if (item) {
        item.note = input.value;
        overrides.set(item.studentId, { ...overrides.get(item.studentId), note: item.note });
      }
    };
    stuBody.addEventListener('input', onNoteInput);
    if (mStuList) mStuList.addEventListener('input', onNoteInput);
    // 修改50：手机层搜索 / 状态筛选
    if (mRnQ) mRnQ.addEventListener('input', renderMobileList);
    if (mRnStatus) mRnStatus.addEventListener('change', renderMobileList);

    // 修改63：班级选择升级为可搜索组合框（参照设计稿）。升级须在下方 onchange 绑定之前，
    // 保证 change 监听挂在升级后的 input（id 不变）上——form.className 读值与 loadRoster 联动零改动。
    upgradeSelectToCombo(root.querySelector('#rcClass'));
    root.querySelector('#rcClass').onchange = (e) => {
      form.className = e.target.value;
      overrides.clear();
      loadRoster();
    };
    root.querySelector('#rcDate').onchange = (e) => {
      form.date = e.target.value;
      if (form.className) loadRoster();
    };
    root.querySelector('#rcPeriods').addEventListener('change', () => {
      form.periods = [...root.querySelectorAll('#rcPeriods input:checked')].map((x) => x.value);
      if (form.className) loadRoster();
    });
    root.querySelector('#rcCourse').oninput = (e) => (form.courseName = e.target.value);
    root.querySelector('#rcTeacher').oninput = (e) => (form.teacher = e.target.value);

    root.querySelector('#btnAllOn').onclick = () => {
      items.forEach((it) => (it.status = '出勤'));
      renderStudents();
    };
    root.querySelector('#btnAllOff').onclick = () => {
      items.forEach((it) => (it.status = '缺勤'));
      renderStudents();
    };

    // 修改50：保存逻辑桌面/手机共用（行为等价）
    const saveRollcall = async () => {
      if (!form.className) return toast('请选择班级', 'error');
      if (!form.date) return toast('请选择上课日期', 'error');
      if (!form.periods.length) return toast('请至少选择一个节次', 'error');
      if (!form.courseName.trim()) return toast('请输入课程名称', 'error');
      if (!items.length) return toast('该班级暂无学生名单', 'error');
      try {
        const d = await api('/api/attendance', {
          method: 'POST',
          body: { ...form, courseName: form.courseName.trim(), items: items.map(({ studentId, status, note }) => ({ studentId, status, note })) },
        });
        toast('点名记录已保存');
        location.hash = `#/rollcall/${d.session.id}`;
      } catch (e) {
        if (e.status === 409 && e.data?.existingId) {
          const ok = await confirmDialog(`${esc(e.message)}，是否前往查看该记录？`, { title: '记录已存在' });
          if (ok) location.hash = `#/rollcall/${e.data.existingId}`;
        } else {
          toast(e.message, 'error');
        }
      }
    };
    root.querySelector('#btnSave').onclick = saveRollcall;
    const mBtnSave = root.querySelector('#mBtnSave');
    if (mBtnSave) mBtnSave.onclick = saveRollcall;

    // 修改51：手机层批量操作——按钮原地融化形变为面板（替代桌面「全部出勤 / 全部缺勤」行内按钮）
    const mRnMorph = bindMorphPanel(root, {
      btnSel: '#mBtnBatch',
      panelSel: '#mRnPanel',
      tipSel: '#mRnTip',
      onOpen: () => {
        const t = root.querySelector('#mRnTip');
        if (t) t.textContent = `将应用到全部 ${items.length} 名学生`;
      },
      onBatch: (v) => {
        if (!items.length) return toast('请先选择班级加载学生名单', 'error');
        if (v === '__clear') {
          items.forEach((it) => {
            it.note = '';
            overrides.set(it.studentId, { ...overrides.get(it.studentId), note: '' });
          });
        } else {
          items.forEach((it) => {
            it.status = v;
            overrides.set(it.studentId, { ...overrides.get(it.studentId), status: v });
          });
        }
        renderStudents();
        toast(v === '__clear' ? '已清空全部备注' : `已将全部 ${items.length} 名学生设为「${v}」`);
      },
    });

    renderStudents();
  },
};

/** 修改49/50：手机层学生行（设计图组件）——排名 + 圆形头像 + 姓名/学号 + 四态分段控件；次行备注输入 + 编辑图标。
 *  点名详情（只读时用状态标签）与发起点名（始终可编辑）共用同一行组件，保证模块内视觉一致。 */
function rdRowHtml(it, idx, editable) {
  return `
      <div class="rd-item" data-sid="${esc(it.studentId)}">
        <div class="rd-row1">
          <span class="rd-rank">#${idx + 1}</span>
          <span class="rd-ava">${ICONS.user}</span>
          <span class="rd-tx"><b>${esc(it.name)}</b><i>学号 ${esc(it.studentId)}</i></span>
          <span class="rd-seg">${editable ? segCell(it, false) : statusTag(it.status)}</span>
        </div>
        <div class="rd-note">
          ${
            editable
              ? `<input class="input input-sm" data-note="${esc(it.studentId)}" value="${esc(it.note)}" placeholder="备注.." />${ICONS.pencil}`
              : `<span class="small">${esc(it.note) || '—'}</span>`
          }
        </div>
      </div>`;
}

/** 修改51：批量操作按钮 → 面板「原地融化」形变（点名详情与发起点名共用）。
 *  布局衔接：面板锚定在 sticky 底栏上方（position:absolute; bottom:100%），随底栏**始终贴在屏幕底部**。
 *  ⚠️ 不用 position:fixed —— 滚动容器 main.content.view-enter 带 transform 会成为 fixed 的包含块，
 *  面板会被钉在内容里、跟着页面滚走（这正是修改49/50 弹层「点开后在页面中间、一滚就没了」的根因）。
 *  形变：clip-path 从按钮矩形（999px 胶囊圆角）插值到面板矩形（18px 圆角），内容交叉淡入；
 *  收起：镜像更快，动画结束后才真正隐藏（visibility），焦点归还触发按钮；支持 Esc / 点遮罩 / 点面板外关闭。 */
function bindMorphPanel(root, { btnSel, panelSel, tipSel, onOpen, onBatch }) {
  const btn = root.querySelector(btnSel);
  const bar = btn && btn.closest('.rd-bar');
  const panel = root.querySelector(panelSel);
  if (!btn || !panel || !bar) return null;
  let isOpen = false;

  const setTip = (t) => {
    const el = tipSel && root.querySelector(tipSel);
    if (el) el.textContent = t;
  };
  const open = () => {
    if (isOpen) return;
    isOpen = true;
    // 以按钮当前矩形作为形变起点（clip-path 初态），使「长出」的原点与按钮完全吻合
    const r = btn.getBoundingClientRect();
    panel.style.setProperty('--morph-w', Math.round(r.width) + 'px');
    panel.style.setProperty('--morph-h', Math.round(r.height) + 'px');
    if (onOpen) onOpen();
    bar.classList.add('morph-open');
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('click', onDocClick, true);
    const first = panel.querySelector('button');
    if (first) first.focus({ preventScroll: true });
  };
  const close = () => {
    if (!isOpen) return;
    isOpen = false;
    bar.classList.remove('morph-open');
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('click', onDocClick, true);
    // 隐藏交给 CSS：.rd-morph 的 visibility 过渡带 260ms 延迟，动画播完才真正隐藏
    btn.focus({ preventScroll: true }); // 焦点归还触发按钮（键盘 / 读屏用户不丢位置）
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  const onDocClick = (e) => {
    if (panel.contains(e.target) || btn.contains(e.target)) return;
    close();
  };

  btn.onclick = () => (isOpen ? close() : open());
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', panel.id);
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-label', '批量操作');
  root.querySelectorAll('[data-morph-close]').forEach((el) => (el.onclick = close));
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('[data-batch]');
    if (!b) return;
    const v = b.dataset.batch;
    close(); // 先收起再执行（收起 ≠ 撤销，操作结果用 toast 反馈）
    onBatch && onBatch(v);
  });
  return { open, close, setTip, isOpen: () => isOpen };
}

// ==================== 点名详情（纪律委员只读；权益部 / 管理员可修改考勤状态） ====================
/** 修改49：日期 → 星期（设计图「2026-09-30（周三）」，ui.js 无此工具，故本页局部实现） */
function weekdayCn(dateStr) {
  const d = new Date(String(dateStr || '') + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return '';
  return '周' + '日一二三四五六'[d.getDay()];
}

export const RollcallDetailView = {
  async mount(root, params) {
    const user = getUser();
    root.innerHTML = '<div class="page"><div class="card empty-card">加载中…</div></div>';
    const { session: s } = await api(`/api/attendance/${params.id}`);
    // 纯纪律委员为只读；兼任权益部/管理员/学院考勤负责老师时可更正（与后端合并权限逻辑一致）
    const canEdit = hasAnyRole(user, ['admin', 'rights', 'collegeOfficer']) || !hasRole(user, 'discipline');
    const items = s.items.map((it) => ({ ...it }));
    // 修改49：手机层用的节次文本与四态计数（设计图「7-8节」pill + 出勤/迟到/缺勤/请假 四列统计）
    const periodTx = (s.periods || []).join('、');
    const counts = s.counts || {};

    const rdRow = (it, idx) => rdRowHtml(it, idx, canEdit);

    root.innerHTML = `
    <div class="page">
      <div class="d-layer">
      <div class="page-head">
        <div>
          <div><button class="back-link" id="btnBack">${ICONS.back} 返回列表</button></div>
          <h2 style="margin-top:8px">点名详情</h2>
          <p class="page-desc">${
            canEdit
              ? '权益部 / 管理员可单独修改学生考勤状态；保存后系统按假单自动复核（未覆盖的"请假"改判"缺勤"）'
              : '纪律委员提交点名后记录锁定为只读，仅支持查看；考勤状态更正由权益部 / 管理员或假单导入完成'
          }</p>
        </div>
        <div class="page-actions">
          ${canEdit ? '<button class="btn btn-primary" id="btnSave">保存修改</button>' : '<span class="tag tag-gray">已锁定 · 仅查看</span>'}
        </div>
      </div>
      <div class="card">
        <div class="info-grid">
          <div class="info-item"><div class="ii-label">班级</div><div class="ii-value">${esc(s.className)}</div></div>
          <div class="info-item"><div class="ii-label">上课日期</div><div class="ii-value">${esc(s.date)}</div></div>
          <div class="info-item"><div class="ii-label">节次</div><div class="ii-value">${periodTags(s.periods)}</div></div>
          <div class="info-item"><div class="ii-label">课程名称</div><div class="ii-value">${esc(s.courseName)}</div></div>
          <div class="info-item"><div class="ii-label">任课老师</div><div class="ii-value">${esc(s.teacher) || '—'}</div></div>
          <div class="info-item"><div class="ii-label">发起人</div><div class="ii-value">${esc(s.createdBy)}</div></div>
          <div class="info-item"><div class="ii-label">最后修改</div><div class="ii-value">${esc(s.updatedBy)} · ${fmtTime(s.updatedAt)}</div></div>
          <div class="info-item"><div class="ii-label">出勤情况</div><div class="ii-value">${countMini(s.counts)}</div></div>
        </div>
      </div>
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
          <div>
            <div class="card-title" style="margin-bottom:4px">任课老师确认</div>
            ${
              s.confirmStatus === 'confirmed'
                ? `<div class="small text-ok">✓ 已确认 · ${esc(s.confirmedName || '')} · ${esc((s.confirmedAt || '').replace('T', ' ').slice(0, 16))}</div>`
                : '<div class="small muted">待任课老师通过确认链接签字确认</div>'
            }
          </div>
          <button class="btn btn-sm" id="btnCopyLink">复制确认链接（发给任课老师）</button>
        </div>
        ${s.confirmStatus === 'confirmed' && s.signature ? `<div class="mt14"><img class="sig-img" src="${s.signature}" alt="任课老师手写签名" style="width:280px" /></div>` : ''}
        <div class="muted small mt14">将确认链接发送给任课老师（微信等），老师打开链接核对记录并手写签名确认（老师只需签字一次，记录后续修改不影响确认有效性）。</div>
      </div>
      <div class="card">
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th style="width:60px">#</th><th>学号</th><th>姓名</th><th>考勤状态</th><th>备注</th></tr></thead>
            <tbody id="stuBody">
              ${items
                .map(
                  (it, i) => `
              <tr>
                <td class="muted num">${i + 1}</td>
                <td class="num">${esc(it.studentId)}</td>
                <td><b>${esc(it.name)}</b></td>
                <td>${canEdit ? segCell(it, false) : statusTag(it.status)}</td>
                <td>${
                  canEdit
                    ? `<input class="input input-sm note-input" data-note="${esc(it.studentId)}" value="${esc(it.note)}" placeholder="备注" />`
                    : `<span class="small">${esc(it.note) || '—'}</span>`
                }</td>
              </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
      </div>

      <!-- 修改49：手机层（≤720px；设计图：上=概览区 hero/课程信息/四列统计/任课老师确认，下=学生考勤名单） -->
      <div class="m-layer rd-root">
        <div class="rd-back"><button class="back-link" id="mBtnBack">${ICONS.back} 返回列表</button></div>

        <section class="rd-hero" id="mRdStats">
          <div class="rd-hero-tx">
            <h2>点名详情</h2>
            <p>${
              canEdit
                ? '可修改学生考勤状态，保存后系统将自动同步并更新学生请假/缺勤记录。'
                : '该记录已锁定为只读，仅支持查看；考勤状态更正由权益部 / 管理员或假单导入完成。'
            }</p>
          </div>
          <div class="rd-illo" aria-hidden="true">
            <span class="rd-illo-cal">${ICONS.calendar}</span>
            <span class="rd-illo-ok">${ICONS.check}</span>
          </div>
        </section>

        <section class="card rd-info">
          <div class="rd-course">
            <b>${esc(s.courseName)}</b>
            <span class="rd-period">${esc(periodTx)}</span>
          </div>
          <div class="rd-rows">
            <div class="rd-r"><span class="rd-ri">${ICONS.school}</span><span class="rd-rl">班级</span><span class="rd-rv">${esc(s.className)}</span></div>
            <div class="rd-r"><span class="rd-ri">${ICONS.calendar}</span><span class="rd-rl">上课日期</span><span class="rd-rv">${esc(s.date)}${weekdayCn(s.date) ? `（${weekdayCn(s.date)}）` : ''}</span></div>
            <div class="rd-r"><span class="rd-ri">${ICONS.user}</span><span class="rd-rl">任课老师</span><span class="rd-rv">${esc(s.teacher) || '—'}</span></div>
            <div class="rd-r"><span class="rd-ri">${ICONS.user}</span><span class="rd-rl">发起人</span><span class="rd-rv">${esc(s.createdBy)}</span></div>
            <div class="rd-r"><span class="rd-ri">${ICONS.clock}</span><span class="rd-rl">最后修改</span><span class="rd-rv">${esc(s.updatedBy)} · ${fmtTime(s.updatedAt)}</span></div>
          </div>
        </section>

        <section class="card rd-stat">
          ${STATUSES.map(
            (st) => `<div class="rd-sc st-${STATUS_CLS[st]}"><span class="rd-sci">${ICONS[st === '出勤' ? 'check' : st === '迟到' ? 'clock' : st === '缺勤' ? 'alert' : 'file']}</span><b>${counts[st] ?? 0}</b><span class="rd-scl">${st}</span></div>`
          ).join('')}
        </section>

        <section class="card rd-confirm">
          <div class="card-title" style="margin-bottom:6px">任课老师确认</div>
          ${
            s.confirmStatus === 'confirmed'
              ? `<div class="rd-ok">${ICONS.checkC}<span>已确认 · ${esc(s.confirmedName || '')} · ${esc((s.confirmedAt || '').replace('T', ' ').slice(0, 16))}</span></div>`
              : `<div class="small muted">待任课老师通过确认链接签字确认</div>`
          }
          <button class="btn rd-copy" id="mBtnCopyLink">${ICONS.link}<span>复制确认链接（发送给任课老师）</span></button>
          ${
            s.confirmStatus === 'confirmed' && s.signature
              ? `<div class="rd-sig"><img class="sig-img" src="${s.signature}" alt="任课老师手写签名" /><p>将确认链接发送给任课老师（微信等），老师打开链接核对记录并手写签名确认（老师只需签字一次，记录后续修改不影响确认有效性）。</p></div>`
              : `<p class="muted small rd-tip">将确认链接发送给任课老师（微信等），老师打开链接核对记录并手写签名确认（老师只需签字一次，记录后续修改不影响确认有效性）。</p>`
          }
        </section>

        <div class="rd-tabs" id="mRdTabs">
          <button type="button" class="rd-tab on" data-jump="list">学生考勤（<span id="mRdCount">0</span>）</button>
          <button type="button" class="rd-tab" data-jump="stats">统计概览</button>
        </div>

        <div class="rd-tools">
          <div class="rd-search">${ICONS.search}<input class="input" id="mRdQ" autocomplete="off" placeholder="搜索姓名或学号" /></div>
          <select class="select" id="mRdStatus">
            <option value="">全部状态</option>
            ${STATUSES.map((st) => `<option value="${esc(st)}">${esc(st)}</option>`).join('')}
          </select>
        </div>

        <div class="rd-list" id="mRdList"></div>
      </div>

      ${
        canEdit
          ? `<div class="rd-bar" id="mRdvBar"><div class="rd-scrim" data-morph-close></div>
             <div class="rd-morph" id="mRdPanel">
               <div class="rd-morph-hd"><b>批量操作</b><span class="rd-morph-tip" id="mRdTip">将应用到全部 ${items.length} 名学生</span></div>
               <div class="rd-morph-grid">
                 ${STATUSES.map((st) => `<button type="button" class="btn rd-morph-op st-${STATUS_CLS[st]}" data-batch="${esc(st)}">全部${esc(st)}</button>`).join('')}
               </div>
               <button type="button" class="btn rd-morph-danger" data-batch="__clear">清空全部备注</button>
               <button type="button" class="btn rd-morph-cancel" data-morph-close>取消</button>
             </div>
             <button class="btn rd-bar-batch" id="mBtnBatch" type="button">${ICONS.gear}<span>批量操作</span></button>
             <button class="btn btn-primary rd-bar-save" id="mBtnSave" type="button">${ICONS.save}<span>保存修改</span></button></div>`
          : ''
      }
    </div>`;

    root.querySelector('#btnBack').onclick = () => (location.hash = '#/rollcall');

    // 修改49：保存逻辑桌面/手机共用同一函数（行为等价）
    const doSave = async (btn) => {
      btn.disabled = true;
      try {
        await api(`/api/attendance/${s.id}`, {
          method: 'PUT',
          body: { items: items.map(({ studentId, status, note }) => ({ studentId, status, note })) },
        });
        toast('考勤状态已更新');
        RollcallDetailView.mount(root, params);
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
    };
    const copyLink = async () => {
      const link = `${location.origin}/#/confirm/${s.confirmToken}`;
      try {
        await navigator.clipboard.writeText(link);
        toast('确认链接已复制，可发送给任课老师（微信等）');
      } catch {
        const input = document.createElement('input');
        input.value = link;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        input.remove();
        toast('确认链接已复制，可发送给任课老师（微信等）');
      }
    };
    root.querySelector('#btnCopyLink').onclick = copyLink;

    // ---------- 修改49：手机层（.m-layer）交互 ----------
    const mBack = root.querySelector('#mBtnBack');
    if (mBack) mBack.onclick = () => (location.hash = '#/rollcall');
    const mCopy = root.querySelector('#mBtnCopyLink');
    if (mCopy) mCopy.onclick = copyLink;
    const mList = root.querySelector('#mRdList');
    const mQ = root.querySelector('#mRdQ');
    const mStatus = root.querySelector('#mRdStatus');
    const mCount = root.querySelector('#mRdCount');
    // 名单渲染（搜索 / 状态筛选为设计图功能，客户端过滤；名次沿用原始序，筛选后不重排）
    const renderRdList = () => {
      if (!mList) return;
      const kw = String((mQ && mQ.value) || '').trim();
      const st = String((mStatus && mStatus.value) || '');
      const rows = items.filter(
        (it) => (!kw || String(it.name).includes(kw) || String(it.studentId).includes(kw)) && (!st || it.status === st)
      );
      mCount.textContent = items.length;
      mList.innerHTML = rows.length
        ? rows.map((it) => rdRow(it, items.indexOf(it))).join('')
        : '<div class="rd-empty">没有符合条件的学生</div>';
    };
    if (mQ) mQ.addEventListener('input', renderRdList);
    if (mStatus) mStatus.addEventListener('change', renderRdList);
    renderRdList();
    // 分段状态控件（复用既有 segCell/bindSeg：桌面表格与手机名单共用 items）
    if (canEdit && mList) {
      bindSeg(mList, items, renderRdList);
      mList.addEventListener('input', (e) => {
        const input = e.target.closest('input[data-note]');
        if (!input) return;
        const item = items.find((x) => x.studentId === input.dataset.note);
        if (item) item.note = input.value;
      });
    }
    // 概览/名单 锚点切换（同一页面上下两段，设计图右侧 tab 栏）
    const mTabs = root.querySelector('#mRdTabs');
    if (mTabs) {
      mTabs.addEventListener('click', (e) => {
        const btn = e.target.closest('.rd-tab');
        if (!btn) return;
        const target = btn.dataset.jump === 'stats' ? root.querySelector('#mRdStats') : mList;
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
    // 修改51：批量操作——按钮原地融化形变为面板（与发起点名页同一绑定器）
    const rdMorph = bindMorphPanel(root, {
      btnSel: '#mBtnBatch',
      panelSel: '#mRdPanel',
      tipSel: '#mRdTip',
      onBatch: (v) => {
        if (v === '__clear') items.forEach((it) => (it.note = ''));
        else items.forEach((it) => (it.status = v));
        renderRdList();
        toast(v === '__clear' ? '已清空全部备注' : `已将全部 ${items.length} 名学生设为「${v}」`);
      },
    });

    if (canEdit) {
      const stuBody = root.querySelector('#stuBody');
      bindSeg(stuBody, items);
      stuBody.addEventListener('input', (e) => {
        const input = e.target.closest('input[data-note]');
        if (!input) return;
        const item = items.find((x) => x.studentId === input.dataset.note);
        if (item) item.note = input.value;
      });
      root.querySelector('#btnSave').onclick = (e) => doSave(e.target);
      const mSave = root.querySelector('#mBtnSave');
      if (mSave) mSave.onclick = (e) => doSave(e.target);
    }
  },
};
