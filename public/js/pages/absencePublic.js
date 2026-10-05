import { api, apiPostDownload } from '../api.js';
import { getUser, hasAnyRole } from '../session.js';
import { esc, ICONS, toast, modal, confirmDialog, enhanceTables, fmtTime, punishmentTagCls, upgradeSelectToCombo } from '../ui.js';

// ===== 修改29：照片自动压缩（修复手机原图 2~8MB / HEIC 静默上传失败）=====
const TARGET_BYTES = 900 * 1024; // 目标大小：压缩至 ≤900KB（直通阈值同值）
const HARD_BYTES = 1024 * 1024; // 兜底上限：全梯压缩后仍 >900KB 时接受 ≤1MB
const DIM_LADDER = [1600, 1200, 900]; // 维度梯：长边上限逐档缩小
const QUALITY_LADDER = [0.85, 0.7, 0.5]; // 质量梯：JPEG 质量逐档下降

// 能力探测：具备 createImageBitmap + canvas 2d 才走压缩路径，否则小图直通 / 大图明确报错
function detectDecodeCapable() {
  try {
    if (typeof createImageBitmap !== 'function') return false;
    if (typeof document === 'undefined') return false;
    return !!document.createElement('canvas').getContext;
  } catch {
    return false;
  }
}

function mbOf(size) {
  return (size / 1024 / 1024).toFixed(1) + 'MB';
}

function readAsDataURL(file, FR) {
  return new Promise((resolve, reject) => {
    const fr = new FR();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('读取图片失败'));
    fr.readAsDataURL(file);
  });
}

// 真实编码路径（仅浏览器）：canvas 等比绘制 + JPEG 编码 → { size, dataUrl }
function canvasEncode(src, w, h, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(src, 0, 0, w, h);
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) return reject(new Error('图片编码失败'));
      try {
        resolve({ size: blob.size, dataUrl: await readAsDataURL(blob, FileReader) });
      } catch (e2) {
        reject(e2);
      }
    }, 'image/jpeg', quality);
  });
}

// 解码图片（EXIF 纠偏防 iPhone 横竖颠倒；createImageBitmap 失败降级 Image + objectURL）
async function decodeSource(file, cib) {
  try {
    return await cib(file, { imageOrientation: 'from-image' });
  } catch {
    /* 降级 Image 路径 */
  }
  if (typeof URL === 'undefined' || !URL.createObjectURL) throw new Error('decode-failed');
  const objUrl = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('decode-failed'));
      im.src = objUrl;
    });
  } finally {
    try {
      URL.revokeObjectURL(objUrl);
    } catch {
      /* ignore */
    }
  }
}

/**
 * 压缩单张图片为 ≤900KB 的 dataUrl（修改29）。
 * deps（测试接缝）：{ canDecode, createImageBitmap, encode(src,w,h,q)→{size,dataUrl}, FileReader }
 * 返回 { name, dataUrl, compressed }；失败抛 Error（文案可直接展示给用户）。
 * 处理矩阵：小图直通 / HEIC 转码 / canvas 降质循环（维度×质量取首个达标）/ 末档 ≤1MB 兜底。
 */
async function compressImage(file, deps = {}) {
  const type = String(file.type || '').toLowerCase();
  const isStd = /^image\/(jpeg|png|webp)$/.test(type);
  const size = file.size || 0;
  const name = String(file.name || '图片').slice(0, 50);

  // ① 小图 + 标准格式：FileReader 直通（jsdom / 老浏览器兜底）
  if (isStd && size <= TARGET_BYTES) {
    const FR = deps.FileReader || FileReader;
    if (!FR) throw new Error(`「${name}」当前环境不支持读取图片`);
    return { name, dataUrl: await readAsDataURL(file, FR), compressed: false };
  }

  // ② 无解码能力：明确报错，绝不静默
  const canDecode = 'canDecode' in deps ? !!deps.canDecode : detectDecodeCapable();
  if (!canDecode) {
    if (!isStd) throw new Error(`「${name}」该图片格式不支持，请改用 JPG 或截图后上传`);
    throw new Error(`「${name}」图片过大（${mbOf(size)}），请截图后上传`);
  }

  // ③ 解码（EXIF 纠偏），失败按格式/大小给出对应文案
  const cib = deps.createImageBitmap || createImageBitmap;
  let src;
  try {
    src = await decodeSource(file, cib);
  } catch {
    if (!isStd) throw new Error(`「${name}」该图片格式不支持，请改用 JPG 或截图后上传`);
    throw new Error(`「${name}」图片处理失败，请截图后上传`);
  }

  // ④ 维度×质量降质循环：取首个 ≤900KB；全梯跑完取末档 ≤1MB 兜底
  try {
    const iw = src.width || 0;
    const ih = src.height || 0;
    if (!iw || !ih) throw new Error(`「${name}」图片处理失败，请截图后上传`);
    const encode = deps.encode || canvasEncode;
    let last = null;
    for (const edge of DIM_LADDER) {
      const scale = Math.min(1, edge / Math.max(iw, ih));
      const w = Math.max(1, Math.round(iw * scale));
      const h = Math.max(1, Math.round(ih * scale));
      for (const q of QUALITY_LADDER) {
        const out = await encode(src, w, h, q);
        if (out && out.size <= TARGET_BYTES) return { name, dataUrl: out.dataUrl, compressed: true };
        last = out;
      }
    }
    if (last && last.size <= HARD_BYTES) return { name, dataUrl: last.dataUrl, compressed: true };
    throw new Error(`「${name}」图片过大，压缩后仍超过 1MB，请截图后上传`);
  } finally {
    if (src && typeof src.close === 'function') {
      try {
        src.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 缺勤公示页（公开路由 #/absence，免登录）
 * ① 学生自查：班级+学号+姓名 三要素查询本学年累计缺勤次数 / 缺勤节数 / 迟到次数 + 时间线明细
 * ② 班级公示榜：按缺勤节数降序的班级统计表
 * 附加：登录用户具有 admin / rights / collegeOfficer 角色时可导出公示表；admin 可配置学期起止
 * 挂载环境自适应：登录态经左侧导航进入时挂在 #view（工作台布局内）；学生免登录直接访问时独立成页
 */
// 测试接缝：compressImage 供前端测试单测（deps 注入），业务代码仍走内部引用
export { compressImage };

export default {
  async mount(root) {
    root.innerHTML = `<div class="muted" style="padding:40px;text-align:center">加载中…</div>`;
    const inLayout = root.id === 'view';

    let meta;
    try {
      meta = await api('/api/public/absence/meta');
    } catch (e) {
      root.innerHTML = inLayout
        ? `<div class="page"><div class="card empty-card">加载失败：${esc(e.message)}</div></div>`
        : `
      <div class="login-wrap">
        <div class="login-card" style="max-width:440px;text-align:center">
          <div class="login-logo"><span class="brand-icon">${ICONS.logo}</span></div>
          <h1 style="font-size:19px">加载失败</h1>
          <p class="login-sub">${esc(e.message)}</p>
        </div>
      </div>`;
      return;
    }

    const user = getUser();
    const canExport = user && hasAnyRole(user, ['admin', 'rights', 'collegeOfficer']);
    const isAdmin = user && hasAnyRole(user, ['admin']);
    // 修改21：公示榜「详情」按钮能力位（班主任/辅导员/学院考勤负责人/权益部/管理员；接口层同步校验）
    const canDetail = user && hasAnyRole(user, ['admin', 'rights', 'headTeacher', 'counselor', 'collegeOfficer']);

    const state = { term: 'all', tab: 'query', sel: new Set(), mine: [], lastQuery: null, lastRecords: null };
    // 学生自查分享链接：固定根路径最短形式（应用为根路径部署的 SPA），
    // 不沿用地址栏路径——即使用户带着垃圾路径打开页面，复制的也是干净最短链接
    const shareUrl = `${location.origin}/#/absence`;

    const termBtn = (key, label) =>
      `<button class="seg-btn sg-blue abs-term-btn ${state.term === key ? 'on' : ''}" data-term="${key}">${esc(label)}</button>`;

    const headerHtml = inLayout
      ? `<div class="page-head"><h2>缺勤公示</h2><p class="page-desc">${esc(meta.schoolYear.label)} · 学生免登录查询累计缺勤次数、缺勤节数与迟到记录；公示数据截至当日</p></div>`
      : `<div class="login-logo"><span class="brand-icon">${ICONS.logo}</span></div>
        <h1 style="font-size:19px">考勤公示 · ${esc(meta.schoolYear.label)}</h1>
        <p class="login-sub">学生可免登录查询本学年累计缺勤次数、缺勤节数与迟到记录；公示数据截至当日</p>`;

    const bodyHtml = `
        <div class="abs-toolbar">
          <div class="tabs" id="absTabs">
            <button class="tab-btn active" data-tab="query">缺勤自查</button>
            <button class="tab-btn" data-tab="board">班级公示榜</button>
          </div>
          <div class="seg abs-seg" id="absTermSeg">
            ${termBtn('all', '全学年')}
            ${termBtn('0', meta.terms[0].name)}
            ${termBtn('1', meta.terms[1].name)}
          </div>
        </div>
        <div class="abs-term-range" id="absTermRange"></div>
        <details class="abs-rules" open>
          <summary>缺勤节数是怎么计算的？（点击可折叠）</summary>
          <div class="abs-rules-body">
            <ul>
              <li><b>缺勤按节次权重累计</b>：<b>1-2节 / 3-4节 / 5-6节 / 7-8节 / 9-10节</b> 缺勤一次记 <b>2 节</b>；<b>早自习 / 晚自习</b> 缺勤一次记 <b>1 节</b>。</li>
              <li><b>迟到每次折 0.5 节</b>，并入缺勤节数（与当次点名覆盖几个节次无关，迟到一次就是 0.5 节）。</li>
              <li><b>缺勤次数按点名记录计</b>：一条记录缺勤记 1 次；迟到不计入缺勤次数，单独按"次"统计。</li>
              <li><b>举例</b>：早自习缺勤 1 次（1 节）+ 1-2节缺勤 1 次（2 节）+ 迟到 1 次（0.5 节），累计为：缺勤 2 次、缺勤节数 3.5 节、迟到 1 次。</li>
              <li>数据随每次点名实时更新；如对数据有疑问，请联系班级纪律委员核实。</li>
            </ul>
          </div>
        </details>${
          inLayout && user
            ? `
        <div class="abs-share" id="absShare">
          <span class="abs-share-label">学生自查链接：</span>
          <input class="input abs-share-url" id="absShareUrl" readonly value="${esc(shareUrl)}" onclick="this.select()" />
          <button class="btn btn-primary abs-share-btn" id="absCopyBtn">复制链接</button>
          <span class="muted small abs-share-tip">发到班级群，学生打开后选班级、输学号姓名即可免登录自查</span>
        </div>`
            : ''
        }`;

    const panelsHtml = `
        <!-- ① 缺勤自查 -->
        <div id="absQueryPanel">
          <div class="card abs-card">
            <div class="abs-form">
              <div class="form-item"><label>班级<span class="req">*</span></label>
                <select class="input" id="absClass">
                  <option value="">请选择班级</option>
                  ${meta.classes.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
                </select></div>
              <div class="form-item"><label>学号<span class="req">*</span></label>
                <input class="input" id="absSid" placeholder="请输入学号" maxlength="20" /></div>
              <div class="form-item"><label>姓名<span class="req">*</span></label>
                <input class="input" id="absName" placeholder="请输入姓名" maxlength="20" /></div>
              <div class="form-item abs-btn-item"><label>&nbsp;</label>
                <button class="btn btn-primary" id="absQueryBtn">查询</button></div>
            </div>
            <div class="login-err" id="absErr"></div>
          </div>
          <div id="absResult"></div>
        </div>

        <!-- ② 班级公示榜 -->
        <div id="absBoardPanel" style="display:none">
          <div class="card abs-card">
            <div class="abs-form">
              <div class="form-item"><label>班级<span class="req">*</span></label>
                <select class="input" id="absBoardClass">
                  <option value="">请选择班级</option>
                  ${meta.classes.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
                </select></div>
              <div class="form-item abs-btn-item"><label>&nbsp;</label>
                <button class="btn btn-primary" id="absBoardBtn">查看公示榜</button></div>
              ${canExport ? `<div class="form-item abs-btn-item"><label>&nbsp;</label>
                <button class="btn" id="absExportBtn">${ICONS.download || ''}导出公示表</button></div>` : ''}
              ${isAdmin ? `<div class="form-item abs-btn-item"><label>&nbsp;</label>
                <button class="btn" id="absTermCfgBtn">学期设置</button></div>` : ''}
            </div>
            <div class="login-err" id="absBoardErr"></div>
          </div>
          <div id="absBoardResult"></div>
        </div>

        <p class="muted small abs-foot">统计口径详见页面顶部「缺勤节数是怎么计算的？」规则说明；如对数据有疑问，请联系班级纪律委员。</p>`;

    root.innerHTML = inLayout
      ? `<div class="page">${headerHtml}${bodyHtml}${panelsHtml}</div>`
      : `<div class="login-wrap" style="align-items:flex-start;padding:24px 16px"><div class="login-card" style="max-width:860px;width:100%">${headerHtml}${bodyHtml}${panelsHtml}</div></div>`;

    const $ = (sel) => root.querySelector(sel);

    // ---------- 学期切换 ----------
    function renderTermRange() {
      const t =
        state.term === 'all'
          ? { name: '全学年', start: meta.schoolYear.start, end: meta.schoolYear.end }
          : meta.terms[state.term === '0' ? 0 : 1];
      $('#absTermRange').textContent = `统计区间：${t.start} ~ ${t.end}`;
    }
    // 修改65：自查（#absClass）与公示榜（#absBoardClass）班级筛选升级为可搜索组合框。
    // input 迁移原 id → 下方各处 $('#absClass').value / $('#absBoardClass').value 读值零改动。
    upgradeSelectToCombo(root.querySelector('#absClass'));
    upgradeSelectToCombo(root.querySelector('#absBoardClass'));
    $('#absTermSeg').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-term]');
      if (!btn) return;
      state.term = btn.dataset.term;
      root.querySelectorAll('.abs-term-btn').forEach((b) => b.classList.toggle('on', b.dataset.term === state.term));
      renderTermRange();
      // 已有结果时按新区间重新查询
      if (state.tab === 'board' && $('#absBoardClass').value) queryBoard();
      if (state.tab === 'query' && $('#absResult').dataset.done === '1') queryStudent();
    });
    renderTermRange();

    // ---------- Tab 切换 ----------
    $('#absTabs').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tab]');
      if (!btn) return;
      state.tab = btn.dataset.tab;
      root.querySelectorAll('#absTabs .tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
      $('#absQueryPanel').style.display = state.tab === 'query' ? '' : 'none';
      $('#absBoardPanel').style.display = state.tab === 'board' ? '' : 'none';
    });

    // ---------- ① 学生自查 ----------
    function statusTagCls(status) {
      return status === '缺勤' ? 'tag-red' : status === '迟到' ? 'tag-orange' : 'tag-blue';
    }
    function renderRecords(records) {
      if (!records.length) {
        return `<div class="card abs-card" data-card="records"><div class="abs-empty">${ICONS.check} 本区间无缺勤 / 迟到记录，继续保持！</div></div>`;
      }
      // 修改27：已在处理中（待审核/已通过未办结）的记录禁止再提异议（服务端同口径 409）
      const busySids = new Set(
        state.mine.filter((a) => a.status === 'pending' || a.status === 'approved').flatMap((a) => a.records.map((r) => r.sessionId))
      );
      // 选择态与当前记录集求交集（换学期区间后失效的勾选自动剔除）
      const visibleSids = new Set(records.map((r) => r.sessionId));
      [...state.sel].forEach((sid) => { if (!visibleSids.has(sid)) state.sel.delete(sid); });
      const items = records
        .map(
          (r) => {
            const busy = busySids.has(r.sessionId);
            return `
          <div class="abs-tl-item">
            <div class="abs-tl-check">
              ${busy
                ? `<span class="tag tag-blue" title="该记录已有处理中的异议">处理中</span>`
                : `<input type="checkbox" class="abs-rec-check" data-sid="${esc(r.sessionId)}" ${state.sel.has(r.sessionId) ? 'checked' : ''} aria-label="选择该记录提交异议" />`}
            </div>
            <div class="abs-tl-dot ${r.status === '缺勤' ? 'dot-red' : 'dot-orange'}"></div>
            <div class="abs-tl-body">
              <div class="abs-tl-head">
                <b>${esc(r.date)}</b><span class="muted">（${esc(r.weekday)}）</span>
                <span class="tag ${statusTagCls(r.status)}">${esc(r.status)}</span>
                ${r.status === '缺勤' ? `<span class="abs-jie">缺 ${r.jie} 节</span>` : r.status === '迟到' ? `<span class="abs-jie is-late">迟到折 ${r.jie} 节</span>` : ''}
              </div>
              <div class="abs-tl-sub">
                ${r.times.map((t) => `<span class="tag tag-purple">${esc(t.period)}</span> ${esc(t.start)}~${esc(t.end)}`).join('　')}
              </div>
              <div class="abs-tl-sub">课程：${esc(r.courseName)}${r.teacher ? ` · 任课老师：${esc(r.teacher)}` : ''}${r.note ? ` · 备注：${esc(r.note)}` : ''}</div>
            </div>
          </div>`;
          }
        )
        .join('');
      return `
      <div class="card abs-card" data-card="records">
        <div class="card-title">缺勤 / 迟到明细（${records.length} 条，按日期倒序）</div>
        <div class="abs-timeline" style="max-height:55vh;overflow-y:auto">${items}</div>
        <div class="abs-sel-bar">
          <label class="abs-sel-all"><input type="checkbox" id="absSelAll" ${records.every((r) => state.sel.has(r.sessionId) || busySids.has(r.sessionId)) && records.length ? 'checked' : ''} /> 全选</label>
          <button class="btn btn-primary" id="absAppealBtn" ${state.sel.size ? '' : 'disabled'}>提交异议（已选 ${state.sel.size} 条）</button>
          <span class="muted small">勾选存在异议的记录，填写理由并上传佐证材料，由权益部 / 学院考勤负责老师审核判定</span>
        </div>
      </div>`;
    }
    // 修改30：处分情况块 —— 展示生效中的最高处分（存在多级时取最高）+ 全部生效等级
    // 修改31：视觉重构 —— 左侧等级徽章（色随档位）+ 右侧等级名主从结构；说明区分隔弱化；无处分改正向绿色反馈
    function pmBadgeCls(levelIndex) {
      if (levelIndex >= 4) return 'pm-b-red';
      if (levelIndex >= 2) return 'pm-b-orange';
      return 'pm-b-gray';
    }
    function renderPunishment(punish) {
      if (!punish) return '';
      if (!punish.top) {
        return `
        <div class="card abs-card pm-card" data-card="punish">
          <div class="pm-row">
            <div class="pm-badge pm-b-ok">${ICONS.shield}</div>
            <div class="pm-main">
              <span class="pm-kicker">处分情况</span>
              <span class="pm-level pm-level-ok">暂无处分记录</span>
              <span class="pm-meta">当前累计缺勤 ${punish.totalJie} 节 · 累计缺勤达 0.5 节起将按规则自动生成处分（迟到每次折 0.5 节一并计入）</span>
            </div>
          </div>
        </div>`;
      }
      const lvRow = (punish.levels || [])
        .map((l) => `<span class="tag ${punishmentTagCls(l.levelIndex)}">${esc(l.level)}</span>`)
        .join(' ');
      const firstJie = punish.top.firstJie != null ? punish.top.firstJie : '';
      return `
      <div class="card abs-card pm-card" data-card="punish">
        <div class="pm-row">
          <div class="pm-badge ${pmBadgeCls(punish.top.levelIndex)}">${ICONS.gavel}</div>
          <div class="pm-main">
            <span class="pm-kicker">最高处分等级</span>
            <span class="pm-level">${esc(punish.top.level)}</span>
            <span class="pm-meta">首次达到 ${firstJie} 节时认定（${fmtTime(punish.top.createdAt)}）</span>
            ${(punish.levels || []).length > 1 ? `<span class="pm-meta">同时生效：${lvRow}</span>` : ''}
          </div>
        </div>
        <div class="pm-note">处分按累计缺勤节数自动认定（缺勤按节次权重、迟到每次折 0.5 节一并计入），认定节数取首次达到该等级区间下限时的节数；截止目前累计缺勤 <b>${punish.totalJie}</b> 节。如对考勤记录有异议，可在下方明细中勾选记录提交异议，经审核改判后处分将自动同步撤销/更新。</div>
      </div>`;
    }
    function renderResult(d) {
      $('#absResult').innerHTML = `
      <div class="stat-cards abs-stat">
        <div class="stat-card"><div class="stat-icon si-red">${ICONS.list}</div><div><div class="stat-value">${d.stats.absenceCount}</div><div class="stat-label">累计缺勤次数</div></div></div>
        <div class="stat-card"><div class="stat-icon si-purple">${ICONS.book}</div><div><div class="stat-value">${d.stats.absencePeriods}</div><div class="stat-label">累计缺勤节数</div></div></div>
        <div class="stat-card"><div class="stat-icon si-orange">${ICONS.search}</div><div><div class="stat-value">${d.stats.lateCount}</div><div class="stat-label">累计迟到次数</div></div></div>
      </div>
      ${renderPunishment(d.punishment)}
      <div class="abs-result-sub">${esc(d.student.className)} · ${esc(d.student.name)}（${esc(d.studentId)}） · ${esc(d.term.name)}（${esc(d.term.start)} ~ ${esc(d.term.end)}）</div>
      ${renderRecords(d.records)}
      <div id="absProgress"></div>`;
      state.lastRecords = d.records;
      bindSelection(d);
      loadProgress(); // 异步加载「我的异议进度」，不阻塞主结果
    }
    async function queryStudent() {
      const err = $('#absErr');
      err.textContent = '';
      const className = $('#absClass').value;
      const studentId = $('#absSid').value.trim();
      const name = $('#absName').value.trim();
      if (!className || !studentId || !name) {
        err.textContent = '请填写班级、学号和姓名';
        return;
      }
      const btn = $('#absQueryBtn');
      btn.disabled = true;
      btn.textContent = '查询中…';
      try {
        const qs = new URLSearchParams({ className, studentId, name, term: state.term });
        const d = await api(`/api/public/absence/query?${qs}`);
        $('#absResult').dataset.done = '1';
        // 修改27：新查询重置勾选与进度，记录三要素（提交异议 / 进度查询复用）
        state.sel.clear();
        state.mine = [];
        state.lastQuery = { className, studentId, name };
        renderResult(d);      } catch (e) {
        $('#absResult').innerHTML = '';
        $('#absResult').dataset.done = '';
        err.textContent = e.message;
      } finally {
        btn.disabled = false;
        btn.textContent = '查询';
      }
    }
    $('#absQueryBtn').onclick = queryStudent;
    $('#absSid').addEventListener('keydown', (e) => e.key === 'Enter' && queryStudent());
    $('#absName').addEventListener('keydown', (e) => e.key === 'Enter' && queryStudent());

    // ---------- ①-1 考勤异议（修改27）：勾选记录 → 填理由 + 佐证材料 → 提交；下方展示审核进度 ----------
    const APPEAL_STATUS = {
      pending: { label: '待审核', cls: 'tag-orange' },
      approved: { label: '已通过·待改判', cls: 'tag-green' },
      resolved: { label: '已办结', cls: 'tag-blue' },
      rejected: { label: '已驳回', cls: 'tag-red' },
      withdrawn: { label: '已撤销', cls: 'tag' },
    };

    // 勾选交互（事件委托，明细每次重渲染后无需重绑）
    function bindSelection(d) {
      const box = $('#absResult');
      const refreshBar = () => {
        const btn = box.querySelector('#absAppealBtn');
        if (btn) {
          btn.disabled = !state.sel.size;
          btn.textContent = `提交异议（已选 ${state.sel.size} 条）`;
        }
        const all = box.querySelector('#absSelAll');
        if (all) {
          const checks = [...box.querySelectorAll('.abs-rec-check')];
          all.checked = checks.length > 0 && checks.every((c) => c.checked);
        }
      };
      box.onchange = (e) => {
        const cb = e.target.closest('.abs-rec-check');
        if (cb) {
          if (cb.checked) state.sel.add(cb.dataset.sid);
          else state.sel.delete(cb.dataset.sid);
          refreshBar();
          return;
        }
        if (e.target.id === 'absSelAll') {
          const checks = [...box.querySelectorAll('.abs-rec-check')];
          checks.forEach((c) => {
            c.checked = e.target.checked;
            if (e.target.checked) state.sel.add(c.dataset.sid);
            else state.sel.delete(c.dataset.sid);
          });
          refreshBar();
        }
      };
      box.onclick = (e) => {
        if (e.target.closest('#absAppealBtn')) openAppealModal(d);
      };
    }

    // 我的异议进度：与自查同三要素，查询失败静默（进度卡缺省不展示）
    async function loadProgress() {
      if (!state.lastQuery || !$('#absProgress')) return;
      const { className, studentId, name } = state.lastQuery;
      try {
        const qs = new URLSearchParams({ className, studentId, name });
        const d = await api(`/api/public/appeals/mine?${qs}`);
        state.mine = d.appeals || [];
      } catch {
        state.mine = [];
      }
      renderProgress();
    }

    function renderProgress() {
      const box = $('#absProgress');
      if (!box) return;
      if (!state.mine.length) {
        box.innerHTML = '';
        return;
      }
      const rows = state.mine
        .map((a) => {
          const st = APPEAL_STATUS[a.status] || { label: a.status, cls: '' };
          const dates = a.records.map((r) => r.date);
          const dateRange = dates.length === 1 ? dates[0] : `${dates[0]} ~ ${dates[dates.length - 1]}`;
          const statuses = [...new Set(a.records.map((r) => r.status))].join('/');
          let extra = '';
          if (a.status === 'rejected' && a.reviewInfo) {
            extra = `<div class="abs-pg-extra">审核意见：${esc(a.reviewInfo.comment)}</div>`;
          } else if (a.status === 'resolved' && a.resolveInfo) {
            const applied = a.resolveInfo.items.filter((x) => x.applied);
            extra = applied.length
              ? `<div class="abs-pg-extra">改判：${applied.map((x) => `${esc(x.date)} ${esc(x.from)}→${esc(x.to)}`).join('；')}${(a.resolveHistory || []).length ? `<span class="muted">（含 ${a.resolveHistory.length} 轮历史改判）</span>` : ''}</div>`
              : '<div class="abs-pg-extra">改判：记录状态已变更，无需改判</div>';
          } else if (a.status === 'approved') {
            extra = '<div class="abs-pg-extra">审核已通过，待老师执行改判</div>';
          } else if (a.status === 'withdrawn') {
            extra = `<div class="abs-pg-extra">已撤销${a.withdrawInfo ? `（${fmtTime(a.withdrawInfo.withdrawnAt)}）` : ''}，可重新勾选该记录提交异议</div>`;
          }
          const atts = a.attachments || [];
          return `
          <div class="abs-pg-item">
            <div class="abs-pg-head">
              <span class="tag ${st.cls}">${esc(st.label)}</span>
              <span class="small">${a.recordsCount} 条记录（${esc(statuses)} · ${esc(dateRange)}）</span>
              <span class="muted small abs-pg-time">${fmtTime(a.createdAt)} 提交</span>
            </div>
            <div class="abs-pg-reason small">理由：${esc(a.reason) || '<span class="muted">—</span>'}</div>
            ${atts.length ? `<div class="abs-pg-atts">${atts.map((x, i) => `<img class="apl-thumb abs-pg-thumb" src="${esc(x.dataUrl)}" alt="${esc(x.name)}" title="${esc(x.name)}" data-pgatt="${i}" data-apid="${esc(a.id)}" />`).join('')}</div>` : ''}
            ${extra}
            ${a.status === 'pending' ? `
            <div class="abs-pg-ops">
              <button class="btn-text abs-pg-edit" data-apid="${esc(a.id)}">修改</button>
              <button class="btn-text danger abs-pg-withdraw" data-apid="${esc(a.id)}">撤销</button>
              <span class="muted small">待审核期间可修改理由与材料，或撤销后重新提交</span>
            </div>` : ''}
          </div>`;
        })
        .join('');
      box.innerHTML = `
      <div class="card abs-card abs-progress">
        <div class="card-title">我的异议进度（${state.mine.length} 条）</div>
        ${rows}
      </div>`;
      // 修改28：进度卡交互（材料放大 / 修改 / 撤销）——每次重渲染直接绑定，无累积
      box.querySelectorAll('.abs-pg-thumb').forEach((im) => {
        im.onclick = () => modal({ title: im.title || '佐证材料', width: 720, showFooter: false, body: `<img src="${esc(im.src)}" style="width:100%;border-radius:10px;display:block" />` });
      });
      box.querySelectorAll('.abs-pg-edit').forEach((btn) => {
        btn.onclick = () => {
          const a = state.mine.find((x) => x.id === btn.dataset.apid);
          if (a) openAppealEditModal(a);
        };
      });
      box.querySelectorAll('.abs-pg-withdraw').forEach((btn) => {
        btn.onclick = () => withdrawAppeal(btn.dataset.apid);
      });
      // 进度加载后用已拉取的记录重渲染明细（刷新「处理中」标记，不再重复请求）
      if (state.lastRecords && state.mine.length) refreshRecordsQuietly();
    }

    function refreshRecordsQuietly() {
      try {
        const html = renderRecords(state.lastRecords);
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        // 修改33 修复：改用 data-card="records" 精确定位明细卡。
        // 原用 $('#absResult .abs-card') 取文档中第一张卡，但处分卡（pm-card）同样带 abs-card 类
        // 且排在明细卡之前 → 处分卡被明细卡顶替（表现为明细卡出现两次、处分卡消失）。
        const oldCard = $('#absResult [data-card="records"]');
        const newCard = tmp.querySelector('[data-card="records"]');
        if (oldCard && newCard) {
          oldCard.replaceWith(newCard);
          bindSelection({ records: state.lastRecords });
        }
      } catch { /* 静默 */ }
    }

    // 附件选择器（提交/修改弹窗共用，修改28 抽取）：渲染缩略图 + 删除 + FileReader 校验
    function bindAttachmentPicker(wrap, attachments, err) {
      const thumbs = wrap.querySelector('.apl-thumbs');
      const renderThumbs = () => {
        thumbs.innerHTML = attachments
          .map(
            (x, i) => `
          <div class="apl-thumb-item">
            <img src="${esc(x.dataUrl)}" alt="${esc(x.name)}" />
            <button class="apl-thumb-del" data-i="${i}" aria-label="删除附件">×</button>
          </div>`
          )
          .join('');
      };
      thumbs.onclick = (e) => {
        const del = e.target.closest('.apl-thumb-del');
        if (del) {
          attachments.splice(Number(del.dataset.i), 1);
          renderThumbs();
        }
      };
      let busy = false; // 修改29：压缩处理中防重入
      wrap.querySelector('input[type="file"]').onchange = async (e) => {
        err.textContent = '';
        const files = [...e.target.files];
        e.target.value = '';
        if (busy || !files.length) return;

        const pick = wrap.querySelector('.apl-pick');
        const pickText = wrap.querySelector('.apl-pick-text');
        if (attachments.length >= 3) {
          err.textContent = '佐证材料最多 3 张';
          toast('佐证材料最多 3 张', 'error');
          return;
        }
        // 修改29：剩余名额截断，多余文件明确提示
        const room = 3 - attachments.length;
        let list = files;
        let over = '';
        if (files.length > room) {
          list = files.slice(0, room);
          over = `佐证材料最多 3 张，已忽略多余 ${files.length - room} 张；`;
        }

        busy = true;
        if (pick) pick.classList.add('is-busy');
        if (pickText) {
          pickText.dataset.orig = pickText.textContent;
          pickText.textContent = '处理中…';
        }
        const fails = [];
        let ok = 0;
        try {
          for (const f of list) {
            try {
              // 修改29：自动压缩（≤900KB 直通；大图/HEIC canvas 转码），失败不中断整批
              attachments.push(await compressImage(f));
              ok++;
            } catch (e2) {
              fails.push(e2.message);
            }
          }
        } finally {
          busy = false;
          if (pick) pick.classList.remove('is-busy');
          if (pickText) pickText.textContent = pickText.dataset.orig || '选择图片';
          renderThumbs();
        }

        const failMsg = fails.join('；');
        if (ok > 0 && fails.length === 0) {
          err.textContent = over;
          toast(over ? `已添加 ${ok} 张照片（${over.replace(/；$/, '')}）` : `已添加 ${ok} 张照片`);
        } else if (ok > 0) {
          err.textContent = `已添加 ${ok} 张，${fails.length} 张失败：` + over + failMsg;
          toast(`已添加 ${ok} 张，${fails.length} 张失败：${failMsg}`, 'error');
        } else {
          err.textContent = over + failMsg;
          toast(failMsg || '图片处理失败', 'error');
        }
      };
      renderThumbs();
    }

    // 提交异议弹窗
    function openAppealModal(d) {
      const selRecords = d.records.filter((r) => state.sel.has(r.sessionId));
      if (!selRecords.length) return;
      const q = state.lastQuery || {};
      let attachments = []; // { name, dataUrl }
      modal({
        title: '提交考勤异议',
        width: 620,
        showFooter: false,
        body: `
        <div class="apl-records-sum small">
          异议记录（${selRecords.length} 条）：
          ${selRecords.map((r) => `<span class="tag ${statusTagCls(r.status)}">${esc(r.date)} ${esc(r.status)}</span>`).join(' ')}
        </div>
        <div class="form-item"><label>异议理由<span class="req">*</span>（5~500 字）</label>
          <textarea class="input apl-reason-input" rows="3" maxlength="500" placeholder="请说明异议原因，例如当天实际已到校 / 已履行请假手续等"></textarea></div>
        <div class="form-item"><label>佐证材料（可选，最多 3 张图片，拍摄原图可直接上传，系统会自动压缩）</label>
          <label class="file-pick btn btn-sm apl-pick">${ICONS.upload} <span class="apl-pick-text">选择图片</span><input type="file" accept="image/*" multiple hidden /></label>
          <div class="apl-thumbs"></div>
        </div>
        <div class="login-err apl-err"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button class="btn" data-act="cancel">取消</button>
          <button class="btn btn-primary apl-submit">提交异议</button>
        </div>`,
        onMount(wrap, close) {
          const err = wrap.querySelector('.apl-err');
          bindAttachmentPicker(wrap, attachments, err);
          wrap.querySelector('.apl-submit').onclick = async () => {
            err.textContent = '';
            const reason = wrap.querySelector('.apl-reason-input').value.trim();
            if (reason.length < 5 || reason.length > 500) {
              err.textContent = '异议理由需为 5~500 字';
              return;
            }
            const btn = wrap.querySelector('.apl-submit');
            btn.disabled = true; // 处理中禁用，防重复提交
            try {
              await api('/api/public/appeals', {
                method: 'POST',
                body: { className: q.className, studentId: q.studentId, name: q.name, sessionIds: [...state.sel], reason, attachments },
              });
              toast('异议已提交，请等待审核');
              close();
              state.sel.clear();
              await loadProgress(); // 刷新进度 + 明细「处理中」标记
            } catch (e2) {
              err.textContent = e2.message;
              btn.disabled = false;
            }
          };
        },
      });
    }

    // 修改待审核异议弹窗（修改28）：仅理由与材料可改，记录只读展示
    function openAppealEditModal(a) {
      const q = state.lastQuery || {};
      if (!q.className) return;
      const attachments = (a.attachments || []).map((x) => ({ name: x.name, dataUrl: x.dataUrl }));
      modal({
        title: '修改异议（待审核）',
        width: 620,
        showFooter: false,
        body: `
        <div class="apl-records-sum small">
          异议记录（${a.recordsCount} 条，不可更换）：
          ${a.records.map((r) => `<span class="tag ${statusTagCls(r.status)}">${esc(r.date)} ${esc(r.status)}</span>`).join(' ')}
        </div>
        <div class="form-item"><label>异议理由<span class="req">*</span>（5~500 字）</label>
          <textarea class="input apl-reason-input" rows="3" maxlength="500">${esc(a.reason || '')}</textarea></div>
        <div class="form-item"><label>佐证材料（可选，最多 3 张图片，拍摄原图可直接上传，系统会自动压缩）</label>
          <label class="file-pick btn btn-sm apl-pick">${ICONS.upload} <span class="apl-pick-text">选择图片</span><input type="file" accept="image/*" multiple hidden /></label>
          <div class="apl-thumbs"></div>
        </div>
        <div class="login-err apl-err"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button class="btn" data-act="cancel">取消</button>
          <button class="btn btn-primary apl-submit">保存修改</button>
        </div>`,
        onMount(wrap, close) {
          const err = wrap.querySelector('.apl-err');
          bindAttachmentPicker(wrap, attachments, err);
          wrap.querySelector('.apl-submit').onclick = async () => {
            err.textContent = '';
            const reason = wrap.querySelector('.apl-reason-input').value.trim();
            if (reason.length < 5 || reason.length > 500) {
              err.textContent = '异议理由需为 5~500 字';
              return;
            }
            const btn = wrap.querySelector('.apl-submit');
            btn.disabled = true; // 处理中禁用
            try {
              await api(`/api/public/appeals/${a.id}/edit`, {
                method: 'POST',
                body: { className: q.className, studentId: q.studentId, name: q.name, reason, attachments },
              });
              toast('异议已更新');
              close();
              await loadProgress();
            } catch (e2) {
              err.textContent = e2.message;
              btn.disabled = false;
            }
          };
        },
      });
    }

    // 撤销待审核异议（修改28）：confirmDialog 二次确认 → withdrawn 终态（记录释放可再提）
    async function withdrawAppeal(id) {
      const okGo = await confirmDialog('确定撤销该异议吗？撤销后对应考勤记录可重新提交异议。', { title: '撤销异议', danger: true, okText: '确认撤销' });
      if (!okGo) return;
      const q = state.lastQuery || {};
      if (!q.className) return;
      try {
        await api(`/api/public/appeals/${id}/withdraw`, { method: 'POST', body: { className: q.className, studentId: q.studentId, name: q.name } });
        toast('异议已撤销');
        await loadProgress();
      } catch (e) {
        toast(e.message, 'error');
      }
    }

    // ---------- ② 班级公示榜 ----------
    function renderBoard(d) {
      const rows = d.board
        .map(
          (s, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${esc(s.studentId)}</td>
          <td>${esc(s.name)}</td>
          <td class="${s.absencePeriods ? 'cm-red' : ''}">${s.absencePeriods}</td>
          <td class="${s.absenceCount ? 'cm-red' : ''}">${s.absenceCount}</td>
          <td class="${s.lateCount ? 'cm-orange' : ''}">${s.lateCount}</td>
          <td class="${s.studyCount ? 'cm-red' : ''}">${s.studyCount ?? 0}</td>
          <td>${canDetail && s.absencePeriods > 0 ? `<button class="btn-text" data-act="boarddetail" data-idx="${i}">详情</button>` : ''}</td>
        </tr>`
        )
        .join('');
      // 修改48：手机层学生卡（≤720px）——沿用 m45 su-card 视觉语言（圆形姓氏头像 + 姓名/学号 + 班级 pill + 五列统计），
      // 与桌面表格双渲染共用同一份 d.board；五列 = 排名/缺勤节数/缺勤次数/迟到次数/早晚自习（公示榜现有字段，姓名学号保持脱敏）。
      const cbCards = d.board
        .map(
          (s, i) => `
        <div class="su-card cb-card">
          <div class="su-head">
            <span class="su-avatar">${esc(String(s.name || '').slice(0, 1))}</span>
            <div class="su-tx"><b>${esc(s.name)}</b><span>学号：${esc(s.studentId)}</span></div>
            <span class="su-cls">${ICONS.users}${esc(d.className)}</span>
          </div>
          <div class="su-cols">
            <div class="su-col"><span>排名</span><b class="${i < 3 ? 'cm-orange' : ''}">${i + 1}</b></div>
            <div class="su-col"><span>缺勤节数</span><b class="${s.absencePeriods ? 'cm-red' : ''}">${s.absencePeriods}</b></div>
            <div class="su-col"><span>缺勤次数</span><b class="${s.absenceCount ? 'cm-red' : ''}">${s.absenceCount}</b></div>
            <div class="su-col"><span>迟到次数</span><b class="${s.lateCount ? 'cm-orange' : ''}">${s.lateCount}</b></div>
            <div class="su-col"><span>早晚自习</span><b class="${s.studyCount ? 'cm-red' : ''}">${s.studyCount ?? 0}</b></div>
          </div>
          ${canDetail && s.absencePeriods > 0 ? `<div class="cb-acts"><button class="btn-text" data-act="boarddetail" data-idx="${i}">查看缺勤详情${ICONS.chevronR || ''}</button></div>` : ''}
        </div>`
        )
        .join('');
      const noteHtml = `<p class="muted small abs-board-note">为保护隐私，学号与姓名已脱敏展示（如 2023***01 / 陈*然）；统计口径与自查页一致，计算规则见「缺勤自查」页顶部的规则说明；早晚自习缺勤次数=节次含早自习或晚自习的缺勤记录条数。</p>`;
      $('#absBoardResult').innerHTML = `
      <div class="d-layer">
        <div class="card abs-card">
          <div class="card-title">${esc(d.className)} · ${esc(d.term.name)}（${esc(d.term.start)} ~ ${esc(d.term.end)}）缺勤公示榜</div>
          <div class="table-wrap"><table class="table" data-card="a,s,t,n,a,a,m,x">
            <thead><tr><th>排名</th><th>学号</th><th>姓名</th><th>缺勤节数</th><th>缺勤次数</th><th>迟到次数</th><th>早晚自习缺勤次数</th><th>操作</th></tr></thead>
            <tbody>${rows}</tbody>
          </table></div>
          ${noteHtml}
        </div>
      </div>
      <div class="m-layer">
        <div class="card abs-card cb-panel">
          <div class="cb-head">${ICONS.school || ''}<b>缺勤公示榜</b><span>${esc(d.className)} · ${esc(d.term.name)}（${esc(d.term.start)} ~ ${esc(d.term.end)}）</span></div>
          <div class="cb-list">${cbCards || '<div class="cb-empty">该班级暂无学生记录</div>'}</div>
          ${noteHtml}
        </div>
      </div>`;
      enhanceTables($('#absBoardResult'));
    }
    async function queryBoard() {
      const err = $('#absBoardErr');
      err.textContent = '';
      const className = $('#absBoardClass').value;
      if (!className) {
        err.textContent = '请选择班级';
        return;
      }
      const btn = $('#absBoardBtn');
      btn.disabled = true;
      btn.textContent = '查询中…';
      try {
        const qs = new URLSearchParams({ className, term: state.term });
        const d = await api(`/api/public/absence/classboard?${qs}`);
        renderBoard(d);
      } catch (e) {
        $('#absBoardResult').innerHTML = '';
        err.textContent = e.message;
      } finally {
        btn.disabled = false;
        btn.textContent = '查看公示榜';
      }
    }
    $('#absBoardBtn').onclick = queryBoard;

    // ---------- ②-1 公示榜缺勤详情（修改21） ----------
    $('#absBoardResult').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act="boarddetail"]');
      if (!btn) return;
      const className = $('#absBoardClass').value;
      if (!className) return;
      boardDetailModal({ className, term: state.term, idx: Number(btn.dataset.idx) });
    });

    // 公示榜缺勤详情弹窗：仅缺勤节数>0 的行可点（按钮渲染时已控制）；
    // 展示当前公示榜统计区间内全部缺勤/迟到记录，类型分 常规缺勤 / 早晚自习缺勤 / 迟到 三类口径
    function boardDetailModal(stuRef) {
      modal({
        title: '缺勤详情',
        width: 900,
        showFooter: false,
        body: `<div id="absBdBody" class="muted small">加载中…</div>`,
        onMount: async (wrap, close) => {
          const body = wrap.querySelector('#absBdBody');
          const params = new URLSearchParams({ className: stuRef.className, term: stuRef.term, idx: stuRef.idx });
          let d;
          try {
            d = await api(`/api/absence/board-detail?${params}`);
          } catch (e) {
            body.innerHTML = `<div class="ir-line bad">✗ ${esc(e.message)}</div>`;
            return;
          }
          const recs = d.records;
          const regular = recs.filter((r) => r.status === '缺勤' && !r.isStudy).length;
          const study = recs.filter((r) => r.status === '缺勤' && r.isStudy).length;
          const late = recs.filter((r) => r.status === '迟到').length;
          const totalJie = recs.reduce((n, r) => n + r.jie, 0);
          // 修改54：手机层记录卡（参照设计稿）——左侧状态色竖条 + 节次 pill/日期/星期 + 课程名/时间段 + 状态/节数。
          // 卡片可点开「更多」查看任课老师 / 备注 / 早晚自习标记（补回桌面表格里的信息，不丢内容）。
          const kindOf = (r) => (r.status === '迟到' ? 'is-late' : r.isStudy ? 'is-study' : 'is-abs');
          const abdCard = (r) => `
            <article class="abd-card ${kindOf(r)}">
              <div class="abd-left">
                <span class="abd-period">${r.periods.map((p) => esc(p)).join('、')}</span>
                <b class="abd-date">${esc(r.date)}</b>
                <span class="abd-wd">（${esc(r.weekday)}）</span>
                <span class="abd-dash" aria-hidden="true"></span>
              </div>
              <div class="abd-mid">
                <div class="abd-course"><span class="abd-cico">${ICONS.book}</span><b>${esc(r.courseName)}</b></div>
                <div class="abd-meta">${ICONS.clock}<span>${r.times.map((t) => `${esc(t.period)} ${esc(t.start)}-${esc(t.end)}`).join('、') || '按节次'}</span></div>
                <div class="abd-more" hidden>
                  <div class="abd-mrow"><i>任课老师</i><span>${esc(r.teacher) || '—'}</span></div>
                  <div class="abd-mrow"><i>早晚自习</i><span>${r.isStudy ? '是' : '否'}</span></div>
                  <div class="abd-mrow"><i>备注</i><span>${esc(r.note) || '—'}</span></div>
                </div>
              </div>
              <div class="abd-right">
                <span class="abd-status">${r.status === '迟到' ? '迟到' : '缺勤'}</span>
                <b class="abd-jie">${r.jie} 节</b>
                <span class="abd-chev">${ICONS.chevronR}</span>
              </div>
            </article>`;
          body.innerHTML = `
          <div class="d-layer">
            <div class="small" style="margin-bottom:10px">${esc(d.student.name)}（${esc(d.student.className)}${d.student.grade ? ' / ' + esc(d.student.grade) : ''}）· ${esc(d.term.name)}（${esc(d.term.start)} ~ ${esc(d.term.end)}）· 常规缺勤 <b>${regular}</b> 条 / 早晚自习缺勤 <b>${study}</b> 条 / 迟到 <b>${late}</b> 条 / 合计 <b>${totalJie}</b> 节</div>
            <div class="table-wrap" style="max-height:46vh;overflow-y:auto;border:1px solid var(--border-light);border-radius:8px">
              <table class="table" data-card="t,d,-,g,a,b,-,m">
                <thead><tr><th>日期</th><th>缺勤类型</th><th>早晚自习</th><th>节次</th><th>上课时间段（基准）</th><th>课程名称</th><th>任课老师</th><th>备注</th></tr></thead>
                <tbody>
                  ${recs.length ? recs.map((r) => `
                    <tr>
                      <td class="num">${esc(r.date)}（${esc(r.weekday)}）</td>
                      <td>${r.status === '迟到' ? `<span class="tag tag-orange">迟到</span><span class="muted small">折 ${r.jie} 节</span>` : `<span class="tag tag-red">缺勤</span><span class="muted small">${r.jie} 节</span>`}</td>
                      <td>${r.isStudy ? '<span class="tag tag-cyan">早晚自习</span>' : '<span class="muted">—</span>'}</td>
                      <td>${r.periods.map((p) => `<span class="tag tag-purple">${esc(p)}</span>`).join('')}</td>
                      <td class="num small">${r.times.map((t) => `${esc(t.period)} ${esc(t.start)}~${esc(t.end)}`).join('<br/>')}</td>
                      <td>${esc(r.courseName)}</td>
                      <td>${esc(r.teacher) || '<span class="muted">—</span>'}</td>
                      <td class="small" style="max-width:180px">${esc(r.note) || '<span class="muted">—</span>'}</td>
                    </tr>`).join('') : '<tr><td colspan="8" class="table-empty">该统计区间内暂无缺勤 / 迟到记录</td></tr>'}
                </tbody>
              </table>
            </div>
          </div>

          <div class="m-layer">
            <section class="abd-sum">
              <div class="abd-sum-hd">
                <span class="abd-sum-ico">${ICONS.list}</span>
                <b>${esc(d.student.name)}</b>
                <span>（${esc(d.student.className)}${d.student.grade ? ' / ' + esc(d.student.grade) : ''}）· ${esc(d.term.name)}</span>
              </div>
              <div class="abd-sum-grid">
                <div class="abd-cell is-range"><span class="abd-ci">${ICONS.calendar}</span><div class="tx"><b>${esc(d.term.start)} ~ ${esc(d.term.end)}</b><i>学期时间</i></div></div>
                <div class="abd-cell"><div class="tx"><i>常规缺勤</i><b>${regular} 条</b></div></div>
                <div class="abd-cell"><div class="tx"><i>早晚自习缺勤</i><b>${study} 条</b></div></div>
                <div class="abd-cell"><div class="tx"><i>迟到</i><b>${late} 条</b></div></div>
                <div class="abd-cell"><div class="tx"><i>合计</i><b>${totalJie} 节</b></div></div>
              </div>
            </section>
            <div class="abd-list">
              ${recs.length ? recs.map(abdCard).join('') : '<div class="abd-empty">该统计区间内暂无缺勤 / 迟到记录</div>'}
            </div>
          </div>`;
          // 修改54：手机层卡片可点开「更多」（任课老师 / 早晚自习 / 备注）
          body.querySelectorAll('.abd-card').forEach((card) => {
            const more = card.querySelector('.abd-more');
            if (!more) return;
            card.addEventListener('click', () => {
              const open = more.hidden;
              more.hidden = !open;
              card.classList.toggle('is-open', open);
            });
          });
        },
      });
    }

    // ---------- 复制分享链接 ----------
    if (inLayout && user) {
      $('#absCopyBtn').onclick = async () => {
        const input = $('#absShareUrl');
        try {
          await navigator.clipboard.writeText(shareUrl);
          toast('链接已复制，可粘贴到班级群');
        } catch {
          // 非 HTTPS / 旧浏览器降级：选中文本 + execCommand
          input.focus();
          input.select();
          let done = false;
          try { done = document.execCommand('copy'); } catch { /* ignore */ }
          toast(done ? '链接已复制，可粘贴到班级群' : '复制失败，请长按链接手动复制', done ? 'success' : 'error');
        }
      };
    }

    // ---------- 导出公示表 ----------
    if (canExport) {
      $('#absExportBtn').onclick = async () => {
        const className = $('#absBoardClass').value;
        if (!className) {
          toast('请先选择要导出的班级', 'error');
          return;
        }
        const btn = $('#absExportBtn');
        btn.disabled = true;
        try {
          await apiPostDownload('/api/absence/export', { className, term: state.term }, `缺勤公示_${className}.xlsx`);
          toast('导出成功');
        } catch (e) {
          toast(e.message, 'error');
        } finally {
          btn.disabled = false;
        }
      };
    }

    // ---------- 学期设置（仅管理员） ----------
    if (isAdmin) {
      $('#absTermCfgBtn').onclick = () => openTermConfig();
    }
    async function openTermConfig() {
      let cfg;
      try {
        cfg = await api('/api/settings/semesters');
      } catch (e) {
        toast(e.message, 'error');
        return;
      }
      const termRow = (i, t) => `
      <div class="abs-term-cfg" data-idx="${i}">
        <div class="abs-cfg-title">${esc(t.name)}${t.configured ? '<span class="tag tag-blue">已自定义</span>' : '<span class="tag">默认</span>'}</div>
        <div class="abs-cfg-grid">
          <div class="form-item"><label>名称</label><input class="input abs-cfg-name" value="${esc(t.name)}" maxlength="20" /></div>
          <div class="form-item"><label>开始日期</label><input type="date" class="input abs-cfg-start" value="${esc(t.start)}" /></div>
          <div class="form-item"><label>结束日期</label><input type="date" class="input abs-cfg-end" value="${esc(t.end)}" /></div>
        </div>
      </div>`;
      modal({
        title: `学期起止设置（${cfg.schoolYear.label}）`,
        width: 620,
        showFooter: false,
        body: `
        <p class="muted small" style="margin-top:0">学年起止固定为 ${esc(cfg.schoolYear.start)} ~ ${esc(cfg.schoolYear.end)}（当年 9/1 ~ 次年 7/31，每年自动切换）；学期起止可按学校校历自定义，未配置的学期使用默认划分（第一学期 9/1~1/31，第二学期 2/1~7/31）。</p>
        ${termRow(0, cfg.terms[0])}
        ${termRow(1, cfg.terms[1])}
        <div class="login-err abs-cfg-err"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:6px">
          <button class="btn abs-cfg-reset">恢复默认</button>
          <button class="btn btn-primary abs-cfg-save">保存配置</button>
        </div>`,
        onMount(wrap) {
          const err = wrap.querySelector('.abs-cfg-err');
          wrap.querySelector('.abs-cfg-save').onclick = async () => {
            err.textContent = '';
            const rows = [...wrap.querySelectorAll('.abs-term-cfg')].map((r) => ({
              idx: Number(r.dataset.idx),
              name: r.querySelector('.abs-cfg-name').value.trim(),
              start: r.querySelector('.abs-cfg-start').value,
              end: r.querySelector('.abs-cfg-end').value,
            }));
            for (const r of rows) {
              if (!r.name) { err.textContent = '学期名称不能为空'; return; }
              if (!r.start || !r.end) { err.textContent = '请完整填写学期起止日期'; return; }
              if (r.start > r.end) { err.textContent = '开始日期不能晚于结束日期'; return; }
            }
            try {
              for (const r of rows) {
                await api('/api/settings/semesters', { method: 'PUT', body: { term: r.idx, name: r.name, start: r.start, end: r.end } });
              }
              toast('学期配置已保存');
              wrap.remove();
              window.location.reload();
            } catch (e) {
              err.textContent = e.message;
            }
          };
          wrap.querySelector('.abs-cfg-reset').onclick = async () => {
            err.textContent = '';
            try {
              await api('/api/settings/semesters', { method: 'PUT', body: { reset: true } });
              toast('已恢复默认学期划分');
              wrap.remove();
              window.location.reload();
            } catch (e) {
              err.textContent = e.message;
            }
          };
        },
      });
    }
  },
};
