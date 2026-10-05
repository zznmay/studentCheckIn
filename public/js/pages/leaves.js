import { api, apiDownload } from '../api.js';
import { esc, toast, confirmDialog, modal, renderPager, importModal, leaveTypeTag, PERIODS, ICONS, createMultiCombo } from '../ui.js';

const state = { status: '', q: '', page: 1, pageSize: 10 };
let periodTimes = null; // { '1-2节': {start,end}, ... }

function timeDesc(p) {
  const t = periodTimes && periodTimes[p];
  return t ? `${p} ${t.start}~${t.end}` : p;
}

function coverageTags(lv) {
  const ps = (lv.coveredPeriods && lv.coveredPeriods.length ? lv.coveredPeriods : lv.periods) || [];
  if (!ps.length) return '<span class="tag tag-gray">未覆盖任何节次</span>';
  return ps.map((p) => `<span class="tag tag-purple" title="${esc(timeDesc(p))}">${esc(p)}</span>`).join('');
}

// 修改47：手机卡申请时间格式化（本地时区 YYYY-MM-DD HH:mm，与 ui.js fmtTime 同口径补全年份）
function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16).replace('T', ' ');
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 修改47：手机卡状态三态（与桌面 statusTagOf 同口径）→ 竖条/头像档位 + 徽章配色
// tier：lv-on（已生效/生效中，紫竖条）/ lv-off（待生效/未生效，橙竖条）
function lvStatusOf(l) {
  if (l.status === '已生效') return { tier: 'lv-on', cls: 'lv-b-green', label: '已生效', icon: ICONS.checkC };
  const today = new Date().toISOString().slice(0, 10);
  if (today < l.startDate) return { tier: 'lv-off', cls: 'lv-b-orange', label: '待生效', icon: '' };
  if (today <= l.endDate) return { tier: 'lv-on', cls: 'lv-b-blue', label: '生效中', icon: '' };
  return { tier: 'lv-off', cls: 'lv-b-gray', label: '未生效', icon: ICONS.clock };
}

export default {
  async mount(root) {
    periodTimes = (await api('/api/settings/periods')).periodTimes;
    const clsList = (await api('/api/meta/classes')).classes;
    const selectedClasses = new Set();

    root.innerHTML = `
    <div class="page">
      <!-- 修改47：桌面层（4.6 原样，>720px 显示；包裹内 markup 未做任何改动） -->
      <div class="d-layer">
      <div class="page-head">
        <div>
          <h2>假单管理</h2>
          <p class="page-desc">导入假单后系统按"上课时间段"判定生效：覆盖节次的缺勤改为请假，未被覆盖的请假改回缺勤</p>
        </div>
        <div class="page-actions">
          <button class="btn" id="btnPeriods">上课时间段设置</button>
          <button class="btn" id="btnTpl">下载导入模板</button>
          <button class="btn" id="btnImportSys">导入系统请假数据</button>
          <button class="btn btn-primary" id="btnImport">批量导入假单</button>
        </div>
      </div>
      <div class="chips" id="chips"></div>
      <div class="card">
        <div class="toolbar">
          <div class="multiselect" id="clsMulti"></div>
          <select class="select" id="statusFilter" style="width:150px">
            <option value="">全部状态</option>
            <option value="待生效">待生效</option>
            <option value="已生效">已生效</option>
          </select>
          <input class="input" id="q" autocomplete="off" placeholder="搜索姓名 / 学号 / 班级 / 事由" style="width:230px" />
          <button class="btn" id="btnSearch">查询</button>
          <button class="btn" id="btnReset">重置</button>
        </div>
        <div class="table-wrap">
          <table class="table" data-card="s,t,m,s,a,m,g,b,d,m,x">
            <thead>
              <tr><th>学号</th><th>姓名</th><th>班级</th><th>请假日期</th><th>请假时间段</th><th>覆盖节次</th><th>假别</th><th>事由</th><th>状态</th><th>处理结果</th><th class="td-actions">操作</th></tr>
            </thead>
            <tbody id="tbody"><tr><td colspan="11" class="table-empty">加载中…</td></tr></tbody>
          </table>
        </div>
        <div class="card-foot">
          <div class="table-info" id="info"></div>
          <div class="pager" id="pager"></div>
        </div>
      </div>
      </div>
      <!-- 修改47：手机层（≤720px，设计稿卡片；控件 m 前缀与桌面区分，共用同一 state） -->
      <div class="m-layer">
        <div class="lv-head">
          <h2>假单管理</h2>
          <p>查看和管理学生请假申请</p>
        </div>
        <div class="page-actions lv-actions">
          <button class="btn" id="mBtnPeriods">上课时间段设置</button>
          <button class="btn" id="mBtnTpl">下载导入模板</button>
          <button class="btn" id="mBtnImportSys">导入系统请假数据</button>
          <button class="btn btn-primary" id="mBtnImport">批量导入假单</button>
        </div>
        <div class="chips" id="mChips"></div>
        <div class="card lv-filter">
          <div class="lv-frow">
            <div class="multiselect" id="mClsMulti"></div>
            <select class="select" id="mStatusFilter">
              <option value="">全部状态</option>
              <option value="待生效">待生效</option>
              <option value="已生效">已生效</option>
            </select>
          </div>
          <div class="lv-frow2">
            <div class="lv-search">${ICONS.search}<input class="input" id="mQ" autocomplete="off" placeholder="搜索姓名 / 学号 / 班级 / 事由" /></div>
            <button class="btn btn-primary" id="mBtnSearch" type="button">查询</button>
          </div>
        </div>
        <div class="lv-list" id="lvList"></div>
        <div class="lv-pager"><div class="pager" id="mPager"></div></div>
      </div>
    </div>`;

    const tbody = root.querySelector('#tbody');
    const pagerEl = root.querySelector('#pager');
    const infoEl = root.querySelector('#info');
    const chipsEl = root.querySelector('#chips');
    // 修改47：手机层节点（chips 计数 / 卡片列表 / 分页）
    const mChipsEl = root.querySelector('#mChips');
    const lvList = root.querySelector('#lvList');
    const mPagerEl = root.querySelector('#mPager');

    function renderChips() {
      chipsEl.innerHTML = `
        <span class="chip">待生效假单 <b class="text-warn" id="chipPending">–</b></span>
        <span class="chip">已生效假单 <b class="text-ok" id="chipApplied">–</b></span>
        <span class="chip">上课时间基准&nbsp; ${PERIODS.map((p) => `<span class="tag tag-gray">${esc(timeDesc(p))}</span>`).join(' ')}</span>`;
      // 修改47：手机 chips 仅保留两枚计数（「上课时间基准」长串仅桌面显示）
      mChipsEl.innerHTML = `
        <span class="chip">待生效假单 <b class="text-warn" id="mChipPending">–</b></span>
        <span class="chip">已生效假单 <b class="text-ok" id="mChipApplied">–</b></span>`;
    }

    // ---- 上课时间段设置（修改57：手机端按设计稿重构；桌面 >720px 保持原样） ----
    function settingsModal() {
      const cfg = periodTimes || {};
      // 手机层展示映射（底层 period key 不变，输入框 name 仍按原 key，保存逻辑不受影响）
      const EN_SUB = { 早自习: 'Morning Study', 晚自习: 'Evening Study' };
      const enSub = (p) => EN_SUB[p] || `Period ${p.replace('节', '')}`;
      const badgeTx = (p) => (/^[早晚]/.test(p) ? p[0] : (p.match(/^\d+/) || [''])[0]);
      const dispTx = (p) => (/^[早晚]/.test(p) ? p : `第 ${p.replace('节', '')} 节`);
      const toMin = (v) => {
        const [h, m] = String(v || '').split(':').map(Number);
        return Number.isFinite(h) ? h * 60 + (m || 0) : null;
      };
      const fmtMin = (v) => `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
      modal({
        title: '上课时间段设置',
        width: 500,
        okText: '保存',
        body: `
        <div class="d-layer">
          <div class="import-tip">判定规则：请假时间段需<b>完整包含</b>某节次的上课时间，该节次请假才生效。<br/>调整基准后仅影响后续假单导入与"重新应用"，不会自动改动已有考勤。</div>
          <div class="form pt-form">
            <div class="pt-head" aria-hidden="true"><span>节次</span><span>开始时间</span><span>结束时间</span></div>
            ${PERIODS.map((p) => {
              const t = cfg[p] || { start: '08:00', end: '09:40' };
              return `
              <div class="form-row pt-row" style="align-items:flex-end">
                <div class="form-item pt-name" style="flex:0 0 78px"><label>节次</label><div class="pt-name-tx" style="height:34px;line-height:34px;font-size:13.5px;font-weight:500">${p}</div></div>
                <div class="form-item"><label>开始时间</label><input type="time" class="input" name="st_${p}" aria-label="${p} 开始时间" value="${t.start}" /></div>
                <div class="form-item"><label>结束时间</label><input type="time" class="input" name="et_${p}" aria-label="${p} 结束时间" value="${t.end}" /></div>
              </div>`;
            }).join('')}
          </div>
        </div>

        <!-- 修改57：手机层（≤720px）——设计稿版式：头部 / 判定规则卡 / 列表头 / 逐节次行 / 重叠警示 / 底部操作栏 -->
        <div class="m-layer ptm">
          <div class="ptm-hd">
            <span class="ptm-hd-ico">${ICONS.clock}</span>
            <span class="ptm-hd-tx"><b>上课时间段设置</b><i>Class Period Configuration</i></span>
            <button type="button" class="ptm-x" data-ptm-close aria-label="关闭">×</button>
          </div>
          <div class="ptm-tip">
            <span class="ptm-tip-ico">${ICONS.info}</span>
            <div class="ptm-tip-tx">
              <p><b>判定规则</b>　请假时间段需<b>完整包含</b>某节次的上课时间，该节次请假才生效。</p>
              <p>调整基准后仅影响后续假单导入与「重新应用」，不会自动改动已有考勤。</p>
            </div>
          </div>
          <div class="ptm-head" aria-hidden="true"><span>节次 <i>/ PERIOD</i></span><span>开始时间</span><span>结束时间</span></div>
          <div class="ptm-list">
            ${PERIODS.map((p) => {
              const t = cfg[p] || { start: '08:00', end: '09:40' };
              const alt = /^[早晚]/.test(p) ? ' is-alt' : '';
              return `
              <div class="ptm-row" data-p="${p}">
                <span class="ptm-id">
                  <span class="ptm-badge${alt}">${badgeTx(p)}</span>
                  <span class="ptm-id-tx"><b>${dispTx(p)}</b><i>${enSub(p)}</i></span>
                </span>
                <input type="time" class="input ptm-time" name="st_${p}" value="${t.start}" aria-label="${p} 开始时间" />
                <input type="time" class="input ptm-time" name="et_${p}" value="${t.end}" aria-label="${p} 结束时间" />
              </div>`;
            }).join('')}
          </div>
          <div class="ptm-warn" id="ptmWarn" hidden>
            <span class="ptm-warn-ico">${ICONS.alert}</span>
            <p id="ptmWarnTx"></p>
          </div>
        </div>`,
        onMount: (wrap, close) => {
          // 手机端隐藏默认头部，改用设计稿头部；底部操作栏文案在窄屏切为「✓ 保存设置」
          wrap.classList.add('pt-modal');
          const okBtn = wrap.querySelector('[data-act="ok"]');
          if (okBtn) okBtn.innerHTML = `<span class="tx-d">保存</span><span class="tx-m">${ICONS.check}<span>保存设置</span></span>`;
          const x = wrap.querySelector('[data-ptm-close]');
          if (x) x.onclick = close;

          // 时间重叠检测：改动实时更新「行高亮 + 警示卡」（仅手机层；桌面层不参与）
          const m = wrap.querySelector('.ptm');
          if (!m) return;
          const check = () => {
            const rows = [...m.querySelectorAll('.ptm-row')];
            const ranges = rows.map((r) => {
              const ins = r.querySelectorAll('input');
              return { p: r.dataset.p, s: toMin(ins[0] && ins[0].value), e: toMin(ins[1] && ins[1].value) };
            });
            const pairs = [];
            for (let i = 0; i < ranges.length; i++) {
              for (let j = i + 1; j < ranges.length; j++) {
                const a = ranges[i], b = ranges[j];
                if (a.s === null || a.e === null || b.s === null || b.e === null) continue;
                if (a.s >= a.e || b.s >= b.e) continue; // 起止相同/倒置不按重叠处理
                if (Math.max(a.s, b.s) < Math.min(a.e, b.e)) pairs.push([a, b]);
              }
            }
            const bad = new Set();
            pairs.forEach(([a, b]) => { bad.add(a.p); bad.add(b.p); });
            rows.forEach((r) => r.classList.toggle('is-warn', bad.has(r.dataset.p)));
            const box = m.querySelector('#ptmWarn');
            const tx = m.querySelector('#ptmWarnTx');
            if (pairs.length && box && tx) {
              tx.textContent = pairs
                .map(([a, b]) => `检测到「${dispTx(a.p)}」与「${dispTx(b.p)}」时间存在重叠（${fmtMin(Math.max(a.s, b.s))}-${fmtMin(Math.min(a.e, b.e))}），建议调整以避免判定歧义。`)
                .join(' ');
              box.hidden = false;
            } else if (box) {
              box.hidden = true;
            }
          };
          m.addEventListener('input', check);
          m.addEventListener('change', check);
          check();
        },
        onOk: async (wrap, close) => {
          const pt = {};
          // 修改57：桌面层与手机层各有一套同名输入框，必须取**当前可见**的那一套，否则手机上会把隐藏的桌面层旧值提交
          const visibleVal = (kind, p) => {
            const els = [...wrap.querySelectorAll(`[name="${kind}_${p}"]`)];
            const vis = els.find((e) => e.getBoundingClientRect().width > 0);
            return (vis || els[0]).value;
          };
          for (const p of PERIODS) {
            pt[p] = { start: visibleVal('st', p), end: visibleVal('et', p) };
          }
          const r = await api('/api/settings/periods', { method: 'PUT', body: { periodTimes: pt } });
          periodTimes = r.periodTimes;
          toast('上课时间段已更新');
          close();
          renderChips();
          load();
        },
      });
    }

    // 班级多选筛选（修改65：升级为可搜索多选组合框；桌面/手机双实例共用 selectedClasses）
    const clsComboOpts = clsList.map((c) => ({ value: c.name, label: c.name, count: c.count }));
    const onClsPick = (names) => {
      selectedClasses.clear();
      names.forEach((n) => selectedClasses.add(n));
      // 双实例互相同步（保持修改47 语义：两处勾选态一致）
      const arr = [...selectedClasses];
      clsCombo.set(arr);
      mClsCombo.set(arr);
      state.page = 1;
      load();
    };
    const clsCombo = createMultiCombo({
      options: clsComboOpts, values: [...selectedClasses], placeholder: '全部班级',
      id: 'clsMultiCombo', ariaLabel: '按班级筛选假单', onChange: onClsPick,
    });
    const mClsCombo = createMultiCombo({
      options: clsComboOpts, values: [...selectedClasses], placeholder: '全部班级',
      id: 'mClsMultiCombo', ariaLabel: '按班级筛选假单', onChange: onClsPick,
    });
    root.querySelector('#clsMulti').replaceChildren(clsCombo.el);
    root.querySelector('#mClsMulti').replaceChildren(mClsCombo.el);
    // 保留 syncClsUI 供重置 / mBtnSearch 调用（语义：把 selectedClasses 回写到两实例）
    function syncClsUI() {
      const arr = [...selectedClasses];
      clsCombo.set(arr);
      mClsCombo.set(arr);
    }

    // 修改47：手机卡片（lv-card）与桌面表格共用同一份数据双渲染（rk-list 先例）；
    // lv-list 在 .m-layer 内仅 ≤720px 显示，桌面表格 >720px 显示。
    const lvCardHtml = (l) => {
      const st = lvStatusOf(l);
      return `
        <div class="lv-card ${st.tier}" data-id="${l.id}">
          <div class="lv-top">
            <div class="lv-ava">${ICONS.user}</div>
            <div class="lv-idtx">
              <div class="lv-name">${esc(l.studentName)}</div>
              <div class="lv-sub"><span class="lv-sid">${esc(l.studentId) || '—'}</span></div>
              <div class="lv-cls">${esc(l.className)}</div>
            </div>
            <span class="lv-badge ${st.cls}">${st.icon}${st.label}</span>
          </div>
          <div class="lv-row">
            ${ICONS.calendar}
            <span class="lv-date">${esc(l.startDate)} ~ ${esc(l.endDate)}</span>
            <span class="tag tag-gray">${esc(l.type)}</span>
          </div>
          <div class="lv-row">
            ${ICONS.clock}
            <span class="lv-meta">${
              l.startDate === l.endDate
                ? l.timeStart ? `${esc(l.timeStart)}~${esc(l.timeEnd)}` : '按节次'
                : `${esc(l.timeStart) || '00:00'} 起连续请假至 ${esc(l.endDate.slice(5))} ${esc(l.timeEnd) || '23:59'}`
            }</span>
          </div>
          <div class="lv-label-row">${ICONS.book}<span>请假节次</span></div>
          <div class="lv-chips">${coverageTags(l)}</div>
          ${(l.remark || l.reason) ? `
          <div class="lv-note">
            ${ICONS.file}
            <div class="lv-note-text">${esc(l.remark) || esc(l.reason)}</div>
            ${ICONS.chevronR}
          </div>` : ''}
          <div class="lv-foot">
            <div class="lv-acts">
              ${l.status === '待生效' ? '<button class="btn-text" data-act="apply">重新应用</button>' : ''}
              <button class="btn-text danger" data-act="del">删除</button>
            </div>
            <div class="lv-time">申请时间：${fmtDateTime(l.importedAt)}</div>
          </div>
        </div>`;
    };

    async function load() {
      tbody.innerHTML = '<tr><td colspan="11" class="table-empty">加载中…</td></tr>';
      lvList.innerHTML = '<div class="lv-empty">加载中…</div>';
      const params = new URLSearchParams({ page: state.page, pageSize: state.pageSize });
      if (state.status) params.set('status', state.status);
      if (selectedClasses.size) params.set('classNames', [...selectedClasses].join(','));
      if (state.q) params.set('q', state.q);
      const d = await api(`/api/leaves?${params}`);
      const pendingEl = chipsEl.querySelector('#chipPending');
      if (pendingEl) {
        chipsEl.querySelector('#chipPending').textContent = d.stats.pending;
        chipsEl.querySelector('#chipApplied').textContent = d.stats.applied;
      }
      // 修改47：手机 chips 计数同步
      const mPendingEl = mChipsEl.querySelector('#mChipPending');
      if (mPendingEl) {
        mPendingEl.textContent = d.stats.pending;
        mChipsEl.querySelector('#mChipApplied').textContent = d.stats.applied;
      }
      infoEl.textContent = `共 ${d.total} 张假单`;
      renderPager(pagerEl, d, (p) => {
        state.page = p;
        load();
      });
      // 修改47：手机分页与桌面共用同一 state
      renderPager(mPagerEl, d, (p) => {
        state.page = p;
        load();
      });
      tbody.innerHTML = d.list.length
        ? d.list
            .map(
              (l) => `
        <tr data-id="${l.id}">
          <td class="num">${esc(l.studentId) || '<span class="muted">—</span>'}</td>
          <td><b>${esc(l.studentName)}</b></td>
          <td>${esc(l.className)}</td>
          <td class="num">${l.startDate === l.endDate ? esc(l.startDate) : `${esc(l.startDate)}<br/><span class="muted small">~ ${esc(l.endDate)}</span>`}</td>
          <td class="num">${
            l.startDate === l.endDate
              ? l.timeStart ? `${esc(l.timeStart)}~${esc(l.timeEnd)}` : '<span class="muted small">按节次</span>'
              : `${esc(l.timeStart) || '00:00'} 起连续请假至 ${esc(l.endDate.slice(5))} ${esc(l.timeEnd) || '23:59'}`
          }</td>
          <td style="max-width:150px">${coverageTags(l)}</td>
          <td>${leaveTypeTag(l.type)}</td>
          <td style="max-width:180px"><span class="small">${esc(l.reason)}</span></td>
          <td>${statusTagOf(l)}</td>
          <td class="muted small" style="max-width:240px">${esc(l.remark) || '—'}</td>
          <td class="td-actions">
            ${l.status === '待生效' ? '<button class="btn-text" data-act="apply">重新应用</button>' : ''}
            <button class="btn-text danger" data-act="del">删除</button>
          </td>
        </tr>`
            )
            .join('')
        : '<tr><td colspan="11" class="table-empty">暂无假单，点击右上角"批量导入假单"开始</td></tr>';
      // 修改47：同一 d.list 另渲染手机卡片进 #lvList（双渲染）
      lvList.innerHTML = d.list.length ? d.list.map(lvCardHtml).join('') : '<div class="lv-empty">暂无假单，点击「批量导入假单」开始</div>';
    }

    // 状态展示（三态，仅展示层映射；持久状态仍为 已生效/待生效，筛选不受影响）：
    // 生效中 = 请假期间内（点名提交后缺勤将自动改判请假）；未生效 = 请假已结束但期间无可套用的缺勤记录
    function statusTagOf(l) {
      if (l.status === '已生效') return '<span class="tag tag-green">已生效</span>';
      const today = new Date().toISOString().slice(0, 10);
      if (today < l.startDate) return '<span class="tag tag-orange" title="请假尚未开始：到达开始日期后，点名提交时将自动套用">待生效</span>';
      if (today <= l.endDate) return '<span class="tag tag-blue" title="请假期间内：对应日期点名提交后，缺勤将自动改判为请假（也可点「重新应用」立即套用）">生效中</span>';
      return '<span class="tag tag-gray" title="请假已结束，期间没有可套用的缺勤考勤记录（该生未被记缺勤或无点名记录），考勤数据无需修正">未生效</span>';
    }

    root.querySelector('#btnPeriods').onclick = settingsModal;
    root.querySelector('#btnTpl').onclick = () => apiDownload('/api/templates/leaves', '假单导入模板.xlsx');
    root.querySelector('#btnImport').onclick = () =>
      importModal({
        title: '批量导入假单',
        templateName: 'leaves',
        templateFile: '假单导入模板.xlsx',
        tip: `模板字段：班级、姓名、学号、请假开始日期、请假开始时间、请假结束日期、请假结束时间、假别、事由。<br/>
        跨天请假为<b>连续请假时间段</b>：首日自开始时间起、中间日全天、末日至结束时间止均为请假，仅需一条记录；单日请假两个日期填同一天即可。<br/>
        校验规则：仅需学号与姓名存在于班级名单（班级名称以名单为准，可容忍表述差异）；日期 / 时间格式错误、时间先后颠倒等会逐行报错；同一学生相同请假时间段自动去重。<br/>
        判定规则：请假时段<b>完整包含</b>某节次上课时间（基准：${PERIODS.map(timeDesc).join('；')}）时，该节次请假生效：<br/>
        ① 该节次考勤为"缺勤" → 自动改为"请假"并备注假别与事由；<br/>
        ② 该节次已登记"请假"但未被覆盖 → 自动改回"缺勤"。<br/>
        请上传 .xlsx 格式的 Excel 文件；日期支持 2026/9/24、2026-09-24 或 Excel 日期格式；兼容旧模板"请假日期 / 节次"列。`,
        doImport: (rows) => api('/api/leaves/import', { method: 'POST', body: { rows } }),
        onDone: () => load(),
      });
    root.querySelector('#btnImportSys').onclick = () =>
      importModal({
        title: '导入系统请假数据',
        tip: `导入外部系统导出的《学生请假信息》Excel（.xlsx），字段自动映射：<br/>
        学号 / 班级 / 姓名 → 原样对应；请假开始时间 → 请假开始日期 + 开始时间；请假结束时间 → 请假结束日期 + 结束时间（兼容拆分列写法）；请假类型 → 假别；请假事由 → 事由（新表格可无此列，事由留空）。<br/>
        审批状态：表格无"审批/审核状态"列时默认按<b>已通过</b>导入；有该列时仅跳过明确标注"未通过 / 待审核"的记录（空值视为已通过）。校验仅需学号 / 姓名在班级名单中；日期支持 Excel 日期格式或"2026-09-23 20:00:00"文本（仅有日期无时间时按开始 00:00 / 结束 23:59 处理）；导入后按上课时间段基准自动完成考勤双向对账。`,
        upload: (dataBase64) => api('/api/leaves/import-system', { method: 'POST', body: { dataBase64 } }),
        onDone: () => load(),
      });

    // 修改47：手机层 4 枚操作按钮共用桌面处理器（同一函数引用，行为等价）
    for (const [mSel, dSel] of [
      ['#mBtnPeriods', '#btnPeriods'],
      ['#mBtnTpl', '#btnTpl'],
      ['#mBtnImport', '#btnImport'],
      ['#mBtnImportSys', '#btnImportSys'],
    ]) {
      root.querySelector(mSel).onclick = root.querySelector(dSel).onclick;
    }

    // 修改47：桌面/手机两套表单共用同一 state；手机查询回写桌面控件后统一走 load()
    const applyFilter = () => {
      state.status = root.querySelector('#statusFilter').value;
      state.q = root.querySelector('#q').value.trim();
      state.page = 1;
      load();
    };
    root.querySelector('#btnSearch').onclick = applyFilter;
    root.querySelector('#mBtnSearch').onclick = () => {
      // 手机端筛选后回写桌面控件（#statusFilter/#q/clsMultiBtn 文案与勾选态），跨断点不丢条件
      root.querySelector('#statusFilter').value = root.querySelector('#mStatusFilter').value;
      root.querySelector('#q').value = root.querySelector('#mQ').value.trim();
      syncClsUI();
      applyFilter();
    };
    const onReset = () => {
      root.querySelector('#statusFilter').value = '';
      root.querySelector('#mStatusFilter').value = '';
      selectedClasses.clear();
      syncClsUI();
      root.querySelector('#q').value = '';
      root.querySelector('#mQ').value = '';
      root.querySelector('#btnSearch').click();
    };
    root.querySelector('#btnReset').onclick = onReset;
    root.querySelector('#q').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') root.querySelector('#btnSearch').click();
    });
    root.querySelector('#mQ').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') root.querySelector('#mBtnSearch').click();
    });

    // 修改47：操作委托 tbody（桌面表格）/ lvList（手机卡）两容器共用，data-act/data-id 取行
    const onListAct = async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      // 修复52：加可选链与空值守卫（桌面 tr[data-id] / 手机 .lv-card[data-id] 均有值，
      // 但直接 .dataset 在匹配失败时会抛错并静默中断整个处理器）
      const id = e.target.closest('[data-id]')?.dataset.id;
      if (!id) return;
      if (act === 'apply') {
        btn.disabled = true;
        try {
          const r = await api(`/api/leaves/${id}/apply`, { method: 'POST' });
          const parts = [];
          if (r.applied) parts.push(`缺勤改为请假 ${r.applied} 条`);
          if (r.reverted) parts.push(`无效请假改判缺勤 ${r.reverted} 条`);
          toast(parts.length ? `已重新应用：${parts.join('；')}` : r.leave.remark || '暂无可更新的考勤记录', parts.length ? 'success' : 'info');
          load();
        } catch (err) {
          toast(err.message, 'error');
          btn.disabled = false;
        }
        return;
      }
      if (act === 'del') {
        const ok = await confirmDialog('确定删除该假单吗？<br/><span class="muted small">删除后将重新对账：失去假单覆盖的"请假"会自动改回"缺勤"。</span>', { danger: true, title: '删除假单' });
        if (!ok) return;
        const r = await api(`/api/leaves/${id}`, { method: 'DELETE' });
        toast(r.reverted ? `假单已删除，${r.reverted} 条失去覆盖的请假已改判缺勤` : '假单已删除', r.reverted ? 'info' : 'success');
        load();
      }
    };
    tbody.onclick = onListAct;
    lvList.onclick = onListAct;
    // 修改47：手机卡片备注块点击展开/收起（默认截断 2 行，展开显示全文）
    lvList.addEventListener('click', (e) => {
      const note = e.target.closest('.lv-note');
      if (note) note.classList.toggle('open');
    });

    renderChips();
    await load();
  },
};
