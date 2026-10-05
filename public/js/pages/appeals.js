import { api } from '../api.js';
import { getUser, hasAnyRole, hasRole } from '../session.js';
import { esc, ICONS, toast, modal, renderPager, enhanceTables, fmtTime, upgradeSelectToCombo } from '../ui.js';

/**
 * 考勤异议审核页（修改27 建页 / 修改28 重构详情弹窗）
 * 角色：管理员 / 权益部 / 学院考勤负责老师（服务端 APPEAL_REVIEW_ROLES 同步校验）
 * 状态机：pending →(审核)→ approved / rejected（终态锁定）→ approved 单执行改判 → resolved（办结）
 * 修改28：①详情弹窗四分区信息架构（身份状态/理由材料/记录表/操作区）
 *        ②审核「通过/驳回」后弹窗不关闭，原地切换为下一步操作区（流程顺滑衔接）
 *        ③已办结单可「重新判定」（admin/collegeOfficer 恒可，rights 须为本单审核人/改判人；
 *          目标状态=请假/出勤/恢复原状态；旧留痕移入 resolveHistory 历史折叠）
 */
const APPEAL_STATUS = {
  pending: { label: '待审核', cls: 'tag-orange' },
  approved: { label: '已通过', cls: 'tag-green' },
  resolved: { label: '已办结', cls: 'tag-blue' },
  rejected: { label: '已驳回', cls: 'tag-red' },
  withdrawn: { label: '已撤销', cls: 'tag' },
};
const statusTag = (s) => {
  const st = APPEAL_STATUS[s] || { label: s, cls: '' };
  return `<span class="tag ${st.cls}">${esc(st.label)}</span>`;
};
// reviewer/resolver 存储格式为「姓名(username)」，用用户名后缀匹配最稳
const isMe = (s, user) => String(s || '').endsWith(`(${user.username})`);

export default {
  async mount(root) {
    root.innerHTML = `<div class="muted" style="padding:40px;text-align:center">加载中…</div>`;
    const user = getUser();

    let meta;
    try {
      meta = await api('/api/public/absence/meta');
    } catch (e) {
      root.innerHTML = `<div class="page"><div class="card empty-card">加载失败：${esc(e.message)}</div></div>`;
      return;
    }

    const state = { status: 'pending', className: '', q: '', page: 1, pageSize: 20 };

    root.innerHTML = `
    <div class="page">
      <div class="page-head"><h2>考勤异议</h2><p class="page-desc">学生在「缺勤公示 → 缺勤自查」提交的异议在此审核判定；判定通过后可在详情中执行改判（缺勤/迟到 → 请假/出勤），改判结果实时同步缺勤公示</p></div>
      <div class="card">
        <div class="filters">
          <div class="seg apl-seg">
            <button class="seg-btn on" data-status="pending">待审核</button>
            <button class="seg-btn" data-status="approved">已通过</button>
            <button class="seg-btn" data-status="rejected">已驳回</button>
            <button class="seg-btn" data-status="all">全部</button>
          </div>
          <select class="input apl-class" id="aplClass">
            <option value="">全部班级</option>
            ${meta.classes.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
          </select>
          <input class="input apl-q" id="aplQ" placeholder="搜索姓名 / 学号 / 理由" maxlength="30" />
          <button class="btn btn-primary apl-search" id="aplSearchBtn">查询</button>
        </div>
        <div id="aplList"></div>
        <div class="pager apl-pager" id="aplPager"></div>
      </div>
    </div>`;

    const $ = (sel) => root.querySelector(sel);

    // ---------- 列表 ----------
    async function loadList() {
      const box = $('#aplList');
      box.innerHTML = `<div class="muted" style="padding:24px;text-align:center">加载中…</div>`;
      const params = new URLSearchParams({ status: state.status, page: state.page, pageSize: state.pageSize });
      if (state.className) params.set('className', state.className);
      if (state.q) params.set('q', state.q);
      let d;
      try {
        d = await api(`/api/appeals?${params}`);
      } catch (e) {
        box.innerHTML = `<div class="ir-line bad">✗ ${esc(e.message)}</div>`;
        return;
      }
      if (!d.list.length) {
        box.innerHTML = `<div class="empty-card">暂无${state.status === 'all' ? '' : APPEAL_STATUS[state.status].label + '的'}异议单</div>`;
        $('#aplPager').innerHTML = '';
        return;
      }
      const rows = d.list
        .map((a) => {
          const dates = a.records.map((r) => r.date);
          const dateRange = dates.length === 1 ? dates[0] : `${dates[0]} ~ ${dates[dates.length - 1]}`;
          const statuses = [...new Set(a.records.map((r) => r.status))].join('/');
          return `
          <tr>
            <td class="num small">${fmtTime(a.createdAt)}</td>
            <td><b>${esc(a.studentName)}</b><div class="muted small">${esc(a.studentId)} · ${esc(a.className)}</div></td>
            <td class="small">${a.recordsCount} 条（${esc(statuses)}）<div class="muted small">${esc(dateRange)}</div></td>
            <td class="small apl-reason-cell" title="${esc(a.reason || '')}">${esc(a.reason || '')}</td>
            <td>${statusTag(a.status)}</td>
            <td class="small">${a.reviewInfo ? esc(a.reviewInfo.reviewer) : '<span class="muted">—</span>'}${a.resolveInfo ? `<div class="muted small">改判：${esc(a.resolveInfo.resolver)}${(a.resolveHistory || []).length ? `（重判 ${a.resolveHistory.length} 次）` : ''}</div>` : ''}</td>
            <td><button class="btn-text" data-act="detail" data-id="${esc(a.id)}">详情</button></td>
          </tr>`;
        })
        .join('');
      box.innerHTML = `
      <div class="table-wrap"><table class="table" data-card="s,t,b,m,d,m,x">
        <thead><tr><th>提交时间</th><th>学生</th><th>异议记录</th><th>异议理由</th><th>状态</th><th>审核 / 改判</th><th>操作</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
      enhanceTables(box);
      renderPager($('#aplPager'), d, (p) => { state.page = p; loadList(); });
    }

    // ---------- 筛选交互 ----------
    root.querySelector('.apl-seg').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-status]');
      if (!btn) return;
      state.status = btn.dataset.status;
      state.page = 1;
      root.querySelectorAll('.apl-seg .seg-btn').forEach((b) => b.classList.toggle('on', b === btn));
      loadList();
    });
    // 修改65：班级筛选升级为可搜索组合框（升级须在下方 doSearch 绑定之前）
    upgradeSelectToCombo(root.querySelector('#aplClass'));
    const doSearch = () => { state.className = $('#aplClass').value; state.q = $('#aplQ').value.trim(); state.page = 1; loadList(); };
    $('#aplSearchBtn').onclick = doSearch;
    $('#aplQ').addEventListener('keydown', (e) => e.key === 'Enter' && doSearch());

    $('#aplList').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act="detail"]');
      if (!btn) return;
      openDetail(btn.dataset.id);
    });

    // ==================== 详情弹窗（修改28 四分区 + 状态机操作区） ====================
    function openDetail(id) {
      modal({
        title: '异议详情',
        width: 900,
        showFooter: false,
        body: `<div id="aplDetailBody" class="muted small">加载中…</div>`,
        onMount: async (wrap, close) => {
          const body = wrap.querySelector('#aplDetailBody');
          let a;
          try {
            ({ appeal: a } = await api(`/api/appeals/${id}`));
          } catch (e) {
            body.innerHTML = `<div class="ir-line bad">✗ ${esc(e.message)}</div>`;
            return;
          }

          body.innerHTML = `
          <div class="apl-d-head">
            <div class="apl-d-id"><b>${esc(a.studentName)}</b><span class="muted">（${esc(a.studentId)}）</span> · ${esc(a.className)}</div>
            <div class="apl-d-meta"><span class="muted small">提交于 ${fmtTime(a.createdAt)}</span><span class="apl-d-status">${statusTag(a.status)}</span></div>
          </div>
          <div class="apl-d-sec">
            <div class="apl-d-sec-title"><span>异议理由</span><span class="muted">记录 ${a.recordsCount} 条 · 附件 ${a.attachmentsCount}/3</span></div>
            <div class="apl-reason">${esc(a.reason)}</div>
            ${(a.attachments || []).length
              ? `<div class="apl-atts">${a.attachments.map((x, i) => `<img class="apl-thumb" src="${esc(x.dataUrl)}" alt="${esc(x.name)}" title="${esc(x.name)}" data-att="${i}" />`).join('')}</div>`
              : '<div class="muted small" style="margin-top:8px">未上传佐证材料</div>'}
          </div>
          <div class="apl-d-sec">
            <div class="apl-d-sec-title"><span>异议记录（提交时状态快照）</span></div>
            <div class="table-wrap apl-d-tbl"><table class="table" data-card="t,g,d,a">
              <thead><tr><th>日期</th><th>节次</th><th>提交时状态</th><th>记录编号</th></tr></thead>
              <tbody>${a.records
                .map((r) => `<tr><td class="num">${esc(r.date)}</td><td>${(r.periods || []).map((p) => `<span class="tag tag-purple">${esc(p)}</span>`).join('')}</td><td>${r.status === '迟到' ? '<span class="tag tag-orange">迟到</span>' : '<span class="tag tag-red">缺勤</span>'}</td><td class="small muted">${esc(r.sessionId)}</td></tr>`)
                .join('')}</tbody>
            </table></div>
          </div>
          <div class="apl-d-action" id="aplActionArea"></div>`;

          // 附件放大查看
          body.querySelectorAll('.apl-thumb').forEach((img) => {
            img.onclick = () => modal({ title: img.title || '附件查看', width: 720, showFooter: false, body: `<img src="${esc(img.src)}" style="width:100%;border-radius:10px;display:block" />` });
          });

          const statusEl = body.querySelector('.apl-d-status');
          const actionArea = body.querySelector('#aplActionArea');
          const syncStatus = () => { statusEl.innerHTML = statusTag(a.status); };

          // ---------- 操作区：按状态渲染（状态流转原地复用） ----------
          function renderActionArea() {
            syncStatus();
            // ===== pending：审核区 =====
            if (a.status === 'pending') {
              actionArea.innerHTML = `
              <div class="apl-d-sec-title"><span>审核判定</span><span class="muted small">通过后需继续执行改判</span></div>
              <textarea class="input apl-review-comment" rows="2" maxlength="300" placeholder="审核意见（驳回时必填；通过时选填）"></textarea>
              <div class="login-err apl-err"></div>
              <div class="apl-btn-row">
                <button class="btn btn-danger apl-reject">驳回</button>
                <button class="btn btn-primary apl-approve">通过，进入改判</button>
              </div>`;
              const err = actionArea.querySelector('.apl-err');
              const comment = () => actionArea.querySelector('.apl-review-comment').value.trim();
              actionArea.querySelector('.apl-approve').onclick = async () => {
                err.textContent = '';
                try {
                  const r = await api(`/api/appeals/${a.id}/review`, { method: 'POST', body: { decision: 'approved', comment: comment() } });
                  Object.assign(a, r.appeal);
                  renderActionArea(); // 修改28：弹窗不关闭，原地切换为改判区
                  loadList();
                  toast('已通过审核，请继续执行改判');
                } catch (e) { err.textContent = e.message; }
              };
              actionArea.querySelector('.apl-reject').onclick = async () => {
                err.textContent = '';
                if (!comment()) { err.textContent = '驳回时必须填写审核意见'; return; }
                try {
                  const r = await api(`/api/appeals/${a.id}/review`, { method: 'POST', body: { decision: 'rejected', comment: comment() } });
                  Object.assign(a, r.appeal);
                  renderActionArea(); // 原地切换为只读审核意见
                  loadList();
                  toast('已驳回该异议');
                } catch (e) { err.textContent = e.message; }
              };
              return;
            }

            // ===== rejected：只读审核意见 =====
            if (a.status === 'rejected') {
              actionArea.innerHTML = `
              <div class="apl-d-sec-title"><span>审核意见（已驳回）</span></div>
              <div class="apl-review-readonly">${esc((a.reviewInfo && a.reviewInfo.comment) || '')}<div class="muted small">${esc((a.reviewInfo && a.reviewInfo.reviewer) || '')} · ${fmtTime(a.reviewInfo && a.reviewInfo.reviewedAt)}</div></div>`;
              return;
            }

            // ===== approved：改判区（逐条选择目标状态） =====
            if (a.status === 'approved') {
              const selRows = a.records
                .map((r) => `
                <div class="apl-resolve-row" data-sid="${esc(r.sessionId)}">
                  <span class="small"><b>${esc(r.date)}</b> ${(r.periods || []).map((p) => `<span class="tag tag-purple">${esc(p)}</span>`).join('')}（提交时：${esc(r.status)}）</span>
                  <select class="input apl-resolve-to"><option value="请假">改为 请假</option><option value="出勤">改为 出勤</option></select>
                </div>`)
                .join('');
              actionArea.innerHTML = `
              <div class="apl-d-sec-title"><span>执行改判（审核已通过）</span></div>
              <p class="muted small" style="margin:0 0 8px">为每条记录选择改判后的考勤状态；执行后缺勤公示实时同步。已不是「缺勤/迟到」的记录会自动跳过并留痕。</p>
              ${selRows}
              <div class="login-err apl-err"></div>
              <div class="apl-btn-row">
                <button class="btn btn-primary apl-resolve-btn">确认改判并办结</button>
              </div>`;
              actionArea.querySelector('.apl-resolve-btn').onclick = async () => {
                const err = actionArea.querySelector('.apl-err');
                err.textContent = '';
                const items = [...actionArea.querySelectorAll('.apl-resolve-row')].map((row) => ({
                  sessionId: row.dataset.sid,
                  to: row.querySelector('.apl-resolve-to').value,
                }));
                const btn = actionArea.querySelector('.apl-resolve-btn');
                btn.disabled = true;
                try {
                  const r = await api(`/api/appeals/${a.id}/resolve`, { method: 'POST', body: { items } });
                  Object.assign(a, r.appeal);
                  renderActionArea(); // 原地展示办结留痕（修改28：不再直接关弹窗）
                  loadList();
                  toast(`改判完成：${r.changed}/${items.length} 条已执行`);
                } catch (e) {
                  err.textContent = e.message;
                  btn.disabled = false;
                }
              };
              return;
            }

            // ===== resolved：办结留痕 + 重新判定（修改28） =====
            if (a.status === 'resolved') {
              const items = (a.resolveInfo && a.resolveInfo.items) || [];
              const hist = a.resolveHistory || [];
              const canRe = hasAnyRole(user, ['admin', 'collegeOfficer']) || (hasRole(user, 'rights') && (isMe(a.reviewInfo && a.reviewInfo.reviewer, user) || isMe(a.resolveInfo && a.resolveInfo.resolver, user)));
              const histHtml = hist.length
                ? `<details class="apl-history"><summary>历史改判记录（${hist.length} 轮）</summary>
                  ${hist.map((h, i) => `
                    <div class="apl-history-round">
                      <div class="muted small">第 ${i + 1} 轮 · ${esc(h.resolver)} · ${fmtTime(h.resolvedAt)}</div>
                      <div class="table-wrap"><table class="table" data-card="t,d,d,a"><thead><tr><th>日期</th><th>原状态</th><th>改为</th><th>结果</th></tr></thead><tbody>
                        ${(h.items || []).map((x) => `<tr><td class="num">${esc(x.date)}</td><td>${esc(x.from)}</td><td>${esc(x.to)}</td><td>${x.applied ? '<span class="tag tag-green">已改判</span>' : '<span class="tag">跳过</span>'}</td></tr>`).join('')}
                      </tbody></table></div>
                    </div>`).join('')}
                </details>`
                : '';
              actionArea.innerHTML = `
              <div class="apl-d-sec-title"><span>改判结果（已办结）${a.resolveInfo && a.resolveInfo.isRe ? '<span class="tag tag-cyan">重新改判</span>' : ''}</span>
                <span class="muted small">执行人：${esc((a.resolveInfo && a.resolveInfo.resolver) || '')} · ${fmtTime(a.resolveInfo && a.resolveInfo.resolvedAt)}</span></div>
              <div class="table-wrap apl-d-tbl"><table class="table" data-card="t,d,d,a">
                <thead><tr><th>日期</th><th>原状态</th><th>改为</th><th>执行结果</th></tr></thead>
                <tbody>${items
                  .map((x) => `<tr><td class="num">${esc(x.date)}</td><td>${esc(x.from)}</td><td>${esc(x.to)}</td><td>${x.applied ? '<span class="tag tag-green">已改判</span>' : '<span class="tag">跳过（状态已变更）</span>'}</td></tr>`)
                  .join('')}</tbody>
              </table></div>
              ${histHtml}
              ${canRe ? `<div class="apl-btn-row" style="margin-top:10px"><button class="btn apl-rere-btn">重新判定</button><span class="muted small">可改到另一状态或恢复原状态，全程留痕</span></div><div id="aplReArea"></div>` : ''}`;
              const reBtn = actionArea.querySelector('.apl-rere-btn');
              if (!reBtn) return;
              reBtn.onclick = () => {
                reBtn.disabled = true;
                const reArea = actionArea.querySelector('#aplReArea');
                const selRows = a.records
                  .map((r) => `
                  <div class="apl-resolve-row" data-sid="${esc(r.sessionId)}">
                    <span class="small"><b>${esc(r.date)}</b> ${(r.periods || []).map((p) => `<span class="tag tag-purple">${esc(p)}</span>`).join('')}（当前留痕：${esc((items.find((x) => x.sessionId === r.sessionId) || {}).to || r.status)}）</span>
                    <select class="input apl-resolve-to"><option value="请假">改为 请假</option><option value="出勤">改为 出勤</option><option value="恢复原状态">恢复原状态</option></select>
                  </div>`)
                  .join('');
                reArea.innerHTML = `
                <p class="muted small" style="margin:10px 0 8px">重新判定将覆盖上方最新改判结果（旧结果移入历史记录）；「恢复原状态」把记录改回最近一次实际改判前的状态。</p>
                ${selRows}
                <div class="login-err apl-err"></div>
                <div class="apl-btn-row">
                  <button class="btn apl-rere-cancel">取消</button>
                  <button class="btn btn-primary apl-rere-confirm">确认重新改判</button>
                </div>`;
                reArea.querySelector('.apl-rere-cancel').onclick = () => { reArea.innerHTML = ''; reBtn.disabled = false; };
                reArea.querySelector('.apl-rere-confirm').onclick = async () => {
                  const err = reArea.querySelector('.apl-err');
                  err.textContent = '';
                  const reItems = [...reArea.querySelectorAll('.apl-resolve-row')].map((row) => ({
                    sessionId: row.dataset.sid,
                    to: row.querySelector('.apl-resolve-to').value,
                  }));
                  const btn = reArea.querySelector('.apl-rere-confirm');
                  btn.disabled = true;
                  try {
                    const r = await api(`/api/appeals/${a.id}/reresolve`, { method: 'POST', body: { items: reItems } });
                    Object.assign(a, r.appeal);
                    renderActionArea();
                    loadList();
                    toast(`重新改判完成：${r.changed}/${reItems.length} 条已执行`);
                  } catch (e) {
                    err.textContent = e.message;
                    btn.disabled = false;
                  }
                };
              };
            }
          }

          renderActionArea();
        },
      });
    }

    loadList();
  },
};
