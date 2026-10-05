import { api } from '../api.js';
import { esc, ICONS, toast, createSignaturePad } from '../ui.js';

/** 任课老师免登录签字确认页（公开路由 #/confirm/:token） */
export default {
  async mount(root, params) {
    const token = params.token;
    root.innerHTML = `<div class="muted" style="padding:40px;text-align:center">加载中…</div>`;

    let d;
    try {
      d = await api(`/api/confirm/${encodeURIComponent(token)}`);
    } catch (e) {
      root.innerHTML = `
      <div class="login-wrap">
        <div class="login-card" style="max-width:440px;text-align:center">
          <div class="login-logo"><span class="brand-icon">${ICONS.logo}</span></div>
          <h1 style="font-size:19px">链接无效</h1>
          <p class="login-sub">${esc(e.message)}</p>
        </div>
      </div>`;
      return;
    }

    const r = d.record;
    const week = `周${'日一二三四五六'[new Date(`${r.date}T00:00:00`).getDay()]}`;

    if (d.confirmed) {
      // 已确认：展示确认结果与签名回显
      root.innerHTML = `
      <div class="login-wrap">
        <div class="login-card" style="max-width:560px">
          <div class="login-logo"><span class="brand-icon">${ICONS.logo}</span></div>
          <h1 style="font-size:19px">该考勤记录已确认</h1>
          <p class="login-sub">无需重复操作；如有疑问请联系班级纪律委员</p>
          <div class="card" style="box-shadow:none;border:1px solid var(--border-light)">
            <div class="info-grid" style="grid-template-columns:repeat(2,1fr)">
              <div class="info-item"><div class="ii-label">班级</div><div class="ii-value">${esc(r.className)}</div></div>
              <div class="info-item"><div class="ii-label">上课日期</div><div class="ii-value">${esc(r.date)}</div></div>
              <div class="info-item"><div class="ii-label">课程名称</div><div class="ii-value">${esc(r.courseName)}</div></div>
              <div class="info-item"><div class="ii-label">任课老师</div><div class="ii-value">${esc(r.teacher) || '—'}</div></div>
            </div>
            <div class="mt14" style="text-align:center">
              <span class="tag tag-green">✓ 任课老师已确认</span>
              <div class="muted small mt14">确认人：${esc(d.confirm.name)} · ${esc(d.confirm.at.replace('T', ' ').slice(0, 16))}</div>
              ${d.confirm.signature ? `<img class="sig-img mt14" src="${d.confirm.signature}" alt="手写签名" style="width:280px" />` : ''}
            </div>
          </div>
        </div>
      </div>`;
      return;
    }

    // 待确认：摘要 + 签名板
    root.innerHTML = `
    <div class="login-wrap" style="align-items:flex-start;padding:24px 16px">
      <div class="login-card" style="max-width:640px;width:100%">
        <div class="login-logo"><span class="brand-icon">${ICONS.logo}</span></div>
        <h1 style="font-size:19px">考勤记录确认</h1>
        <p class="login-sub">请核对以下本次课堂考勤记录，确认无误后手写签名</p>
        <div class="card" style="box-shadow:none;border:1px solid var(--border-light);margin-bottom:16px">
          <div class="info-grid" style="grid-template-columns:repeat(2,1fr)">
            <div class="info-item"><div class="ii-label">班级</div><div class="ii-value">${esc(r.className)}</div></div>
            <div class="info-item"><div class="ii-label">上课日期</div><div class="ii-value">${esc(r.date)}（${esc(week)}）</div></div>
            <div class="info-item"><div class="ii-label">节次</div><div class="ii-value">${r.periods.map((p) => `<span class="tag tag-purple">${esc(p)}</span>`).join(' ')}</div></div>
            <div class="info-item"><div class="ii-label">课程名称</div><div class="ii-value">${esc(r.courseName)}</div></div>
            <div class="info-item"><div class="ii-label">任课老师</div><div class="ii-value">${esc(r.teacher) || '—'}</div></div>
            <div class="info-item"><div class="ii-label">发起人</div><div class="ii-value">${esc(r.createdBy)}</div></div>
          </div>
          <div class="mt14" style="display:flex;gap:14px;font-size:13px;flex-wrap:wrap">
            <span class="cm-green">出勤<b>${r.counts['出勤']}</b></span>
            <span class="cm-orange">迟到<b>${r.counts['迟到']}</b></span>
            <span class="cm-red">缺勤<b>${r.counts['缺勤']}</b></span>
            <span class="cm-blue">请假<b>${r.counts['请假']}</b></span>
            <span class="muted">应到 ${r.total} 人</span>
          </div>
        </div>
        ${(function () {
          const by = { 缺勤: [], 迟到: [], 请假: [] };
          r.items.forEach((it) => { if (by[it.status]) by[it.status].push(it.name); });
          const rows = [
            ['缺勤', by['缺勤'], 'tag-red'],
            ['迟到', by['迟到'], 'tag-orange'],
            ['请假', by['请假'], 'tag-blue'],
          ];
          const allGood = rows.every(([, list]) => list.length === 0);
          return `
        <div class="card" style="box-shadow:none;border:1px solid var(--border-light);margin-bottom:16px">
          <div class="card-title">异常考勤名单</div>
          ${allGood
            ? `<div class="muted" style="padding:10px 0;text-align:center">本节课全员出勤，无异常</div>`
            : rows.map(([label, list, cls]) => `
            <div class="cf-line">
              <span class="tag ${cls}">${label} ${list.length} 人</span>
              <span class="cf-names">${list.length ? esc(list.join('、')) : '<span class="muted">无</span>'}</span>
            </div>`).join('')}
        </div>`;
        })()}
        <div class="card" style="box-shadow:none;border:1px solid var(--border-light);margin-bottom:16px">
          <div class="form">
            <div class="form-item"><label>确认人姓名（任课老师）<span class="req">*</span></label>
              <input class="input" id="cfName" placeholder="请输入您的姓名" value="${esc(r.teacher || '')}" /></div>
            <div class="form-item"><label>手写签名<span class="req">*</span></label>
              <div id="cfPad"></div></div>
          </div>
        </div>
        <div class="login-err" id="cfErr" style="margin-bottom:10px"></div>
        <button class="btn btn-primary btn-block" id="cfSubmit">确认无异议，提交签名</button>
        <p class="muted small mt14" style="text-align:center">提交后系统将记录确认人与签名，如记录有误请联系班级纪律委员</p>
      </div>
    </div>`;

    const pad = createSignaturePad({});
    root.querySelector('#cfPad').appendChild(pad.el);
    const err = root.querySelector('#cfErr');
    const nameInput = root.querySelector('#cfName');

    root.querySelector('#cfSubmit').onclick = async () => {
      err.textContent = '';
      const name = nameInput.value.trim();
      if (!name) { err.textContent = '请填写确认人姓名'; return; }
      if (pad.isEmpty()) { err.textContent = '请在签名区域手写签名'; return; }
      const btn = root.querySelector('#cfSubmit');
      btn.disabled = true;
      btn.textContent = '提交中…';
      try {
        const signature = pad.toDataURL();
        const res = await fetch(`/api/confirm/${encodeURIComponent(token)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, signature }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || '提交失败');
        toast('确认成功，感谢配合');
        window.location.reload();
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
        btn.textContent = '确认无异议，提交签名';
      }
    };
  },
};
