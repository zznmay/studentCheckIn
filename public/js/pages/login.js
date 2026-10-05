import { api, setToken } from '../api.js';
import { setUser } from '../session.js';
import { toast } from '../ui.js';

// 修改67：登录页按参照稿 1:1 复刻（双栏 shell / 品牌栏 / 欢迎标题 + 胶囊副标题 /
//   图标输入框 / 记住账号 + 忘记密码 / 渐变登录按钮 / 页脚 + 右侧插画）。
//   ⚠️ 业务契约保持不变：仍走 api('/api/auth/login') → setToken + setUser，
//      mustChangePassword 跳改密、否则进工作台；表单 id 与 input[name] 保持
//      #loginForm / username / password 不变（既有 E2E 与手工脚本依赖）。
//   ⚠️ 参照稿的 theme 开关改写项目既有 html[data-theme="dark"] + kq_theme 键，
//      与 index.html 引导脚本、app.js 顶栏开关共享同一偏好，不会互相打架。
// 修改68：新增移动端登录页（≤720px 浅蓝渐变 + 纯 CSS 艺术插画，样式见 app.css
//   末尾 .m-login 区块）。
//   ⚠️ 架构铁律：按 matchMedia('(max-width: 720px)') 分支渲染**两套完全独立的
//      markup**，任何时刻 DOM 里只有一个 <form id="loginForm">。
//      ⛔ 绝不用 CSS 双层同时渲染两个 form（重复 id + 隐藏层控件对 Playwright
//         不可见 → 多个线上回归套件会超时）。
//   ⚠️ 桌面分支 DESKTOP_HTML 是原 root.innerHTML 模板的逐字节搬运（仅从 mount
//      内部提到模块顶部），桌面 CSS 一行未动 → 桌面端零改动。
//   ⚠️ 两分支共用 applyI18n / bindPwdToggle / bindTheme / bindLang / doSubmit /
//      restoreRemember，行为与改动前完全一致；移动端额外挂 focusin 软键盘滚动。

// 参照稿内联 SVG（保持像素级一致，故不复用 ui.js 的 ICONS）
const ICON_SUN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></svg>`;
const ICON_GLOBE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.4 2.4 3.6 5.4 3.6 9s-1.2 6.6-3.6 9C9.6 18.6 8.4 15.6 8.4 12S9.6 5.4 12 3Z"/></svg>`;
const ICON_USER = `<svg class="field-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 12.3a4.4 4.4 0 1 0 0-8.8 4.4 4.4 0 0 0 0 8.8Zm0 2.1c-5.4 0-8.6 2.8-8.6 6.3V22h17.2v-1.3c0-3.5-3.2-6.3-8.6-6.3Z"/></svg>`;
const ICON_LOCK = `<svg class="field-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.5 9h-1V6.5a5.5 5.5 0 0 0-11 0V9h-1A2.5 2.5 0 0 0 3 11.5v8A2.5 2.5 0 0 0 5.5 22h13a2.5 2.5 0 0 0 2.5-2.5v-8A2.5 2.5 0 0 0 18.5 9ZM8.7 6.5a3.3 3.3 0 0 1 6.6 0V9H8.7v-2.5ZM13 16.7v1.5h-2v-1.5a2 2 0 1 1 2 0Z"/></svg>`;
// 参照稿的眼睛：默认「睁眼」，aria-pressed=true 时加斜杠（切换即显示 .eye-slash）
const ICON_EYE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.8"/><path class="eye-slash" d="m4 20 16-16"/></svg>`;
const ICON_ARROW = `<svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 14h20m-8-8 8 8-8 8"/></svg>`;
// 移动端协议行的勾号（参照稿 agreement 勾选框内联）
const ICON_CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;

const THEME_KEY = 'kq_theme';   // 与 index.html 引导脚本 / app.js 同名，务必一致
const REMEMBER_KEY = 'kq_login_username';  // 记住的账号（参照稿用 attendance.username，改用项目前缀避免与其他模块串味）
const MOBILE_QUERY = '(max-width: 720px)';  // 移动端断点（项目约定，非参照稿的 480/820）

// 参照稿的中英文案（语言切换按钮为参照稿交互；默认中文）
const I18N = {
  'zh-CN': {
    brand: '学生考勤平台', welcome: '欢迎登录',
    subtitle: '每一次准时，都是对未来的郑重承诺',
    remember: '记住账号', forgot: '忘记密码?', login: '登 录',
    footer: '用考勤记录青春　·　让成长更有方向',
    username: '请输入账号', password: '请输入密码',
    showPassword: '显示密码', hidePassword: '隐藏密码',
    forgotNotice: '请联系辅导员或管理员重置密码。',
    darkMode: '切换深色模式', lightMode: '切换浅色模式',
    langBtn: 'Switch to English', errEmpty: '请输入账号和密码',
    // 修改68 移动端新增文案（桌面 markup 不引用，纯增量，不影响桌面渲染）
    account: '账号', pwd: '密码', hello: '您好，',
    hi: '欢迎使用考勤平台',
    agreement: '我已阅读用户协议和隐私政策并理解相关条款内容',
  },
  en: {
    brand: 'Student Attendance', welcome: 'Welcome back',
    subtitle: 'Every moment on time is a promise to your future',
    remember: 'Remember account', forgot: 'Forgot password?', login: 'Log in',
    footer: 'RECORD TODAY · GROW FOR TOMORROW',
    username: 'Enter your account', password: 'Enter your password',
    showPassword: 'Show password', hidePassword: 'Hide password',
    forgotNotice: 'Please contact your counselor or an administrator to reset it.',
    darkMode: 'Switch to dark mode', lightMode: 'Switch to light mode',
    langBtn: '切换中文', errEmpty: 'Please enter both account and password',
    account: 'Account', pwd: 'Password', hello: 'Hello,',
    hi: 'Welcome to the attendance platform',
    agreement: 'I have read the Terms of Service and Privacy Policy and understand the relevant terms',
  },
};

/* ============================================================
   桌面分支模板：⚠️ 原 mount() 内 root.innerHTML 模板字符串的逐字节搬运，
   仅从函数内部提到模块顶部以供分支复用，内容一个字符都未改。
   配套的 .login-shell CSS（app.css 682~999）也一行未动。
   ============================================================ */
const DESKTOP_HTML = `
    <main class="login-shell">
      <section class="login-pane" aria-labelledby="page-title">
        <header class="top-bar">
          <div class="brand">
            <span class="brand-mark" aria-hidden="true">勤</span>
            <span class="brand-name" data-i18n="brand">学生考勤平台</span>
          </div>
          <div class="header-actions">
            <button class="icon-button" id="lgTheme" type="button" aria-label="切换深色模式" title="切换深色模式">${ICON_SUN}</button>
            <button class="icon-button" id="lgLang" type="button" aria-label="Switch to English" title="Switch to English">${ICON_GLOBE}</button>
          </div>
        </header>

        <div class="lg-content">
          <div class="welcome">
            <h1 id="page-title" data-i18n="welcome">欢迎登录</h1>
            <p class="welcome-note" data-i18n="subtitle">每一次准时，都是对未来的郑重承诺</p>
          </div>

          <form id="loginForm">
            <div class="form-fields">
              <label class="input-wrap">
                ${ICON_USER}
                <input name="username" type="text" autocomplete="username" placeholder="请输入账号" aria-label="请输入账号" required />
              </label>
              <div class="input-wrap">
                ${ICON_LOCK}
                <input name="password" type="password" autocomplete="current-password" placeholder="请输入密码" aria-label="请输入密码" required />
                <button class="visibility-button" id="pwdToggle" type="button" aria-label="显示密码" title="显示密码" aria-pressed="false">${ICON_EYE}</button>
              </div>
            </div>

            <div class="form-options">
              <label class="remember-label">
                <input id="lgRemember" type="checkbox" checked />
                <span data-i18n="remember">记住账号</span>
              </label>
              <button class="forgot-button" id="lgForgot" type="button" data-i18n="forgot">忘记密码?</button>
            </div>

            <button class="submit-button" type="submit">
              <span data-i18n="login">登 录</span>
              ${ICON_ARROW}
            </button>
            <p class="form-status" id="lgStatus" role="status" aria-live="polite"></p>
          </form>
        </div>

        <footer class="login-footer">
          <span class="footer-rule" aria-hidden="true"></span>
          <span data-i18n="footer">用考勤记录青春　·　让成长更有方向</span>
          <span class="footer-rule" aria-hidden="true"></span>
        </footer>
      </section>

      <aside class="illustration-pane" aria-label="考勤打卡、书本和闹钟的校园主题插画">
        <img src="./assets/attendance-illustration.png" alt="考勤打卡，按时到校、认真学习、追逐梦想" />
      </aside>
    </main>`;

/* ============================================================
   移动分支模板（≤720px）：浅蓝渐变 + 纯 CSS 艺术插画（无图片资源）
   ⚠️ 必须提供与桌面同名同契约的交互元素：
      #loginForm / input[name=username] / input[name=password] /
      #pwdToggle / #lgRemember / #lgForgot / button[type=submit] /
      #lgStatus / #lgTheme / #lgLang（多个线上回归套件在 375px 下依赖它们）。
   ⚠️ 协议勾选框（#mAgree）刻意**不**参与提交校验：项目无真实协议页，
      回归套件会直接点提交，阻断会导致登录全挂。
   ============================================================ */
const MOBILE_HTML = `
    <div class="m-login">
      <div class="m-bg" aria-hidden="true">
        <div class="m-blob m-blob-1"></div>
        <div class="m-blob m-blob-2"></div>
      </div>

      <div class="m-page">
        <section class="m-hero">
          <div class="m-hero-actions">
            <button class="m-iconbtn" id="lgTheme" type="button" aria-label="切换深色模式" title="切换深色模式">${ICON_SUN}</button>
            <button class="m-iconbtn" id="lgLang" type="button" aria-label="Switch to English" title="Switch to English">${ICON_GLOBE}</button>
          </div>

          <div class="m-illus" aria-hidden="true">
            <div class="m-illus-disc"></div>
            <div class="m-illus-ring1"></div>
            <div class="m-illus-ring2"></div>
            <div class="m-illus-bolt"></div>
          </div>

          <div class="m-brand">
            <span class="m-logo" aria-hidden="true">勤</span>
            <span class="m-brand-name" data-i18n="brand">学生考勤平台</span>
          </div>

          <h1><span data-i18n="hello">您好，</span><br /><span class="m-hi" data-i18n="hi">欢迎使用考勤平台</span></h1>
          <p data-i18n="subtitle">每一次准时，都是对未来的郑重承诺</p>
        </section>

        <div class="m-card">
          <form id="loginForm">
            <div class="m-field">
              <label for="mUser" data-i18n="account">账号</label>
              <div class="m-input-wrap">
                <input id="mUser" name="username" type="text" autocomplete="username" placeholder="请输入账号" aria-label="请输入账号" required />
              </div>
            </div>

            <div class="m-field">
              <label for="mPwd" data-i18n="pwd">密码</label>
              <div class="m-input-wrap">
                <input id="mPwd" name="password" type="password" autocomplete="current-password" placeholder="请输入密码" aria-label="请输入密码" required />
                <button class="m-toggle-pwd" id="pwdToggle" type="button" aria-label="显示密码" title="显示密码" aria-pressed="false">${ICON_EYE}</button>
              </div>
            </div>

            <div class="m-links-row">
              <label class="m-remember">
                <input id="lgRemember" type="checkbox" checked />
                <span data-i18n="remember">记住账号</span>
              </label>
              <button class="m-forgot" id="lgForgot" type="button" data-i18n="forgot">忘记密码?</button>
            </div>

            <button class="m-btn" type="submit">
              <span data-i18n="login">登 录</span>
            </button>
            <p class="m-status" id="lgStatus" role="status" aria-live="polite"></p>
          </form>
        </div>

        <div class="m-spacer" aria-hidden="true"></div>

        <label class="m-agreement">
          <input id="mAgree" type="checkbox" checked aria-label="同意用户协议和隐私政策" />
          <span class="m-check" aria-hidden="true">${ICON_CHECK}</span>
          <span data-i18n="agreement">我已阅读用户协议和隐私政策并理解相关条款内容</span>
        </label>
      </div>
    </div>`;

/* ============================ 共享逻辑（两分支复用） ============================ */

// 记住账号：回填 + 勾选态（与改动前逐行一致）
const restoreRemember = (rememberBox, userInput) => {
  try {
    const saved = localStorage.getItem(REMEMBER_KEY);
    if (saved) { userInput.value = saved; rememberBox.checked = true; }
    else rememberBox.checked = true;   // 参照稿默认勾选
  } catch { /* 隐私模式忽略 */ }
};

// 密码显隐（参照稿：aria-pressed 控制斜杠，不换图标路径）
const bindPwdToggle = (pwdToggle, pwdInput, syncEyeLabel) => {
  pwdToggle.onclick = () => {
    pwdInput.type = pwdInput.type === 'password' ? 'text' : 'password';
    pwdToggle.setAttribute('aria-pressed', String(pwdInput.type === 'text'));
    syncEyeLabel();
    pwdInput.focus();
  };
};

// 主题：复用项目 kq_theme + html[data-theme]，与顶栏开关共享偏好
const bindTheme = (themeBtn, syncThemeLabel) => {
  themeBtn.onclick = () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (dark) document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', 'dark');
    try { localStorage.setItem(THEME_KEY, dark ? 'light' : 'dark'); } catch { /* 隐私模式忽略 */ }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#141A2E' : '#EEEBFF');
    syncThemeLabel();
  };
};

// 语言切换（参照稿交互）：文案 + 占位符 + 文档语言/标题 + 状态与图标标签全量同步
const bindLang = (ctx) => {
  const { root, langBtn, userInput, pwdInput, setStatus, syncEyeLabel, syncThemeLabel, state } = ctx;
  langBtn.onclick = () => {
    state.lang = state.lang === 'zh-CN' ? 'en' : 'zh-CN';
    applyI18n(ctx);
  };
  // 跨断点重渲染后若语言非中文，需把新 DOM 的静态文案重新刷成当前语言
  if (state.lang !== 'zh-CN') applyI18n(ctx);
  return root;
};

const applyI18n = (ctx) => {
  const { root, langBtn, userInput, pwdInput, setStatus, syncEyeLabel, syncThemeLabel, state } = ctx;
  const s = I18N[state.lang];
  document.documentElement.lang = state.lang;
  document.title = state.lang === 'zh-CN' ? '学生考勤工作台' : 'Student Attendance';
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    const t = s[el.dataset.i18n];
    if (t != null) el.textContent = t;
  });
  userInput.placeholder = s.username;
  userInput.setAttribute('aria-label', s.username);
  pwdInput.placeholder = s.password;
  pwdInput.setAttribute('aria-label', s.password);
  langBtn.setAttribute('aria-label', s.langBtn);
  langBtn.title = s.langBtn;
  setStatus('');
  syncEyeLabel();
  syncThemeLabel();
};

// 提交：业务逻辑与接口调用保持原样（⛔ 不动 api 调用方式与跳转逻辑）
const doSubmit = (ctx) => {
  const { form, userInput, pwdInput, rememberBox, submitBtn, setStatus, state } = ctx;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const username = userInput.value.trim();
    const password = pwdInput.value;
    if (!username || !password) {
      setStatus(I18N[state.lang].errEmpty, true);
      return;
    }
    setStatus('');
    submitBtn.disabled = true;
    const label = submitBtn.querySelector('span');
    const prev = label.textContent;
    label.textContent = '登录中…';
    try {
      // 记住账号：勾选则存，取消则清
      try {
        if (rememberBox.checked) localStorage.setItem(REMEMBER_KEY, username);
        else localStorage.removeItem(REMEMBER_KEY);
      } catch { /* 隐私模式忽略 */ }
      const d = await api('/api/auth/login', { method: 'POST', body: { username, password } });
      setToken(d.token);
      setUser(d.user);
      toast(`欢迎回来，${d.user.name}`);
      if (d.user.mustChangePassword) {
        toast('首次登录，请先修改初始密码', 'info');
        location.hash = '#/change-password';
      } else {
        location.hash = '#/dashboard';
      }
    } catch (ex) {
      setStatus(ex.message, true);
      submitBtn.disabled = false;
      label.textContent = prev;
    }
  };
};

// 移动端专属：软键盘弹出时把聚焦字段滚到可视区中部（280ms 延迟等键盘动画完成）
const bindFocusScroll = (container) => {
  let timer = 0;
  container.addEventListener('focusin', (e) => {
    const field = e.target.closest && e.target.closest('.m-field');
    if (!field) return;
    clearTimeout(timer);
    timer = setTimeout(() => field.scrollIntoView({ block: 'center', behavior: 'smooth' }), 280);
  });
};

/* ============================ 页面装配 ============================ */

export default {
  async mount(root) {
    const mq = window.matchMedia(MOBILE_QUERY);
    // 跨断点重渲染时保留用户已输入的内容（旋转屏幕不丢输入）
    const state = { lang: 'zh-CN', username: '', password: '', remember: true, pwdShown: false };
    let rendered = false;

    // 重渲染前把当前 DOM 的输入态存回 state
    const capture = () => {
      const prevForm = root.querySelector('#loginForm');
      if (!prevForm) return;
      const u = prevForm.querySelector('input[name="username"]');
      const p = prevForm.querySelector('input[name="password"]');
      const rem = root.querySelector('#lgRemember');
      if (u) state.username = u.value;
      if (p) { state.password = p.value; state.pwdShown = p.type === 'text'; }
      if (rem) state.remember = rem.checked;
    };

    const bind = (isMobile) => {
      const form = root.querySelector('#loginForm');
      const [userInput, pwdInput] = [form.username, form.password];
      const status = root.querySelector('#lgStatus');
      const submitBtn = form.querySelector('button[type="submit"]');
      const pwdToggle = root.querySelector('#pwdToggle');
      const rememberBox = root.querySelector('#lgRemember');
      const themeBtn = root.querySelector('#lgTheme');
      const langBtn = root.querySelector('#lgLang');

      const setStatus = (msg, isError = false) => {
        status.textContent = msg;
        status.classList.toggle('is-error', !!isError);
      };

      const syncEyeLabel = () => {
        const label = I18N[state.lang][pwdInput.type === 'password' ? 'showPassword' : 'hidePassword'];
        pwdToggle.setAttribute('aria-label', label);
        pwdToggle.title = label;
      };

      const syncThemeLabel = () => {
        const dark = document.documentElement.getAttribute('data-theme') === 'dark';
        const label = I18N[state.lang][dark ? 'lightMode' : 'darkMode'];
        themeBtn.setAttribute('aria-label', label);
        themeBtn.title = label;
      };

      // —— 记住账号：回填 + 勾选态 ——
      restoreRemember(rememberBox, userInput);

      // 跨断点重渲染：回填本次会话已输入的内容（首次渲染不介入，保持原行为）
      if (rendered) {
        userInput.value = state.username;
        pwdInput.value = state.password;
        rememberBox.checked = state.remember;
        if (state.pwdShown) {
          pwdInput.type = 'text';
          pwdToggle.setAttribute('aria-pressed', 'true');
        }
      }

      const ctx = {
        root, form, userInput, pwdInput, rememberBox, submitBtn, setStatus,
        langBtn, syncEyeLabel, syncThemeLabel, state,
      };

      // —— 密码显隐 ——
      bindPwdToggle(pwdToggle, pwdInput, syncEyeLabel);

      // —— 主题 ——
      bindTheme(themeBtn, syncThemeLabel);
      syncThemeLabel();

      // —— 语言切换 ——
      bindLang(ctx);

      root.querySelector('#lgForgot').onclick = () => setStatus(I18N[state.lang].forgotNotice);

      // 重新输入时清除旧提示（否则原生 required 拦截提交时会残留上一次的错误文案）
      [userInput, pwdInput].forEach((el) => el.addEventListener('input', () => setStatus('')));

      // —— 提交 ——
      doSubmit(ctx);

      // 移动端专属：软键盘弹出时滚动到聚焦字段
      if (isMobile) bindFocusScroll(root);

      rendered = true;
    };

    const render = () => {
      capture();
      root.innerHTML = mq.matches ? MOBILE_HTML : DESKTOP_HTML;
      bind(mq.matches);
    };

    // mount 可能被重复调用（同一 root）：先摘掉旧监听再挂，避免无限累积
    if (root.__mLoginHandler) mq.removeEventListener('change', root.__mLoginHandler);
    const onMqChange = () => render();
    root.__mLoginHandler = onMqChange;
    mq.addEventListener('change', onMqChange);

    render();
  },
};