import { api, setToken, getToken } from './api.js';
import { getUser, setUser, clearUser, hasAnyRole, rolesOf } from './session.js';
import { esc, ICONS, ROLE_NAMES, toast, enhanceTables, mobilizeCards } from './ui.js';
import ChangePasswordView from './pages/changePassword.js';
import ConfirmView from './pages/confirm.js';
import AbsencePublicView from './pages/absencePublic.js';
import LoginView from './pages/login.js';
import DashboardView from './pages/dashboard.js';
import AccountsView from './pages/accounts.js';
import RosterView from './pages/roster.js';
// 修改72：班级管理（班级信息的唯一维护入口，与班级名单联动）
import ClassesView from './pages/classes.js';
import { RollcallListView, RollcallNewView, RollcallDetailView } from './pages/rollcall.js';
import LeavesView from './pages/leaves.js';
import StatsView from './pages/stats.js';
import DataManageView from './pages/dataManage.js';
import AppealsView from './pages/appeals.js';
import PunishmentsView from './pages/punishments.js';

const app = document.getElementById('app');

const MENU = [
  { key: 'dashboard', label: '工作台', icon: 'grid', path: '#/dashboard', roles: ['admin', 'rights', 'discipline', 'headTeacher', 'counselor'] },
  { key: 'accounts', label: '账号管理', icon: 'users', path: '#/accounts', roles: ['admin', 'collegeOfficer'] },
  { key: 'datamgmt', label: '数据管理', icon: 'database', path: '#/datamgmt', roles: ['admin'] },
  { key: 'roster', label: '班级名单', icon: 'list', path: '#/roster', roles: ['admin', 'rights', 'collegeOfficer'] },
  // 修改72：班级管理 —— 班级信息（年级/专业/班主任/辅导员/纪律委员）的唯一维护入口
  { key: 'classes', label: '班级管理', icon: 'school', path: '#/classes', roles: ['admin', 'collegeOfficer'] },
  { key: 'rollcall', label: '考勤点名', icon: 'check', path: '#/rollcall', roles: ['admin', 'rights', 'discipline', 'headTeacher', 'counselor', 'collegeOfficer'] },
  { key: 'leaves', label: '假单管理', icon: 'file', path: '#/leaves', roles: ['admin', 'rights', 'collegeOfficer'] },
  { key: 'stats', label: '数据统计', icon: 'chart', path: '#/stats', roles: ['admin', 'rights', 'headTeacher', 'counselor', 'collegeOfficer'] },
  { key: 'absence', label: '缺勤公示', icon: 'search', path: '#/absence', roles: ['admin', 'rights', 'discipline', 'headTeacher', 'counselor', 'collegeOfficer'] },
  { key: 'appeals', label: '考勤异议', icon: 'message', path: '#/appeals', roles: ['admin', 'rights', 'collegeOfficer'] },
  // 修改30：处分管理（纪律委员不可见；班主任/辅导员只读，后端按所带班级过滤）
  { key: 'punishments', label: '处分管理', icon: 'gavel', path: '#/punishments', roles: ['admin', 'rights', 'headTeacher', 'counselor', 'collegeOfficer'] },
];

const ROUTES = [
  { path: '/login', view: LoginView, public: true },
  { path: '/confirm/:token', view: ConfirmView, public: true },
  { path: '/absence', view: AbsencePublicView, public: true, menu: 'absence' },
  { path: '/change-password', view: ChangePasswordView },
  { path: '/dashboard', view: DashboardView, menu: 'dashboard' },
  { path: '/accounts', view: AccountsView, menu: 'accounts', roles: ['admin', 'collegeOfficer'] },
  { path: '/datamgmt', view: DataManageView, menu: 'datamgmt', roles: ['admin'] },
  { path: '/roster', view: RosterView, menu: 'roster', roles: ['admin', 'rights', 'collegeOfficer'] },
  { path: '/classes', view: ClassesView, menu: 'classes', roles: ['admin', 'collegeOfficer'] },
  { path: '/rollcall', view: RollcallListView, menu: 'rollcall' },
  { path: '/rollcall/new', view: RollcallNewView, menu: 'rollcall' },
  { path: '/rollcall/:id', view: RollcallDetailView, menu: 'rollcall' },
  { path: '/leaves', view: LeavesView, menu: 'leaves', roles: ['admin', 'rights', 'collegeOfficer'] },
  { path: '/stats', view: StatsView, menu: 'stats', roles: ['admin', 'rights', 'headTeacher', 'counselor', 'collegeOfficer'] },
  { path: '/appeals', view: AppealsView, menu: 'appeals', roles: ['admin', 'rights', 'collegeOfficer'] },
  { path: '/punishments', view: PunishmentsView, menu: 'punishments', roles: ['admin', 'rights', 'headTeacher', 'counselor', 'collegeOfficer'] },
];

function matchRoute(path) {
  const aa = path.split('/').filter(Boolean);
  for (const r of ROUTES) {
    const pp = r.path.split('/').filter(Boolean);
    if (pp.length !== aa.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(aa[i]);
      else if (pp[i] !== aa[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route: r, params };
  }
  return null;
}

// 修改26：PC 侧栏折叠状态持久化（≤920px 抽屉不受影响）
const SB_KEY = 'kq_sidebar_collapsed';
/** 修改53：主题偏好键（与 index.html 的引导脚本同名，务必一致） */
const THEME_KEY = 'kq_theme';

function layoutHtml(activeKey) {
  const user = getUser();
  const menu = MENU.filter((m) => hasAnyRole(user, m.roles));
  const current = MENU.find((m) => m.key === activeKey);
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date().getDay()];
  const d = new Date();
  const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${week}`;
  let sbCollapsed = false;
  try { sbCollapsed = localStorage.getItem(SB_KEY) === '1'; } catch { /* 隐私模式忽略 */ }
  // 修改24：菜单按语义分两组展示（高频业务在前，管理类在后），空组不渲染分组标题
  // 修改72：「管理」分组新增班级管理（排在班级名单之后，与"先建班、后录名单"的操作顺序一致）
  const G1 = ['dashboard', 'rollcall', 'leaves', 'stats', 'absence', 'appeals', 'punishments'];
  const G2 = ['roster', 'classes', 'accounts', 'datamgmt'];
  const groups = [
    { cap: '工 作 台', keys: G1 },
    { cap: '管 理', keys: G2 },
  ];
  const capHtml = (cap) => `<div class="side-cap">${cap}</div>`;
  const itemHtml = (m) => `
          <a class="menu-item ${m.key === activeKey ? 'active' : ''}" href="${m.path}" data-tip="${m.label}">
            <span class="mi-icon">${ICONS[m.icon]}</span><span class="mi-label">${m.label}</span>
          </a>`;
  const menuHtml = groups
    .map((g) => {
      // 按分组定义的 keys 顺序取项（此前用 menu.filter，保留的是 MENU 原序，
      // 导致「管 理」分组下实际显示为 账号管理 → 数据管理 → 班级名单，与定义顺序不符）
      const items = g.keys.map((k) => menu.find((m) => m.key === k)).filter(Boolean);
      return items.length ? capHtml(g.cap) + items.map(itemHtml).join('') : '';
    })
    .join('');
  const orphans = menu.filter((m) => !G1.includes(m.key) && !G2.includes(m.key));
  const menuBlock = menuHtml + orphans.map(itemHtml).join('');
  return `
  <div class="shell">
    <div class="sidebar-mask" id="sidebarMask"></div>
    <aside class="sidebar ${sbCollapsed ? 'collapsed' : ''}" id="sidebar">
      <div class="brand"><span class="brand-icon">${ICONS.logo}</span><span class="brand-text"><span>学生考勤工作台</span><span class="brand-sub">ATTENDANCE CONSOLE</span></span></div>
      <nav class="menu">
        ${menuBlock}
      </nav>
      <div class="sidebar-foot">
        <button class="btn-collapse" id="btnCollapse" aria-label="折叠/展开菜单">${ICONS.chevron}<span class="bc-text">收起菜单</span></button>
        <div class="side-user">
          <div class="avatar">${esc((user.name || '?').slice(0, 1))}</div>
          <div class="su-text"><div class="su-name">${esc(user.name)}</div><div class="su-role">${esc(rolesOf(user).map((r) => ROLE_NAMES[r]).filter(Boolean).join(' / '))}</div></div>
        </div>
        <button class="btn-logout" id="btnLogout">${ICONS.logout}<span class="bl-text">退出登录</span></button>
      </div>
    </aside>
    <div class="frame">
      <header class="topbar">
        <div style="display:flex;align-items:center;min-width:0">
          <button class="nav-toggle" id="navToggle" aria-label="打开菜单">${ICONS.menu}</button>
          <button class="theme-toggle" id="themeToggle" type="button" role="switch" aria-checked="false" aria-label="暗夜模式" title="切换白天 / 暗夜"><span class="tt-moon">${ICONS.moon}</span><span class="tt-sun">${ICONS.sun}</span></button>
          <div class="crumb" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${current && current.key !== 'dashboard' ? `<span>工作台</span><i>/</i><b>${current.label}</b>` : '<b>工作台</b>'}</div>
        </div>
        <div class="topbar-right"><span>${dateStr}</span><span class="tag tag-blue">${esc(rolesOf(user).map((r) => ROLE_NAMES[r]).filter(Boolean).join(' · '))}</span></div>
      </header>
      <main class="content" id="view"></main>
    </div>
  </div>`;
}

function bindLayout() {
  document.getElementById('btnLogout').onclick = async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      /* 忽略登出接口错误 */
    }
    setToken('');
    clearUser();
    location.hash = '#/login';
  };
  // 移动端抽屉导航
  const sidebar = document.getElementById('sidebar');
  const mask = document.getElementById('sidebarMask');
  const closeDrawer = () => {
    sidebar?.classList.remove('open');
    mask?.classList.remove('show');
  };
  document.getElementById('navToggle')?.addEventListener('click', () => {
    const open = sidebar.classList.toggle('open');
    mask?.classList.toggle('show', open);
  });
  mask?.addEventListener('click', closeDrawer);
  document.querySelectorAll('.menu-item').forEach((a) => a.addEventListener('click', closeDrawer));

  // 修改53：手机端主题开关（白天 / 暗夜）。默认白天；选择记入 localStorage 并由 index.html
  // 的引导脚本在样式表之前回填，避免切主题白闪。按钮仅在 ≤720px 显示（桌面端零改动）。
  const themeBtn = document.getElementById('themeToggle');
  if (themeBtn) {
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    const syncThemeBtn = () => {
      const dark = document.documentElement.getAttribute('data-theme') === 'dark';
      themeBtn.setAttribute('aria-checked', String(dark));
      if (metaTheme) metaTheme.setAttribute('content', dark ? '#141A2E' : '#EEEBFF');
    };
    themeBtn.addEventListener('click', () => {
      const dark = document.documentElement.getAttribute('data-theme') === 'dark';
      if (dark) document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', 'dark');
      try { localStorage.setItem(THEME_KEY, dark ? 'light' : 'dark'); } catch { /* 隐私模式忽略 */ }
      syncThemeBtn();
    });
    syncThemeBtn();
  }
  // 修改26：PC 侧栏折叠/展开切换（类切换触发 CSS 过渡；状态持久化跨路由生效）
  document.getElementById('btnCollapse')?.addEventListener('click', () => {
    const next = !sidebar.classList.contains('collapsed');
    sidebar.classList.toggle('collapsed', next);
    try { localStorage.setItem(SB_KEY, next ? '1' : '0'); } catch { /* 隐私模式忽略 */ }
  });
}

async function render() {
  try {
    await renderRoute();
  } catch (e) {
    // 兜底：任何渲染错误都给出可见提示，避免白屏
    console.error('[render]', e);
    app.innerHTML = `<div class="login-wrap"><div class="login-card" style="max-width:440px;text-align:center"><div class="login-logo"><span class="brand-icon">${ICONS.logo}</span></div><h1 style="font-size:19px">页面加载出错</h1><p class="login-sub">${esc(e.message || '未知错误')}</p></div></div>`;
  }
}

async function renderRoute() {
  const path = (location.hash.replace(/^#/, '') || '/dashboard').split('?')[0];
  const matched = matchRoute(path);
  if (!matched) {
    location.replace('#/dashboard');
    return;
  }
  const { route, params } = matched;
  const user = getUser();
  if (!route.public && !user) {
    location.replace('#/login');
    return;
  }
  // 首次登录强制修改初始密码：未完成改密前无法进入其他页面
  if (user && user.mustChangePassword && path !== '/change-password') {
    location.replace('#/change-password');
    return;
  }
  if (route.public && user && route.path === '/login') {
    location.replace('#/dashboard');
    return;
  }
  if (route.roles && !hasAnyRole(user, route.roles)) {
    toast('没有权限访问该页面', 'error');
    location.replace('#/dashboard');
    return;
  }
  // 公开页默认独立挂载（登录页 / 任课老师免登录确认页：工作台布局依赖已登录用户，未登录会崩）；
  // 已登录用户访问带 menu 的公开页（如缺勤公示）则进工作台布局，保持导航栏体验一致
  // 修改24：公开页独立挂载同样给入场过渡（免登录公示页/登录页）
  if (route.public && !(user && route.menu)) {
    app.classList.remove('view-enter');
    void app.offsetWidth; // 强制 reflow 重启动画
    await route.view.mount(app, params);
    app.classList.add('view-enter');
    return;
  }
  app.innerHTML = layoutHtml(route.menu);
  bindLayout();
  const view = document.getElementById('view');
  view.classList.remove('view-enter');
  void view.offsetWidth;
  try {
    await route.view.mount(view, params);
    enhanceTables(view); // 移动端卡片式表格的字段标注
    mobilizeCards(view); // 修改38：记录型表格（data-card）转复合卡片
    watchView(view); // 修改38：tab 切换 / 查询按钮等页面内二次渲染的新表格兜底转卡片
  } catch (e) {
    view.innerHTML = `<div class="page"><div class="card empty-card">页面加载失败：${esc(e.message)}</div></div>`;
  }
  view.classList.add('view-enter');
}

// 修改38：视图级兜底 Observer。路由 mount 只在首次渲染后调用一次 enhanceTables/mobilizeCards，
// 但各页面内部的 tab 切换（数据管理 dm-tab、统计 tab-btn、异议 seg-btn）、查询按钮（灰测查询、
// 公示榜）会整表替换 innerHTML——新表格既没有 data-label 也没有卡片。这里监听视图子树变化，
// 防抖后重扫。两个函数均幂等（data-label 重复设置无害；rcDone 标记 + pending 判断跳过已处理表格），
// 与表格级 / 弹窗级 Observer 不会形成循环：卡片构建的 DOM 变更再触发本 Observer 后重扫为空操作。
let _viewObs = null;
let _viewTimer = null;
function watchView(view) {
  if (_viewObs) _viewObs.disconnect();
  _viewObs = new MutationObserver(() => {
    clearTimeout(_viewTimer);
    _viewTimer = setTimeout(() => {
      enhanceTables(view);
      mobilizeCards(view);
    }, 60);
  });
  _viewObs.observe(view, { childList: true, subtree: true });
}

async function boot() {
  window.addEventListener('hashchange', render);
  if (getToken()) {
    try {
      const d = await api('/api/auth/me');
      setUser(d.user);
    } catch {
      /* 401 时 api 已清空并跳转 */
    }
  }
  render();
}

boot();
