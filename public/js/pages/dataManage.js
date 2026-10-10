// ==================== 数据管理（仅管理员）：总览 / 备份恢复 / 迁移 / 灰测留存 / 操作日志 ====================
import { api, apiDownload, setToken } from '../api.js';
import { clearUser } from '../session.js';
import { esc, ICONS, toast, confirmDialog, modal, fmtTime } from '../ui.js';

const KEY_NAMES = {
  users: '登录账号', students: '学生名单', attendance: '考勤记录',
  leaves: '假单', staffs: '教职工名单', settings: '系统设置', tokens: '登录令牌',
  appeals: '考勤异议', punishments: '处分记录',
  // 修改80：附件（签名 / 异议佐证材料）已外置为内容寻址文件，预检与总览单列一行
  attachments: '附件文件',
  // 修改72：班级管理集合
  classes: '班级管理',
};
const KEY_DOTS = { users: '#3D5CD6', students: '#24894F', attendance: '#B05E10', leaves: '#6D5BD8', staffs: '#1F7E93', settings: '#5A6484', tokens: '#C13A50', appeals: '#8A5AB5', punishments: '#B05E10', classes: '#2E7D9A' };
const KIND_NAMES = { backup: '备份', migration: '迁移包', archive: '灰测归档', 'auto-backup': '自动备份' };
const KIND_CLS = { backup: 'tag-blue', migration: 'tag-purple', archive: 'tag-orange', 'auto-backup': 'tag-cyan' };

/* 修改25：PAGE_STYLES 飞地治理——硬编码色全部换全局 token（注入机制保留，只换值不动架构） */
const PAGE_STYLES = `
  .dm-tabs { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px; }
  .dm-tab { padding:8px 18px; border:0; border-radius:999px; background:var(--surface-3); cursor:pointer; font-size:13.5px; color:var(--text-2); transition:all .15s; }
  .dm-tab:hover { background:var(--primary-light); color:var(--primary); }
  .dm-tab.on { background:var(--primary-grad); color:#fff; font-weight:600; box-shadow:0 3px 10px rgba(91,124,250,.30); }
  .dm-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); gap:12px; }
  .dm-cell { background:var(--glass-strong); border:1px solid var(--glass-stroke); border-radius:16px; padding:14px 16px; box-shadow:var(--neu-card); transition:all .15s; }
  .dm-cell:hover { box-shadow:var(--neu-hover); transform:translateY(-2px); }
  .dm-cell .k { font-size:12.5px; color:var(--text-3); display:flex; align-items:center; gap:6px; }
  .dm-cell .dot { width:8px; height:8px; border-radius:50%; display:inline-block; flex-shrink:0; }
  .dm-cell .v { font-size:22px; font-weight:700; margin:4px 0 2px; font-variant-numeric:tabular-nums; }
  .dm-cell .s { font-size:11.5px; color:var(--text-3); }
  .dm-banner { display:flex; align-items:flex-start; flex-wrap:wrap; gap:4px 10px; background:var(--info-bg); border:1px solid rgba(61,92,214,.22); color:var(--info-fg); border-radius:12px; padding:11px 14px; font-size:13px; line-height:1.6; margin-bottom:16px; }
  .dm-banner svg { flex-shrink:0; margin-top:3px; }
  /* 修改37：文本包一层可收缩容器 —— 窄屏下正常折行，不再被 flex 压成一字一列 */
  .dm-banner .dm-banner-text { flex:1 1 0; min-width:200px; }
  .dm-banner.warn { background:var(--warn-bg); border-color:rgba(176,94,16,.25); color:var(--warn-fg); }
  .dm-actions { display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-bottom:14px; }
  .dm-note { font-size:12.5px; color:var(--text-3); line-height:1.7; }
  .dm-note-running { margin-top:6px; background:var(--success-bg); border:1px solid rgba(37,137,79,.25); color:var(--success-fg); border-radius:10px; padding:8px 12px; }
  .dm-check { display:flex; justify-content:space-between; gap:12px; padding:6px 0; font-size:13px; border-bottom:1px dashed var(--border-light); }
  .dm-steps { display:grid; gap:12px; }
  .dm-step { background:var(--glass-strong); border:1px solid var(--glass-stroke); border-radius:16px; padding:14px 16px; box-shadow:var(--neu-card); }
  .dm-step .no { display:inline-block; width:22px; height:22px; border-radius:50%; background:var(--primary-grad); color:#fff; text-align:center; line-height:22px; font-size:12.5px; margin-right:8px; }
`;

function fmtSize(n) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/* 修改79：大数据包分片上传。
   背景——部署平台网关对「单条连接累计上行约 1MB」就会掐断 TLS 连接（实测同连接连发 512KB
   分片第 1 片即断、换新连接又能传，curl 表现 bad record mac），表现为「网络异常」。
   对策：①单片压到 256KB；②每片失败自动重试——连接被掐后浏览器会丢弃旧连接，重试即换新
   连接、累计清零；③超过阈值的包先切片上传，拿到 uploadId 后预检 / 恢复只传几十字节。 */
const UPLOAD_DIRECT_LIMIT = 900 * 1024; // 内联上传的安全阈值（UTF-8 字节）
const UPLOAD_CHUNK_BYTES = 256 * 1024; // 单片上限（远低于网关掐断点）
const UPLOAD_RETRY = 4; // 每片最多尝试次数（首传 + 3 次重试）

/** 按 UTF-8 字节数切分字符串：二分逼近边界，保证每片 ≤ maxBytes。
    快速路径用 maxBytes/3 字符兜底（UTF-8 每字符最多 3 字节的场景也不会超限）。 */
function splitChunks(text, maxBytes) {
  const enc = new TextEncoder();
  const out = [];
  let start = 0;
  while (start < text.length) {
    let end = text.length;
    if (end - start > Math.floor(maxBytes / 3)) {
      let low = start + 1;
      let high = start + maxBytes;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (enc.encode(text.slice(start, mid)).length <= maxBytes) low = mid;
        else high = mid - 1;
      }
      end = low;
    }
    out.push(text.slice(start, end));
    start = end;
  }
  return out;
}

export default {
  async mount(root) {
    // 样式注入 document.head（幂等）：下方 root.innerHTML 赋值会清空 root 内已有节点，样式不能挂在 root 里
    if (!document.getElementById('dmStyles')) {
      const style = document.createElement('style');
      style.id = 'dmStyles';
      style.textContent = PAGE_STYLES;
      document.head.appendChild(style);
    }

    root.innerHTML = `
      <div class="page">
        <div class="page-head"><h2>数据管理</h2></div>
        <div class="dm-tabs" id="dmTabs"></div>
        <div id="dmBody"><div class="muted small">加载中…</div></div>
      </div>`;

    const TABS = [
      { key: 'overview', label: '数据总览' },
      { key: 'backup', label: '备份与恢复' },
      { key: 'migrate', label: '迁移助手' },
      { key: 'gray', label: '灰测数据' },
      { key: 'oplog', label: '操作日志' },
    ];
    let tab = 'overview';
    const tabsEl = root.querySelector('#dmTabs');
    const bodyEl = root.querySelector('#dmBody');

    const renderTabs = () => {
      tabsEl.innerHTML = TABS.map((t) => `<button class="dm-tab ${t.key === tab ? 'on' : ''}" data-k="${t.key}">${t.label}</button>`).join('');
    };
    tabsEl.onclick = (e) => {
      const b = e.target.closest('.dm-tab');
      if (!b) return;
      tab = b.dataset.k;
      renderTabs();
      renderBody();
    };

    // ---------- 修改79：把数据包送上线可用载荷 ----------
    // 小包仍按原样内联传输；大包切片上传，返回轻量 uploadId 供后续预检 / 恢复引用。
    // 每片带自动重试：网关掐的是「连接累计上行」，连接挂掉后重试会换新连接，累计清零。
    async function postChunkWithRetry(body, attempts = UPLOAD_RETRY) {
      let lastErr;
      for (let i = 0; i < attempts; i += 1) {
        try {
          return await api('/api/data/restore/upload', { method: 'POST', body });
        } catch (e) {
          lastErr = e;
          if (e.status) throw e; // 业务错误（400/401/413 等）重试无意义，直接抛
          await new Promise((r) => setTimeout(r, 200 * (i + 1))); // 网络层失败：退避后换连接重试
        }
      }
      throw lastErr;
    }

    async function uploadBundle(bundle, onProgress) {
      const text = JSON.stringify(bundle);
      const bytes = new TextEncoder().encode(text).length;
      if (bytes <= UPLOAD_DIRECT_LIMIT) return { bundle };
      const chunks = splitChunks(text, UPLOAD_CHUNK_BYTES);
      const uploadId = `up-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      for (let i = 0; i < chunks.length; i += 1) {
        await postChunkWithRetry({ uploadId, index: i, total: chunks.length, chunk: chunks[i] });
        onProgress && onProgress(i + 1, chunks.length, bytes);
      }
      return { uploadId };
    }

    // ---------- 通用：恢复预检 + 确认弹窗 ----------
    function restoreModal(bundleOrId, onDone) {
      const hasObj = typeof bundleOrId === 'object';
      modal({
        title: '恢复数据 — 预检',
        width: 640,
        showFooter: false,
        body: `<div id="rvBody"><div class="muted small">${hasObj ? '正在上传数据包…' : '正在校验数据包…'}</div></div>`,
        onMount(wrap, close) {
          const box = wrap.querySelector('#rvBody');
          (async () => {
            const payload = hasObj
              ? await uploadBundle(bundleOrId, (done, total, bytes) => {
                  box.innerHTML = `<div class="muted small">正在上传数据包 ${done}/${total}（共 ${fmtSize(bytes)}）…</div>`;
                })
              : { id: bundleOrId };
            box.innerHTML = `<div class="muted small">正在校验数据包…</div>`;
            const r = await api('/api/data/restore/preview', { method: 'POST', body: payload });
            const m = r.bundleMeta || {};
            if (!r.ok) {
              box.innerHTML = `
                <div class="dm-banner warn">✗ 数据包校验未通过，已拒绝恢复</div>
                ${r.checks.map((c) => `<div class="dm-check"><span>${esc(KEY_NAMES[c.key] || c.key)}</span><span class="${c.ok ? 'text-ok' : 'text-bad'}">${esc(c.message)}</span></div>`).join('')}
                <div style="margin-top:14px;text-align:right"><button class="btn" data-act="closeX">关闭</button></div>`;
              box.querySelector('[data-act="closeX"]').onclick = close;
              return;
            }
            box.innerHTML = `
              <div class="dm-banner">✓ 数据包校验通过（${esc(KIND_NAMES[m.kind] || m.kind || '数据包')}${m.label ? ' · ' + esc(m.label) : ''} · 导出于 ${fmtTime(m.exportedAt)}）</div>
              ${r.checks.map((c) => `<div class="dm-check"><span>${esc(KEY_NAMES[c.key] || c.key)}</span><span class="text-ok">✓ ${c.ok ? '完整性一致' : esc(c.message)}</span></div>`).join('')}
              <div class="dm-check" style="font-weight:600;border-bottom:0"><span>集合</span><span>当前 → 恢复后</span></div>
              ${r.diff.map((d) => `<div class="dm-check"><span>${esc(KEY_NAMES[d.key] || d.key)}</span><span>${d.current} → <b>${d.incoming}</b>${d.current !== d.incoming ? ' <span class="text-warn">（变化）</span>' : ''}</span></div>`).join('')}
              <div class="dm-banner warn" style="margin-top:12px">恢复将<b>覆盖当前全部数据</b>。系统会先把当前数据自动快照（可回滚），恢复完成后需重新登录。</div>
              <div style="margin:10px 0 4px"><input class="input" id="rvConfirm" placeholder='请输入「恢复」以确认执行' autocomplete="off" /></div>
              <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:10px">
                <button class="btn" id="rvCancel">取消</button>
                <button class="btn btn-danger" id="rvOk">执行恢复</button>
              </div>`;
            box.querySelector('#rvCancel').onclick = close;
            box.querySelector('#rvOk').onclick = async () => {
              const phrase = box.querySelector('#rvConfirm').value.trim();
              if (phrase !== '恢复') return toast('请输入确认短语「恢复」', 'error');
              try {
                const rr = await api('/api/data/restore', { method: 'POST', body: { ...payload, confirm: phrase } });
                close();
                modal({
                  title: '恢复完成', width: 440, showFooter: false,
                  body: `<div class="confirm-msg">数据已恢复（恢复前快照：<b>${esc(rr.preSnapshot)}</b>）。<br/>由于登录状态随数据一同恢复，请重新登录后再继续操作。</div>
                    <div class="modal-foot" style="border-top:0"><button class="btn btn-primary" id="rvRelogin">重新登录</button></div>`,
                  onMount(w2) {
                    w2.querySelector('#rvRelogin').onclick = () => {
                      setToken('');
                      clearUser();
                      location.hash = '#/login';
                    };
                  },
                });
                onDone && onDone();
              } catch (e) {
                toast(e.message, 'error');
              }
            };
          })().catch((e) => {
            // 修改79：区分「上传被网关掐断」与「服务未启动」，避免误导排障
            const hint = e.message.startsWith('网络异常')
              ? '<div class="dm-note" style="margin-top:10px">分片上传已自动重试（每次重试会更换新连接）仍失败。请检查网络后重试；若持续失败，请按 F12 打开控制台查看具体报错并反馈，或先在原环境使用「生成迁移包」压缩数据（或清除历史签名附件）再导入。</div>'
              : '';
            wrap.querySelector('#rvBody').innerHTML = `<div class="dm-banner warn">✗ ${esc(e.message)}</div>${hint}`;
          });
        },
      });
    }

    async function doBackup(kind) {
      const labelEl = root.querySelector('#bkLabel');
      const label = labelEl ? labelEl.value.trim() : '';
      const r = await api('/api/data/backup', { method: 'POST', body: { kind, label } });
      toast(kind === 'migration' ? '迁移包已生成' : '备份已创建');
      return r.meta;
    }

    // ---------- Tab：数据总览 ----------
    async function renderOverview() {
      const d = await api('/api/data/overview');
      const gapDays = d.lastBackup ? Math.floor((Date.now() - new Date(d.lastBackup.exportedAt)) / 86400000) : null;
      bodyEl.innerHTML = `
        <div class="dm-banner ${gapDays == null || gapDays >= 7 ? 'warn' : ''}">
          ${ICONS.download}
          <span class="dm-banner-text">
          ${d.lastBackup
            ? `上次备份：${fmtTime(d.lastBackup.exportedAt)}（${d.backupCount} 份服务端快照，自动保留最近 30 份）${gapDays >= 7 ? ' — 已超过 7 天，建议立即备份' : ''}`
            : '尚未创建过任何备份 — 建议立即一键备份，防止数据丢失'}
          ${d.autoBackup && d.autoBackup.config.enabled
            ? `；<b>自动备份已开启</b>（每 ${d.autoBackup.config.intervalHours} 小时，已存 ${d.autoBackup.count} 份，下次 ${d.autoBackup.nextRunAt ? fmtTime(d.autoBackup.nextRunAt) : '—'}）`
            : '；<b>自动备份未开启</b> — 强烈建议在「备份与恢复」页开启定时自动备份'}
          </span>
        </div>
        <div class="dm-grid">
          ${d.collections.map((c) => `<div class="dm-cell"><div class="k"><i class="dot" style="background:${KEY_DOTS[c.key] || '#94a3b8'}"></i>${KEY_NAMES[c.key] || c.key}</div><div class="v">${c.count}</div><div class="s">${fmtSize(c.bytes)} · 更新于 ${fmtTime(c.mtime)}</div></div>`).join('')}
        </div>
        <div class="dm-actions" style="margin-top:16px">
          <button class="btn btn-primary" id="ovBackup">${ICONS.download} 一键备份</button>
          <button class="btn" id="ovToBackup">备份与恢复 →</button>
          ${d.grayWindow ? `<span class="tag tag-orange">灰测窗口：${esc(d.grayWindow.label)} ${d.grayWindow.start} ~ ${d.grayWindow.end}</span>` : '<span class="tag tag-gray">未配置灰测窗口</span>'}
        </div>
        <div class="card" style="margin-top:6px"><div class="card-title">最近操作</div>
          ${d.oplog.length ? d.oplog.map((o) => `<div class="dm-check"><span>${esc(o.user)} · ${esc(o.action)}</span><span class="muted small">${fmtTime(o.at)} ${esc(o.detail)}</span></div>`).join('') : '<div class="muted small">暂无操作记录</div>'}
        </div>`;
      bodyEl.querySelector('#ovBackup').onclick = async () => {
        try {
          await doBackup('backup');
          renderBody();
        } catch (e) {
          toast(e.message, 'error');
        }
      };
      bodyEl.querySelector('#ovToBackup').onclick = () => {
        tab = 'backup';
        renderTabs();
        renderBody();
      };
    }

    // ---------- Tab：备份与恢复 ----------
    async function renderBackup() {
      const d = await api('/api/data/bundles');
      const ab = await api('/api/data/autobackup').catch(() => null);
      bodyEl.innerHTML = `
        ${ab ? `
        <div class="card">
          <div class="card-title">定时自动备份</div>
          <div class="dm-actions">
            <label class="dm-note" style="display:flex;align-items:center;gap:6px;font-size:13.5px"><input type="checkbox" id="abOn" ${ab.config.enabled ? 'checked' : ''} style="width:16px;height:16px" /> 开启自动备份</label>
            <select class="select" id="abEvery" style="max-width:150px">${ab.intervals.map((h) => `<option value="${h}" ${ab.config.intervalHours === h ? 'selected' : ''}>每 ${h} 小时</option>`).join('')}</select>
            <span class="dm-note">保留</span><input class="input" type="number" id="abKeep" min="3" max="30" value="${ab.config.keep}" style="max-width:80px" /><span class="dm-note">份</span>
            <button class="btn btn-primary btn-sm" id="abSave">保存设置</button>
            <button class="btn btn-sm" id="abRun">${ICONS.download} 立即备份一次</button>
          </div>
          <div class="dm-note">开启后系统按间隔自动把全部数据（名单 / 考勤 / 假单 / 账号 / 设置）做成带 sha256 校验的数据包存入服务器 data/auto-backups/，只保留最近若干份；数据无变化时自动跳过，不产生重复包。可在下方列表中下载或恢复（类型为「自动备份」）。注意：自动备份防的是应用内误操作，<b>防不住服务器整盘丢失</b>，重要节点仍请「下载」一份数据包离机保存。</div>
          ${ab.config.enabled ? `<div class="dm-note dm-note-running">✓ 运行中 · 间隔 ${ab.config.intervalHours} 小时 · 上次运行 ${ab.config.lastRunAt ? fmtTime(ab.config.lastRunAt) : '尚未运行'} · 下次运行 ${ab.nextRunAt ? fmtTime(ab.nextRunAt) : '—'} · 已存 ${ab.count} 份</div>` : ''}
        </div>` : ''}        <div class="card">
          <div class="card-title">创建备份 / 迁移包</div>
          <div class="dm-actions">
            <input class="input" id="bkLabel" placeholder="备注标签（可选，如：上线前留底）" style="max-width:260px" />
            <button class="btn btn-primary" id="bkNew">${ICONS.download} 创建备份</button>
            <button class="btn" id="bkMigrate">${ICONS.upload} 生成迁移包并下载</button>
          </div>
          <div class="dm-note">备份保留在服务器 data/backups/（自动保留最近 30 份）；迁移包生成后立即下载，用于在其他服务器导入。灰测归档请前往「灰测数据」页。</div>
        </div>
        <div class="card">
          <div class="card-title">恢复数据</div>
          <div class="dm-actions">
            <label class="btn btn-sm file-pick">${ICONS.upload} 上传数据包文件预检并恢复<input type="file" accept=".json" hidden id="bkFile" /></label>
            <span class="dm-note">或点击下方列表中的「恢复」。所有恢复均先校验 sha256 清单，并自动快照当前数据。</span>
          </div>
        </div>
        <div class="card">
          <div class="card-title">数据包列表（服务器端保留 ${d.list.length} 份）</div>
          <div class="table-wrap"><table class="table" data-card="t,g,-,n,x">
            <thead><tr><th>时间</th><th>类型</th><th>标签</th><th>大小</th><th>操作</th></tr></thead>
            <tbody>${d.list.length ? d.list.map((b) => `
              <tr>
                <td>${fmtTime(b.exportedAt)}</td>
                <td><span class="tag ${KIND_CLS[b.kind] || 'tag-gray'}">${KIND_NAMES[b.kind] || b.kind}</span></td>
                <td>${esc(b.label || '—')}</td>
                <td>${fmtSize(b.size)}</td>
                <td>
                  <button class="btn-text" data-act="dl" data-id="${esc(b.id)}" data-file="${esc(b.file || b.id + '.zip')}">下载</button>
                  <button class="btn-text" data-act="rs" data-id="${esc(b.id)}">恢复</button>
                </td>
              </tr>`).join('') : '<tr><td colspan="5" class="table-empty">暂无数据包，先创建一份备份</td></tr>'}
            </tbody></table></div>
        </div>`;
      bodyEl.querySelector('#bkNew').onclick = async () => {
        try {
          await doBackup('backup');
          renderBody();
        } catch (e) {
          toast(e.message, 'error');
        }
      };
      bodyEl.querySelector('#bkMigrate').onclick = async () => {
        try {
          const meta = await doBackup('migration');
          await apiDownload(`/api/data/bundles/${encodeURIComponent(meta.id)}/download`, meta.file || `${meta.id}.zip`); // 修改80：文件名取服务端 meta.file（zip 自包含附件）
          renderBody();
        } catch (e) {
          toast(e.message, 'error');
        }
      };
      const abSave = bodyEl.querySelector('#abSave');
      if (abSave) {
        abSave.onclick = async () => {
          try {
            const r = await api('/api/data/autobackup', {
              method: 'POST',
              body: {
                enabled: bodyEl.querySelector('#abOn').checked,
                intervalHours: Number(bodyEl.querySelector('#abEvery').value),
                keep: Number(bodyEl.querySelector('#abKeep').value),
              },
            });
            toast(r.config.enabled ? `自动备份已开启：每 ${r.config.intervalHours} 小时一次` : '自动备份已关闭');
            renderBody();
          } catch (e) {
            toast(e.message, 'error');
          }
        };
        bodyEl.querySelector('#abRun').onclick = async () => {
          try {
            const r = await api('/api/data/autobackup/run', { method: 'POST', body: {} });
            toast(r.meta ? `已生成 ${r.meta.id}` : '数据无变化，未生成新包');
            renderBody();
          } catch (e) {
            toast(e.message, 'error');
          }
        };
      }
      bodyEl.querySelector('#bkFile').onchange = async (e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        try {
          const bundle = JSON.parse(await file.text());
          restoreModal(bundle, renderBody);
        } catch (err) {
          toast(`文件解析失败：${err.message}`, 'error');
        }
      };
      bodyEl.querySelectorAll('[data-act="dl"]').forEach((b) => {
        b.onclick = () => apiDownload(`/api/data/bundles/${encodeURIComponent(b.dataset.id)}/download`, b.dataset.file || `${b.dataset.id}.zip`).catch((err) => toast(err.message, 'error'));
      });
      bodyEl.querySelectorAll('[data-act="rs"]').forEach((b) => {
        b.onclick = () => restoreModal(b.dataset.id, renderBody);
      });
    }

    // ---------- Tab：迁移助手 ----------
    function renderMigrate() {
      bodyEl.innerHTML = `
        <div class="dm-steps">
          <div class="dm-step"><span class="no">1</span><b>旧服务器：生成迁移包</b>
            <div class="dm-note">点击下方按钮生成带 sha256 校验清单的迁移包并立即下载（.zip，含全部附件图片，导入新服务器后附件随包落盘、无需另行拷贝）。建议同时保留一份常规备份。</div>
            <div class="dm-actions" style="margin-top:10px"><button class="btn btn-primary" id="mgGo">${ICONS.download} 生成迁移包并下载</button></div>
          </div>
          <div class="dm-step"><span class="no">2</span><b>新服务器：部署同版本代码并导入</b>
            <div class="dm-note">在新服务器部署相同版本的工作台代码（空库启动），以管理员登录后进入「数据管理 → 备份与恢复」，上传本迁移包（.zip）→ 预检（自动逐集合 sha256 校验 + 附件逐个核对 + 条数对比）→ 输入确认短语执行恢复。迁移包为新格式（zip），需修改80 及以上版本导入。</div>
          </div>
          <div class="dm-step"><span class="no">3</span><b>一致性校验与切换</b>
            <div class="dm-note">恢复完成后逐项核对：<br/>
            ① 管理员可登录（密码为迁移包内账号数据）；<br/>
            ② 「数据总览」各集合条数与迁移包一致（附件文件一行会显示恢复后的图片数量）；<br/>
            ③ 抽查最近一条考勤记录与任课老师确认链接可正常打开；<br/>
            ④ 全部通过后切换访问入口；旧服务器转只读冻结建议 ≥ 7 天，作为最终回滚保底。</div>
          </div>
          <div class="dm-step"><span class="no">↩</span><b>回滚预案</b>
            <div class="dm-note">新服执行恢复前会自动生成 pre-restore 快照；如需回滚：新服用该快照恢复即可回到导入前状态；旧服务器数据冻结未动，随时可切回。校验不通过的数据包会被拒绝落盘，不会污染新服。</div>
          </div>
        </div>`;
      bodyEl.querySelector('#mgGo').onclick = async () => {
        try {
          const meta = await doBackup('migration');
          await apiDownload(`/api/data/bundles/${encodeURIComponent(meta.id)}/download`, meta.file || `${meta.id}.zip`);
        } catch (e) {
          toast(e.message, 'error');
        }
      };
    }

    // ---------- Tab：灰测数据 ----------
    async function renderGray() {
      const d = await api('/api/data/gray/summary');
      const w = d.grayWindow;
      bodyEl.innerHTML = `
        <div class="card">
          <div class="card-title">灰测时间窗口</div>
          <div class="dm-actions">
            <input class="input" type="date" id="gwStart" value="${w ? w.start : ''}" style="max-width:160px" />
            <span class="dm-note">至</span>
            <input class="input" type="date" id="gwEnd" value="${w ? w.end : ''}" style="max-width:160px" />
            <input class="input" id="gwLabel" value="${w ? esc(w.label) : ''}" placeholder="窗口名称（如：一期灰测）" style="max-width:160px" />
            <button class="btn btn-primary btn-sm" id="gwSave">保存窗口</button>
          </div>
          <div class="dm-note">窗口内创建的考勤 / 假单 / 名单自动判定为灰测数据；可追溯标记存量数据，无需修改历史记录。</div>
        </div>
        ${w && d.summary ? `
        <div class="dm-grid" style="margin-top:14px">
          <div class="dm-cell"><div class="k">灰测考勤记录</div><div class="v">${d.summary.attendance}</div></div>
          <div class="dm-cell"><div class="k">灰测假单</div><div class="v">${d.summary.leaves}</div></div>
          <div class="dm-cell"><div class="k">灰测期间新增学生</div><div class="v">${d.summary.students}</div></div>
        </div>
        <div class="card" style="margin-top:14px">
          <div class="card-title">灰测数据查询（只读）</div>
          <div class="dm-actions">
            <select class="select" id="gqType"><option value="attendance">考勤记录</option><option value="leaves">假单</option></select>
            <input class="input" id="gqClass" placeholder="班级（可空）" style="max-width:150px" />
            <select class="select" id="gqStatus"><option value="">全部状态</option>${['出勤', '迟到', '缺勤', '请假', '待生效', '已生效'].map((s) => `<option value="${s}">${s}</option>`).join('')}</select>
            <button class="btn btn-sm" id="gqGo">${ICONS.search} 查询</button>
            <button class="btn btn-sm" id="gqArchive">${ICONS.download} 归档留底</button>
          </div>
          <div id="gqResult"><div class="muted small">选择条件后点击查询</div></div>
          <div class="dm-note" style="margin-top:10px">「归档留底」会把主库<b>完整快照</b>存入只读归档区（带校验清单、只能下载不能删除），主库数据不受影响；灰测数据永不因归档而删除。归档后建议下载数据包离机保存。</div>
        </div>` : `<div class="dm-banner warn" style="margin-top:14px">尚未配置灰测窗口，配置后即可查看灰测数据概况与查询入口。</div>`}
      `;
      bodyEl.querySelector('#gwSave').onclick = async () => {
        try {
          await api('/api/data/gray/window', {
            method: 'POST',
            body: { start: bodyEl.querySelector('#gwStart').value, end: bodyEl.querySelector('#gwEnd').value, label: bodyEl.querySelector('#gwLabel').value },
          });
          toast('灰测窗口已保存');
          renderGray();
        } catch (e) {
          toast(e.message, 'error');
        }
      };
      const gqGo = bodyEl.querySelector('#gqGo');
      if (gqGo) {
        gqGo.onclick = async () => {
          const box = bodyEl.querySelector('#gqResult');
          const params = new URLSearchParams({
            type: bodyEl.querySelector('#gqType').value,
            className: bodyEl.querySelector('#gqClass').value.trim(),
            status: bodyEl.querySelector('#gqStatus').value,
          });
          try {
            const r = await api(`/api/data/gray/query?${params}`);
            if (!r.total) {
              box.innerHTML = '<div class="muted small">窗口内没有符合条件的数据</div>';
              return;
            }
            if (params.get('type') === 'attendance') {
              box.innerHTML = `<div class="muted small" style="margin-bottom:6px">共 ${r.total} 条${r.total > r.list.length ? '，仅显示前 200 条' : ''}</div>
                <div class="table-wrap"><table class="table" data-card="t,s,g,b,m,-"><thead><tr><th>日期</th><th>班级</th><th>节次</th><th>课程</th><th>出勤情况</th><th>点名</th></tr></thead><tbody>
                ${r.list.map((s) => `<tr><td>${esc(s.date)}</td><td>${esc(s.className)}</td><td>${(s.periods || []).join('/')}</td><td>${esc(s.courseName)}</td>
                  <td>出勤 ${s.counts['出勤'] || 0} · 迟到 ${s.counts['迟到'] || 0} · 缺勤 ${s.counts['缺勤'] || 0} · 请假 ${s.counts['请假'] || 0}</td>
                  <td class="muted small">${esc(s.createdBy || '')}</td></tr>`).join('')}</tbody></table></div>`;
            } else {
              box.innerHTML = `<div class="muted small" style="margin-bottom:6px">共 ${r.total} 条${r.total > r.list.length ? '，仅显示前 200 条' : ''}</div>
                <div class="table-wrap"><table class="table" data-card="t,s,g,n,d"><thead><tr><th>学生</th><th>班级</th><th>类型</th><th>起止</th><th>状态</th></tr></thead><tbody>
                ${r.list.map((l) => `<tr><td>${esc(l.studentName)}（${esc(l.studentId)}）</td><td>${esc(l.className)}</td><td>${esc(l.type)}</td>
                  <td>${esc(l.startDate)} ~ ${esc(l.endDate)}</td><td><span class="tag ${l.status === '已生效' ? 'tag-green' : 'tag-gray'}">${esc(l.status)}</span></td></tr>`).join('')}</tbody></table></div>`;
            }
          } catch (e) {
            box.innerHTML = `<div class="muted small">${esc(e.message)}</div>`;
          }
        };
        bodyEl.querySelector('#gqArchive').onclick = async () => {
          const ok = await confirmDialog('将在只读归档区生成主库完整留底快照（不影响现有数据，归档不可删除）。继续？', { title: '灰测归档留底' });
          if (!ok) return;
          try {
            await api('/api/data/gray/archive', { method: 'POST', body: {} });
            toast('归档完成，可在「备份与恢复」列表中下载');
          } catch (e) {
            toast(e.message, 'error');
          }
        };
      }
    }

    // ---------- Tab：操作日志 ----------
    async function renderOplog() {
      const d = await api('/api/data/oplog');
      bodyEl.innerHTML = `
        <div class="card"><div class="card-title">数据操作日志（最近 ${d.list.length} / 共 ${d.total} 条）</div>
          <div class="table-wrap"><table class="table" data-card="t,s,g,m">
            <thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>详情</th></tr></thead>
            <tbody>${d.list.length ? d.list.map((o) => `<tr><td>${fmtTime(o.at)}</td><td>${esc(o.user)}</td><td>${esc(o.action)}</td><td class="muted small">${esc(o.detail)}</td></tr>`).join('') : '<tr><td colspan="4" class="table-empty">暂无记录</td></tr>'}
            </tbody></table></div>
        </div>`;
    }

    async function renderBody() {
      bodyEl.innerHTML = '<div class="muted small">加载中…</div>';
      try {
        if (tab === 'overview') await renderOverview();
        else if (tab === 'backup') await renderBackup();
        else if (tab === 'migrate') renderMigrate();
        else if (tab === 'gray') await renderGray();
        else await renderOplog();
      } catch (e) {
        bodyEl.innerHTML = `<div class="card empty-card">加载失败：${esc(e.message)}</div>`;
      }
    }

    renderTabs();
    await renderBody();
  },
};
