import { api, apiPostDownload } from '../api.js';
import { getUser, hasRole, hasAnyRole } from '../session.js';
import { esc, modal, toast, confirmDialog, renderPager, roleTag, createSearchSelect, importModal, ROLE_NAMES, PRIVILEGED_ROLES, ICONS } from '../ui.js';

const state = { q: '', role: '', page: 1, pageSize: 10 };
let classesCache = [];
// 修改58：班级元数据（{name,count,grade}）——「编辑账号」的可点名班级按年级分级多选需要年级信息
let classMetaCache = [];

// 账号的 Role 集合（兼容旧数据无 roles 字段的情况）；是否含特权角色
const rolesOf = (u) => (Array.isArray(u.roles) && u.roles.length ? u.roles : u.role ? [u.role] : []);
const isPrivileged = (u) => rolesOf(u).some((r) => PRIVILEGED_ROLES.includes(r));

export default {
  async mount(root) {
    // 视角：学院考勤负责老师可管理非特权角色账号；特权角色（管理员/学院考勤负责老师）仅管理员可见可操作
    const viewer = getUser();
    const isViewerAdmin = hasRole(viewer, 'admin');
    const canSee = (r) => isViewerAdmin || !PRIVILEGED_ROLES.includes(r);
    const roleFilterOpts = ['admin', 'collegeOfficer', 'rights', 'discipline', 'headTeacher', 'counselor']
      .filter(canSee)
      .map((r) => `<option value="${r}">${ROLE_NAMES[r]}</option>`)
      .join('');
    root.innerHTML = `
    <div class="page">
      <div class="card" style="padding:10px 16px;margin-bottom:12px">
        <div class="tabs" id="acctTabs">
          <button class="tab-btn active" data-tab="users">系统账号</button>
          <button class="tab-btn" data-tab="staffs">教职工名单</button>
        </div>
      </div>
      <div id="usersPane">
      <div class="page-head">
        <div>
          <h2>账号管理</h2>
          <p class="page-desc">按角色生成账号：学生账号（学号登录 / 初始密码 Hzpt@学号后六位）、教职工账号（工号登录 / 初始密码 Hzpt@工号），首次登录强制修改密码</p>
        </div>
        <div class="page-actions">
          <button class="btn" id="btnAccImport">批量导入</button>
          <button class="btn btn-primary" id="btnAdd">新建账号</button>
        </div>
      </div>
      <div class="card">
        <div class="toolbar">
          <input class="input" id="q" placeholder="搜索账号 / 姓名" style="width:200px" />
          <select class="select" id="roleFilter">
            <option value="">全部角色</option>
            ${roleFilterOpts}
          </select>
          <button class="btn" id="btnSearch">查询</button>
          <div class="spacer"></div>
        </div>
        <div class="table-wrap">
          <table class="table" data-card="s,t,g,m,d,-,x">
            <thead>
              <tr><th>登录账号</th><th>姓名</th><th>角色</th><th>可点名班级</th><th>状态</th><th>创建时间</th><th class="td-actions">操作</th></tr>
            </thead>
            <tbody id="tbody"><tr><td colspan="7" class="table-empty">加载中…</td></tr></tbody>
          </table>
        </div>
        <div class="card-foot">
          <div class="table-info" id="info"></div>
          <div class="pager" id="pager"></div>
        </div>
      </div>
      </div>
      <div id="staffPane" style="display:none">
        <div class="page-head">
          <div>
            <h2>教职工名单</h2>
            <p class="page-desc">维护教职工工号、姓名、岗位与所带班级；支持批量导入名单，并可勾选人员一次性批量生成班主任 / 辅导员账号</p>
          </div>
          <div class="page-actions">
            <button class="btn" id="btnStaffImport">批量导入</button>
            <button class="btn btn-primary" id="btnStaffAdd">新增教职工</button>
          </div>
        </div>
        <div class="card">
          <div class="toolbar">
            <span class="muted small" id="staffSelInfo">未勾选人员</span>
            <div class="spacer"></div>
            <button class="btn" id="btnStaffGen" disabled>批量生成账号</button>
          </div>
          <div class="table-wrap">
            <table class="table" data-card="k,s,t,m,m,d,x">
              <thead>
                <tr>
                  <th style="width:36px"><input type="checkbox" id="staffCheckAll" title="全选" /></th>
                  <th>工号</th><th>姓名</th><th>岗位</th><th>所带班级</th><th>状态</th><th class="td-actions">操作</th>
                </tr>
              </thead>
              <tbody id="staffTbody"><tr><td colspan="7" class="table-empty">加载中…</td></tr></tbody>
            </table>
          </div>
          <div class="card-foot">
            <div class="table-info" id="staffInfo"></div>
          </div>
        </div>
      </div>
    </div>`;

    const clsMeta = (await api('/api/meta/classes')).classes;
    classesCache = clsMeta.map((c) => c.name);
    classMetaCache = clsMeta; // 修改58：保留 {name,count,grade}

    const tbody = root.querySelector('#tbody');
    const pagerEl = root.querySelector('#pager');
    const infoEl = root.querySelector('#info');
    let listCache = [];

    async function load() {
      tbody.innerHTML = '<tr><td colspan="7" class="table-empty">加载中…</td></tr>';
      const params = new URLSearchParams({ page: state.page, pageSize: state.pageSize });
      if (state.q) params.set('q', state.q);
      if (state.role) params.set('role', state.role);
      const d = await api(`/api/accounts?${params}`);
      listCache = d.list;
      infoEl.textContent = `共 ${d.total} 个账号`;
      renderPager(pagerEl, d, (p) => {
        state.page = p;
        load();
      });
      tbody.innerHTML = d.list.length
        ? d.list
            .map(
              (u) => `
        <tr data-id="${u.id}">
          <td><b>${esc(u.username)}</b></td>
          <td>${esc(u.name)}</td>
          <td>${rolesOf(u).map(roleTag).join(' ')}</td>
          <td>${u.classes.length ? u.classes.map((c) => `<span class="tag tag-gray">${esc(c)}</span>`).join(' ') : '<span class="muted small">—</span>'}</td>
          <td>${u.enabled ? '<span class="tag tag-green">启用</span>' : '<span class="tag tag-red">停用</span>'}</td>
          <td class="muted small">${esc((u.createdAt || '').slice(0, 10))}</td>
          <td class="td-actions">
            ${isViewerAdmin || !isPrivileged(u)
              ? `<button class="btn-text" data-act="edit">编辑</button>
            <button class="btn-text" data-act="pwd">重置密码</button>
            <button class="btn-text" data-act="toggle">${u.enabled ? '停用' : '启用'}</button>
            <button class="btn-text danger" data-act="del">删除</button>`
              : '<span class="muted small">—</span>'}
          </td>
        </tr>`
            )
            .join('')
        : '<tr><td colspan="7" class="table-empty">暂无账号</td></tr>';
    }

    // 账号角色定义（collegeOfficer 视角下特权角色不可见：仅 admin 可创建特权角色账号）
    const ROLE_DEFS = [
      { v: 'discipline', label: '纪律委员（学生）', kind: 'student' },
      { v: 'rights', label: '权益部（学生）', kind: 'student' },
      { v: 'headTeacher', label: '班主任（教职工）', kind: 'staff' },
      { v: 'counselor', label: '辅导员（教职工）', kind: 'staff' },
      { v: 'collegeOfficer', label: '学院考勤负责老师', kind: 'manual' },
      { v: 'admin', label: '管理员', kind: 'manual' },
    ].filter((r) => isViewerAdmin || !PRIVILEGED_ROLES.includes(r.v));

    // 编辑账号：姓名 / 角色 / 可点名班级
    function editAccountModal(u) {
      // 修改58：可点名班级改为「按年级分级多选」——未来班级增多时不再平铺，支持整组勾选
      const meta = classMetaCache.length ? classMetaCache : classesCache.map((name) => ({ name, count: 0, grade: '' }));
      // 修改59：年级归一化。真实数据里同一届可能写成「2025级」「2025」「2025级本科」等，
      // 原逻辑直接用 c.grade 会把它们拆成多个并列分组（用户截图里 2025级 与 2025 并存）。
      // 统一提取 4 位入学年并补「级」后缀；提取不到才回落到「未分年级」。
      const normGrade = (raw) => {
        const m = String(raw || '').match(/(19|20)\d{2}/);
        return m ? `${m[0]}级` : '';
      };
      const gradeOf = (c) => normGrade(c.grade) || normGrade(c.name) || '未分年级';
      const groupMap = new Map();
      for (const c of meta) {
        const g = gradeOf(c);
        if (!groupMap.has(g)) groupMap.set(g, []);
        groupMap.get(g).push(c);
      }
      const groups = [...groupMap.entries()]
        .sort((a, b) => String(b[0]).localeCompare(String(a[0]), 'zh')) // 新年级在前
        .map(([grade, items]) => ({ grade, items: items.sort((a, b) => a.name.localeCompare(b.name, 'zh')) }));
      // 修改59：树形节点。父节点＝年级（含该年级全部子节点），子节点＝班级。
      // 默认展开有已选班级的年级，其余折叠，避免一进来就是一长串平铺。
      const clsGroupsHtml = groups
        .map((g) => {
          const kids = g.items
            .map(
              (c) =>
                `<div class="tree-leaf"><label class="tree-leaf-lb"><input type="checkbox" name="cls" value="${esc(c.name)}" data-kw="${esc((c.name + ' ' + g.grade).toLowerCase())}" ${u.classes.includes(c.name) ? 'checked' : ''}/><span class="tree-leaf-name">${esc(c.name)}</span>${c.count ? `<span class="tree-leaf-meta">${c.count} 人</span>` : ''}</label></div>`
            )
            .join('');
          const open = g.items.some((c) => u.classes.includes(c.name));
          return `
        <div class="tree-node${open ? ' is-open' : ''}" data-grade="${esc(g.grade)}">
          <div class="tree-parent">
            <button type="button" class="tree-toggle" data-toggle aria-expanded="${open ? 'true' : 'false'}" aria-label="展开或折叠 ${esc(g.grade)}"><span class="tree-caret">${ICONS.chevron}</span></button>
            <label class="tree-parent-lb"><input type="checkbox" data-grade="${esc(g.grade)}" /><span class="tree-parent-name">${esc(g.grade)}</span><span class="tree-parent-meta">${g.items.length} 个班</span></label>
          </div>
          <div class="tree-children"${open ? '' : ' hidden'}>${kids}</div>
        </div>`;
        })
        .join('');
      modal({
        title: `编辑账号：${u.username}`,
        width: 520,
        okText: '保存',
        body: `
        <div class="form">
          <div class="form-item"><label>姓名<span class="req">*</span></label>
            <input class="input" name="name" value="${esc(u.name)}" /></div>
          <div class="form-item"><label>角色<span class="req">*</span>（可多选，权限按所分配角色合并生效）</label>
            <div class="check-list" id="roleChecks">
              ${['discipline', 'rights', 'headTeacher', 'counselor', 'collegeOfficer', 'admin']
                .filter((r) => isViewerAdmin || !PRIVILEGED_ROLES.includes(r))
                .map((r) => `<label><input type="checkbox" name="urole" value="${r}" ${rolesOf(u).includes(r) ? 'checked' : ''}/>${ROLE_NAMES[r]}</label>`)
                .join('')}
            </div>
            <div class="muted small" style="margin-top:4px">勾选多个角色即为该账号赋予多重身份；如需多重身份也可在创建后追加。首个勾选角色将作为主角色。</div></div>
          <div class="form-item"><label>可点名班级（所有账号均可设置 · 树形多选）</label>
            <div class="cls-pick">
              <button type="button" class="cls-pick-hd" id="clsPickBtn" aria-expanded="false" aria-controls="clsPickBody">
                <span class="cls-pick-sum" id="clsPickSum"></span>
                <span class="cls-pick-caret">${ICONS.chevron}</span>
              </button>
              <div class="cls-pick-body" id="clsPickBody" hidden>
                <div class="tree-search">${ICONS.search}<input class="input" id="clsTreeSearch" placeholder="搜索年级 / 班级" autocomplete="off" /></div>
                <div class="cls-pick-ops">
                  <button type="button" class="btn btn-sm" id="clsPickAll">全选</button>
                  <button type="button" class="btn btn-sm" id="clsPickNone">清空</button>
                  <span class="cls-pick-hint" id="clsTreeCount">共 ${meta.length} 个班级 · ${groups.length} 个年级</span>
                </div>
                <div class="cls-groups tree" id="clsTreeRoot">${clsGroupsHtml || '<span class="check-hint">暂无班级，请先在"班级名单"中导入</span>'}</div>
              </div>
            </div>
            <div class="muted small" style="margin-top:4px">所有账号均可设置可点名班级。按年级展开树形层级，点年级可整组勾选，也支持搜索定位；未勾选任何班级＝不限制班级（默认）。</div></div>
        </div>`,
        onMount: (wrap) => {
          const body = wrap.querySelector('#clsPickBody');
          const btn = wrap.querySelector('#clsPickBtn');
          const sum = wrap.querySelector('#clsPickSum');
          const root = wrap.querySelector('#clsTreeRoot');
          const search = wrap.querySelector('#clsTreeSearch');
          const counter = wrap.querySelector('#clsTreeCount');
          if (!body || !btn || !sum || !root) return;
          const boxes = () => [...body.querySelectorAll('input[name="cls"]')];
          // 父子联动：父勾选态由子节点推导（全选=实心、半选=indeterminate）
          const syncParent = (node) => {
            const kids = [...node.querySelectorAll('input[name="cls"]')];
            const head = node.querySelector('input[data-grade]');
            if (!head) return;
            const on = kids.filter((k) => k.checked).length;
            head.checked = kids.length > 0 && on === kids.length;
            head.indeterminate = on > 0 && on < kids.length;
            node.classList.toggle('has-on', on > 0);
          };
          const CH = 5; // 触发器最多展示 5 个 chip，多余折叠为「+N」
          const syncAll = () => {
            root.querySelectorAll('.tree-node').forEach(syncParent);
            const picked = boxes().filter((b) => b.checked);
            const n = picked.length;
            if (!n) {
              sum.innerHTML = '<span class="cls-pick-empty">暂未选择（不限班级）</span>';
            } else {
              const shown = picked.slice(0, CH);
              sum.innerHTML =
                shown.map((b) => `<span class="cls-chip">${esc(b.value)}</span>`).join('') +
                (n > CH ? `<span class="cls-chip cls-chip-more">+${n - CH}</span>` : '');
            }
            btn.classList.toggle('has-val', n > 0);
            if (counter) {
              const kw = (search ? search.value : '').trim().toLowerCase();
              counter.textContent = kw
                ? `匹配 ${boxes().filter((b) => b.dataset.kw && b.dataset.kw.includes(kw)).length} / ${boxes().length} 个班级`
                : `共 ${boxes().length} 个班级 · ${root.querySelectorAll('.tree-node').length} 个年级`;
            }
          };
          btn.addEventListener('click', () => {
            const open = body.hidden;
            body.hidden = !open;
            btn.setAttribute('aria-expanded', String(open));
            if (open && search) setTimeout(() => search.focus(), 30);
          });
          // 勾选联动：点父全选/取消子；点子由 syncParent 反推父
          body.addEventListener('change', (e) => {
            const head = e.target.closest('input[data-grade]');
            if (head) {
              head.closest('.tree-node').querySelectorAll('input[name="cls"]').forEach((k) => (k.checked = head.checked));
            }
            syncAll();
          });
          // 折叠/展开（点箭头，不影响勾选）
          body.addEventListener('click', (e) => {
            const tg = e.target.closest('[data-toggle]');
            if (!tg) return;
            e.preventDefault();
            const node = tg.closest('.tree-node');
            const kids = node.querySelector('.tree-children');
            const open = kids.hidden;
            kids.hidden = !open;
            node.classList.toggle('is-open', open);
            tg.setAttribute('aria-expanded', String(open));
          });
          // 搜索：按年级或班级名过滤，命中即展开所在年级
          if (search) {
            search.addEventListener('input', () => {
              const kw = search.value.trim().toLowerCase();
              root.querySelectorAll('.tree-node').forEach((node) => {
                const gname = (node.dataset.grade || '').toLowerCase();
                let hit = 0;
                node.querySelectorAll('.tree-leaf').forEach((leaf) => {
                  const cb = leaf.querySelector('input[name="cls"]');
                  const on = !kw || (cb.dataset.kw || '').includes(kw) || gname.includes(kw);
                  leaf.hidden = !on;
                  if (on) hit++;
                });
                node.hidden = hit === 0;
                if (kw && hit) {
                  node.classList.add('is-open');
                  const kids = node.querySelector('.tree-children');
                  if (kids) kids.hidden = false;
                  const t = node.querySelector('[data-toggle]');
                  if (t) t.setAttribute('aria-expanded', 'true');
                }
              });
              syncAll();
            });
          }
          wrap.querySelector('#clsPickAll').addEventListener('click', () => {
            boxes().forEach((b) => (b.checked = true));
            syncAll();
          });
          wrap.querySelector('#clsPickNone').addEventListener('click', () => {
            boxes().forEach((b) => (b.checked = false));
            syncAll();
          });
          syncAll();
        },
        onOk: async (wrap, close) => {
          const f = wrap.querySelector('.modal-body');
          const classes = [...f.querySelectorAll('input[name="cls"]:checked')].map((x) => x.value);
          const roles = [...f.querySelectorAll('input[name="urole"]:checked')].map((x) => x.value);
          if (!roles.length) throw new Error('请至少选择一个角色');
          await api(`/api/accounts/${u.id}`, {
            method: 'PUT',
            body: { name: f.querySelector('[name="name"]').value.trim(), roles, classes },
          });
          toast('账号已更新');
          close();
          load();
        },
      });
    }

    // 新建账号：按角色生成（学生账号=学号 / 教职工账号=工号 / 管理员手动创建），初始密码首登强制修改
    function createAccountModal() {
      // 供 onMount 渲染与 onOk 提交共用的选择器引用（作用域需覆盖两者）
      let stuSelect = null;
      let staffSelect = null;
      modal({
        title: '新建账号',
        width: 560,
        okText: '生成账号',
        body: `
        <div class="form">
          <div class="form-item"><label>账号角色<span class="req">*</span></label>
            <select class="select" name="role">
              ${ROLE_DEFS.map((r) => `<option value="${r.v}">${r.label}</option>`).join('')}
            </select></div>
          <div id="roleFields"></div>
        </div>`,
        onMount: async (wrap) => {
          const roleSel = wrap.querySelector('[name="role"]');
          const fields = wrap.querySelector('#roleFields');
          const renderFields = async () => {
            const v = roleSel.value;
            if (v === 'discipline' || v === 'rights') {
              // 学生账号：账号=学号，姓名自动带出，初始密码=Hzpt@学号后六位
              fields.innerHTML = `
                <div class="form-item"><label>班级<span class="req">*</span></label>
                  <select class="select" name="genCls"><option value="">选择班级</option>${classesCache.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}</select></div>
                <div class="form-item"><label>学生（可输入姓名 / 学号筛选）<span class="req">*</span></label>
                  <div id="genStuBox"></div></div>
                <div class="gen-preview">
                  <div>登录账号：<b id="genUser">—</b>（学号）</div>
                  <div>姓名：<b id="genName">—</b>（自动带出）</div>
                  <div>初始密码：<b id="genPwd">—</b>（Hzpt@学号后六位）</div>
                  <div class="muted small">${v === 'discipline' ? '将自动授权点名管理本班级；' : ''}首次登录时系统将强制引导修改密码</div>
                </div>`;
              const clsSel = fields.querySelector('[name="genCls"]');
              stuSelect = createSearchSelect({
                placeholder: '选择学生',
                emptyText: '未找到匹配的学生',
                onSelect: (sid) => {
                  const stu = rosterCache.find((x) => x.studentId === sid);
                  fields.querySelector('#genUser').textContent = sid || '—';
                  fields.querySelector('#genName').textContent = stu ? stu.name : '—';
                  fields.querySelector('#genPwd').textContent = sid ? `Hzpt@${sid.slice(-6)}` : '—';
                },
              });
              fields.querySelector('#genStuBox').appendChild(stuSelect.el);
              let rosterCache = [];
              clsSel.onchange = async () => {
                rosterCache = [];
                if (!clsSel.value) return;
                try {
                  const d = await api(`/api/attendance/roster?className=${encodeURIComponent(clsSel.value)}`);
                  rosterCache = d.students;
                } catch {
                  rosterCache = [];
                }
                stuSelect.setOptions(rosterCache.map((s) => ({ value: s.studentId, label: `${s.studentId} · ${s.name}` })));
              };
              await clsSel.dispatchEvent(new Event('change'));
            } else if (v === 'headTeacher' || v === 'counselor') {
              // 教职工账号：从教职工名单选择工号，姓名与所带班级自动带入
              const typeName = v === 'headTeacher' ? '班主任' : '辅导员';
              let staffList = [];
              try {
                staffList = (await api('/api/staffs')).list.filter((s) => s.type === typeName);
              } catch {
                staffList = [];
              }
              fields.innerHTML = `
                <div class="form-item"><label>选择教职工（${typeName}，可输入工号 / 姓名筛选）<span class="req">*</span></label>
                  <div id="genStaffBox"></div></div>
                <div class="gen-preview">
                  <div>登录账号：<b id="genUser">—</b>（工号）</div>
                  <div>姓名：<b id="genName">—</b>（自动带出）</div>
                  <div>所带班级：<span id="genClsPrev">—</span></div>
                  <div>初始密码：<b id="genPwd">—</b>（Hzpt@工号）</div>
                  <div class="muted small">首次登录时系统将强制引导修改密码</div>
                </div>`;
              staffSelect = createSearchSelect({
                placeholder: '选择教职工',
                emptyText: '未找到匹配的教职工',
                onSelect: (staffId) => {
                  const st = staffList.find((x) => x.staffId === staffId);
                  fields.querySelector('#genUser').textContent = staffId || '—';
                  fields.querySelector('#genName').textContent = st ? st.name : '—';
                  fields.querySelector('#genClsPrev').textContent = st && st.classes.length ? st.classes.join('、') : '无';
                  fields.querySelector('#genPwd').textContent = `Hzpt@${staffId}`;
                },
              });
              fields.querySelector('#genStaffBox').appendChild(staffSelect.el);
              staffSelect.setOptions(staffList.map((s) => ({ value: s.staffId, label: `${s.staffId} · ${s.name}` })));
            } else {
              fields.innerHTML = `
                <div class="form-item"><label>登录账号<span class="req">*</span></label>
                  <input class="input" name="username" placeholder="字母 / 数字 / 下划线" /></div>
                <div class="form-item"><label>姓名<span class="req">*</span></label>
                  <input class="input" name="name" placeholder="真实姓名" /></div>
                <div class="form-item"><label>初始密码<span class="req">*</span></label>
                  <input class="input" name="password" placeholder="至少 6 位" /></div>
                <div class="muted small">${esc(ROLE_NAMES[roleSel.value] || '该角色')}账号为手动创建（自定义登录账号与初始密码），首次登录将强制修改密码。如需多重身份（如"权益部 + 辅导员"），创建后可在列表「编辑」中追加角色。</div>`;
            }
          };
          roleSel.onchange = renderFields;
          renderFields();
        },
        onOk: async (wrap, close) => {
          const role = wrap.querySelector('[name="role"]').value;
          const f = wrap.querySelector('#roleFields');
          if (role === 'discipline' || role === 'rights') {
            const className = f.querySelector('[name="genCls"]').value;
            const studentId = stuSelect.getValue();
            if (!className || !studentId) throw new Error('请选择班级与学生');
            const r = await api('/api/accounts/generate/student', { method: 'POST', body: { role, className, studentId } });
            toast(`账号已生成：${r.user.username}（${r.user.name}），初始密码 ${r.initialPassword}`);
          } else if (role === 'headTeacher' || role === 'counselor') {
            const staffId = staffSelect.getValue();
            if (!staffId) throw new Error(`教职工名单中暂无${role === 'headTeacher' ? '班主任' : '辅导员'}人员，请先在"教职工名单"页签添加`);
            const r = await api('/api/accounts/generate/staff', { method: 'POST', body: { role, staffId } });
            toast(`账号已生成：${r.user.username}（${r.user.name}），初始密码 ${r.initialPassword}`);
          } else {
            const username = f.querySelector('[name="username"]').value.trim();
            const name = f.querySelector('[name="name"]').value.trim();
            const password = f.querySelector('[name="password"]').value;
            if (!username || !name || !password) throw new Error('请完整填写账号信息');
            await api('/api/accounts', { method: 'POST', body: { username, name, password, role } });
            toast(`${ROLE_NAMES[role] || '账号'}已创建`);
          }
          close();
          load();
        },
      });
    }


    root.querySelector('#btnAdd').onclick = () => createAccountModal();

    root.querySelector('#btnSearch').onclick = () => {
      state.q = root.querySelector('#q').value.trim();
      state.role = root.querySelector('#roleFilter').value;
      state.page = 1;
      load();
    };
    root.querySelector('#q').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') root.querySelector('#btnSearch').click();
    });

    tbody.onclick = async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      // 修复52：手机端卡片化会把操作按钮移出 <tr> 移入 .rc-card，故不能只找 tr
      // （只找 tr 会得到 null 并抛错，表现为按钮全部无响应）
      const id = e.target.closest('tr, .rc-card')?.dataset.id;
      if (!id) return;
      const u = listCache.find((x) => x.id === id);
      if (!u) return;
      if (act === 'edit') return editAccountModal(u);
      if (act === 'pwd') {
        modal({
          title: `重置密码：${u.username}`,
          width: 420,
          okText: '重置',
          body: `<div class="form"><div class="form-item"><label>新密码<span class="req">*</span></label>
            <input class="input" name="pwd" placeholder="至少 6 位" /></div></div>`,
          onOk: async (wrap, close) => {
            const pwd = wrap.querySelector('[name="pwd"]').value;
            await api(`/api/accounts/${u.id}/password`, { method: 'PUT', body: { password: pwd } });
            toast('密码已重置');
            close();
          },
        });
        return;
      }
      if (act === 'toggle') {
        await api(`/api/accounts/${u.id}`, { method: 'PUT', body: { enabled: !u.enabled } });
        toast(u.enabled ? '账号已停用' : '账号已启用');
        load();
        return;
      }
      if (act === 'del') {
        const ok = await confirmDialog(`确定删除账号 <b>${esc(u.username)}</b>（${esc(u.name)}）吗？删除后不可恢复。`, { danger: true, title: '删除账号' });
        if (!ok) return;
        await api(`/api/accounts/${u.id}`, { method: 'DELETE' });
        toast('账号已删除');
        load();
      }
    };

    // ==================== 教职工名单管理 ====================
    const staffTbody = root.querySelector('#staffTbody');
    const staffInfoEl = root.querySelector('#staffInfo');
    const staffSelInfo = root.querySelector('#staffSelInfo');
    const btnStaffGen = root.querySelector('#btnStaffGen');
    const staffCheckAll = root.querySelector('#staffCheckAll');
    // 修改34：勾选状态（key = staffId），用于「批量生成账号」
    const staffSelected = new Set();
    const staffCache = new Map();

    function syncStaffSelection() {
      const n = staffSelected.size;
      staffSelInfo.textContent = n ? `已勾选 ${n} 名教职工` : '未勾选人员';
      btnStaffGen.disabled = n === 0;
      btnStaffGen.textContent = n ? `批量生成账号（${n}）` : '批量生成账号';
      if (staffCheckAll) {
        const ids = [...staffCache.keys()];
        staffCheckAll.checked = ids.length > 0 && ids.every((id) => staffSelected.has(id));
        staffCheckAll.indeterminate = n > 0 && !staffCheckAll.checked;
      }
    }

    async function loadStaff() {
      staffTbody.innerHTML = '<tr><td colspan="7" class="table-empty">加载中…</td></tr>';
      const d = await api('/api/staffs');
      staffInfoEl.textContent = `共 ${d.total} 名教职工`;
      staffCache.clear();
      staffSelected.clear();
      staffTbody.innerHTML = d.list.length
        ? d.list
            .map((s) => {
              staffCache.set(s.staffId, s);
              const hasAccount = Boolean(s.hasAccount); // 已生成过账号的工号禁止重复建号
              return `
        <tr data-id="${s.id}" data-staff-id="${esc(s.staffId)}">
          <td><input type="checkbox" class="stfChk" data-staff-id="${esc(s.staffId)}" ${hasAccount ? 'disabled title="已生成过账号"' : ''}/></td>
          <td class="num"><b>${esc(s.staffId)}</b></td>
          <td>${esc(s.name)}</td>
          <td><span class="tag ${s.type === '班主任' ? 'tag-purple' : 'tag-orange'}">${esc(s.type)}</span></td>
          <td>${s.classes.length ? s.classes.map((c) => `<span class="tag tag-gray">${esc(c)}</span>`).join(' ') : '<span class="muted small">—</span>'}</td>
          <td>${hasAccount ? '<span class="tag tag-green">已建账号</span>' : '<span class="muted small">未建</span>'}</td>
          <td class="td-actions">
            <button class="btn-text" data-act="edit">编辑</button>
            <button class="btn-text danger" data-act="del">删除</button>
          </td>
        </tr>`;
            })
            .join('')
        : '<tr><td colspan="7" class="table-empty">暂无教职工，点击"批量导入"或"新增教职工"添加</td></tr>';
      syncStaffSelection();
    }

    function staffModal(st) {
      const isEdit = !!st;
      modal({
        title: isEdit ? `编辑教职工：${st.staffId}` : '新增教职工',
        width: 600,
        okText: isEdit ? '保存' : '添加',
        body: `
        <div class="form">
          <div class="form-row">
            <div class="form-item" style="flex:0 0 160px"><label>工号<span class="req">*</span></label>
              <input class="input" name="staffId" value="${esc(st ? st.staffId : '')}" ${isEdit ? 'disabled' : ''} placeholder="教职工工号" /></div>
            <div class="form-item"><label>姓名<span class="req">*</span></label>
              <input class="input" name="name" value="${esc(st ? st.name : '')}" placeholder="教师姓名" /></div>
          </div>
          <div class="form-item"><label>岗位<span class="req">*</span></label>
            <select class="select" name="type">
              <option value="班主任" ${st && st.type === '班主任' ? 'selected' : ''}>班主任</option>
              <option value="辅导员" ${st && st.type === '辅导员' ? 'selected' : ''}>辅导员</option>
            </select></div>
          <div class="form-item"><label>所带班级（可多选）</label>
            <div class="check-list">${classesCache.map((c) => `<label style="margin-right:14px"><input type="checkbox" name="scls" value="${esc(c)}" ${st && st.classes.includes(c) ? 'checked' : ''}/>${esc(c)}</label>`).join('') || '<span class="check-hint">暂无班级，请先在"班级名单"中导入</span>'}</div></div>
        </div>`,
        onOk: async (wrap, close) => {
          const f = wrap.querySelector('.modal-body');
          const payload = {
            staffId: f.querySelector('[name="staffId"]').value.trim(),
            name: f.querySelector('[name="name"]').value.trim(),
            type: f.querySelector('[name="type"]').value,
            classes: [...f.querySelectorAll('input[name="scls"]:checked')].map((x) => x.value),
          };
          if (isEdit) {
            await api(`/api/staffs/${st.id}`, { method: 'PUT', body: { name: payload.name, type: payload.type, classes: payload.classes } });
            toast('教职工信息已更新');
          } else {
            await api('/api/staffs', { method: 'POST', body: payload });
            toast('教职工已添加');
          }
          close();
          loadStaff();
        },
      });
    }

    root.querySelector('#btnStaffAdd').onclick = () => staffModal(null);

    // ==================== 修改34：批量导入（系统账号 / 教职工名单） ====================
    // 结果面板追加「下载账号密码清单」：密码明文仅本次返回，便于管理员直接分发
    function renderCreatedSheet(created, filename) {
      if (!created || !created.length) return;
      const box = document.createElement('div');
      box.className = 'import-result';
      box.innerHTML = `
        <div class="ir-line ok">✓ 本次共生成 ${created.length} 个账号，请点击下方按钮下载账号与初始密码清单（密码仅本次可见）：</div>
        <ul class="ir-errs" style="max-height:180px">${created
          .slice(0, 20)
          .map((x) => `<li>${esc(x.username)} · ${esc(x.name)} · ${esc(x.roles || '')} · 初始密码 <b>${esc(x.password)}</b></li>`)
          .join('')}</ul>`;
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary btn-sm';
      btn.style.marginTop = '8px';
      btn.textContent = '下载账号密码清单（.xlsx）';
      btn.onclick = () =>
        apiPostDownload(
          '/api/xlsx/build',
          { filename, headers: ['登录账号', '姓名', '角色', '初始密码'], rows: created.map((x) => [x.username, x.name, x.roles || '', x.password]) },
          filename
        ).catch((e) => toast(e.message || '导出失败', 'error'));
      box.appendChild(btn);
      return box;
    }

    // 系统账号批量导入
    root.querySelector('#btnAccImport').onclick = () => {
      importModal({
        title: '批量导入系统账号',
        templateName: 'accounts',
        templateFile: '系统账号批量导入模板.xlsx',
        tip: `仅支持 <b>.xlsx</b> 格式（首个工作表，首行为表头）。<br/>
          <b>列说明</b>：姓名（必填）、角色（必填，可写「纪律委员 / 权益部 / 班主任 / 辅导员 / 管理员 / 学院考勤负责老师」，多个角色用顿号分隔）、登录账号（可留空，留空则按角色自动生成：学生角色取学号、教职工角色取工号）、学号或工号、初始密码（可留空，留空则自动生成）、可点名班级（多个用顿号分隔）。<br/>
          <b>初始密码规则</b>：学生账号 = <code>Hzpt@学号后六位</code>，教职工账号 = <code>Hzpt@工号</code>。<br/>
          <b>班级匹配（修改35）</b>：可点名班级中<b>无法匹配到班级名单</b>的项会被<b>跳过（该字段留空）</b>，但账号<b>仍正常创建</b>。<br/>
          <b>学号校验（修改35）</b>：角色为<b>纪律委员 / 权益部</b>时，学号必须能在班级名单中找到，否则<b>该账号不予导入</b>（整行未处理）。<br/>
          <b>去重规则</b>：账号已存在或表内重复将直接跳过，<b>不会改动已有账号</b>；单行失败不影响其他行。`,
        noticeTitle: '以下行的部分字段因未匹配到班级名单 / 学号校验问题而被处理，请核对：',
        doImport: (rows) => api('/api/accounts/import', { method: 'POST', body: { rows } }),
        onDone: (r) => {
          load();
          const sheet = renderCreatedSheet(r.created, '账号密码清单.xlsx');
          if (sheet) {
            const box = document.querySelector('#impResult .import-result');
            if (box) box.appendChild(sheet);
          }
        },
      });
    };

    // 教职工名单批量导入（可勾选"同时生成账号"）
    root.querySelector('#btnStaffImport').onclick = () => {
      modal({
        title: '批量导入教职工名单',
        width: 520,
        okText: '选择文件并导入',
        body: `
          <div class="form">
            <div class="form-item"><label>导入选项</label>
              <label class="import-opt"><input type="checkbox" id="optCreateAcc" checked />
                <span>同时批量生成账号（班主任 / 辅导员账号，账号 = 工号，初始密码 = <code>Hzpt@工号</code>）</span></label>
              <div class="muted small" style="margin-top:6px">已存在的工号<b>不会被改动账号密码</b>；但其姓名 / 岗位 / 所带班级会按本次表格<b>更新</b>（修改35）。</div>
            </div>
          </div>`,
        onOk: async (wrap, close) => {
          // 先取值再关闭：close() 会移除整个 wrap，元素引用随之失效
          const createAccounts = wrap.querySelector('#optCreateAcc')?.checked === true;
          close();
          importModal({
            title: '批量导入教职工名单',
            templateName: 'staffs',
            templateFile: '教职工名单导入模板.xlsx',
            tip: `仅支持 <b>.xlsx</b> 格式（首个工作表，首行为表头）。<br/>
              <b>列说明</b>：工号（必填，2-20 位字母/数字/下划线/短横线）、姓名（必填）、岗位（必填，班主任 或 辅导员）、所带班级（多个用顿号分隔，可留空）。<br/>
              <b>班级匹配（修改35）</b>：所带班级中<b>无法匹配到班级名单</b>的项会被<b>跳过（该字段留空）</b>，但该教职工<b>仍正常导入名单</b>、<b>仍正常创建账号</b>。<br/>
              <b>重复工号（修改35）</b>：同一工号再次导入时<b>执行更新</b>（姓名 / 岗位 / 所带班级），而非跳过；该列<b>留空则不改动原值</b>。内容与原记录完全一致时记为「跳过重复」。<br/>
              <b>结果分区</b>：完全导入 / 部分导入（字段被跳过）/ 不予导入（校验失败）会在结果面板分别计数。<br/>
              单行失败不影响其他行。${createAccounts ? '<br/><b>已开启「同时生成账号」</b>：新增与更新的教职工都会尝试建号；已建过账号的工号会跳过建号。' : ''}`,
            noticeTitle: '以下行已处理，请核对（字段被跳过或记录已更新）：',
            doImport: (rows) => api('/api/staffs/import', { method: 'POST', body: { rows, createAccounts } }),
            onDone: (r) => {
              loadStaff();
              const sheet = renderCreatedSheet(r.created, '教职工账号密码清单.xlsx');
              if (sheet) {
                const box = document.querySelector('#impResult .import-result');
                if (box) box.appendChild(sheet);
              }
            },
          });
        },
      });
    };

    // 列表勾选批量生成账号
    staffTbody.addEventListener('change', (e) => {
      const chk = e.target.closest('.stfChk');
      if (!chk) return;
      const id = chk.dataset.staffId;
      if (chk.checked) staffSelected.add(id);
      else staffSelected.delete(id);
      syncStaffSelection();
    });
    if (staffCheckAll) {
      staffCheckAll.onchange = () => {
        staffSelected.clear();
        if (staffCheckAll.checked) {
          staffTbody.querySelectorAll('.stfChk:not(:disabled)').forEach((c) => {
            staffSelected.add(c.dataset.staffId);
            c.checked = true;
          });
        } else {
          staffTbody.querySelectorAll('.stfChk').forEach((c) => (c.checked = false));
        }
        syncStaffSelection();
      };
    }
    btnStaffGen.onclick = async () => {
      const ids = [...staffSelected];
      if (!ids.length) return;
      const ok = await confirmDialog(
        `将为勾选的 <b>${ids.length}</b> 名教职工批量生成账号：<br/>账号 = 工号，角色按岗位自动判定（班主任 → 班主任，辅导员 → 辅导员），初始密码 = <code>Hzpt@工号</code>，首次登录强制改密。`,
        { title: '批量生成账号' }
      );
      if (!ok) return;
      let r;
      try {
        r = await api('/api/staffs/generate-accounts', { method: 'POST', body: { staffIds: ids } });
      } catch (e) {
        toast(e.message, 'error');
        return;
      }
      const rows = r.results || [];
      // 修改34：下载按钮直接内联进结果弹窗。
      // 原实现用 document.querySelector('.modal-body .import-result') 在弹窗外 append，
      // 会命中"先存在的其它弹窗"（导入选项 / 确认弹窗残留）→ 按钮挂错位置、点了没反应。
      modal({
        title: '批量生成账号结果',
        width: 720,
        showFooter: false,
        body: `<div class="import-result">
            <div class="ir-line ok">✓ 勾选 ${r.total} 名，成功生成 ${r.imported} 个账号${r.failed ? `，${r.failed} 条未处理` : ''}</div>
            ${rows.length ? `<ul class="ir-errs" style="max-height:220px">${rows
              .map((x) => `<li>${esc(x.username)} · ${esc(x.name)} · ${esc(x.roles || '')} · 初始密码 <b>${esc(x.password)}</b></li>`)
              .join('')}</ul>
            <div class="ir-line warn">⚠ 初始密码仅本次可见，请及时下载清单并妥善分发。</div>
            <button class="btn btn-primary btn-sm" id="dlAcct" style="margin-top:8px">下载账号密码清单（.xlsx）</button>` : ''}
            ${(r.errors || []).length ? `<div class="ir-line bad">✗ 以下未处理：</div><ul class="ir-errs">${r.errors.map((x) => `<li>${esc(x.message)}</li>`).join('')}</ul>` : ''}
          </div>`,
        onMount: (wrap) => {
          const b = wrap.querySelector('#dlAcct');
          if (b)
            b.onclick = () =>
              apiPostDownload(
                '/api/xlsx/build',
                {
                  filename: '教职工账号密码清单.xlsx',
                  headers: ['登录账号', '姓名', '角色', '初始密码'],
                  rows: rows.map((x) => [x.username, x.name, x.roles || '', x.password]),
                },
                '教职工账号密码清单.xlsx'
              ).catch((e) => toast(e.message || '导出失败', 'error'));
        },
      });
      loadStaff();
      load();
    };

    staffTbody.onclick = async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      // 修复52：同上，手机端卡片化后按钮不在 <tr> 内
      const id = e.target.closest('tr, .rc-card')?.dataset.id;
      if (!id) return;
      const d = await api('/api/staffs');
      const st = d.list.find((x) => x.id === id);
      if (!st) return;
      if (act === 'edit') return staffModal(st);
      if (act === 'del') {
        const ok = await confirmDialog(`确定删除教职工 <b>${esc(st.name)}</b>（${esc(st.staffId)}）吗？`, { danger: true, title: '删除教职工' });
        if (!ok) return;
        try {
          await api(`/api/staffs/${id}`, { method: 'DELETE' });
          toast('教职工已删除');
          loadStaff();
        } catch (ex) {
          toast(ex.message, 'error');
        }
      }
    };

    // ==================== 页签切换 ====================
    const usersPane = root.querySelector('#usersPane');
    const staffPane = root.querySelector('#staffPane');
    root.querySelectorAll('#acctTabs .tab-btn').forEach((b) => {
      b.onclick = () => {
        root.querySelectorAll('#acctTabs .tab-btn').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        usersPane.style.display = b.dataset.tab === 'users' ? '' : 'none';
        staffPane.style.display = b.dataset.tab === 'staffs' ? '' : 'none';
        if (b.dataset.tab === 'staffs') loadStaff();
      };
    });

    await load();
  },
};
