import { api } from '../api.js';
import { esc, ICONS, toast } from '../ui.js';
import { getUser, setUser } from '../session.js';

export default {
  async mount(root) {
    const user = getUser() || {};
    root.innerHTML = `
    <div class="login-wrap">
      <div class="login-card" style="max-width:460px">
        <div class="login-logo"><span class="brand-icon">${ICONS.logo}</span></div>
        <h1 style="font-size:19px">修改初始密码</h1>
        <p class="login-sub">检测到您正在使用初始密码<br/>为确保账号安全，请设置新密码后继续使用系统</p>
        <div class="gen-preview" style="margin-bottom:16px">
          <div>当前账号：<b>${esc(user.username || '')}</b>（${esc(user.name || '')}）</div>
        </div>
        <form class="login-form" id="cpForm">
          <label>当前密码（初始密码）
            <input type="password" name="old" autocomplete="current-password" placeholder="请输入当前使用的密码" />
          </label>
          <label>新密码（至少 6 位）
            <input type="password" name="n1" autocomplete="new-password" placeholder="请设置新密码" />
          </label>
          <label>确认新密码
            <input type="password" name="n2" autocomplete="new-password" placeholder="请再次输入新密码" />
          </label>
          <div class="login-err" id="cpErr"></div>
          <button class="btn btn-primary btn-block" type="submit">确认修改并进入系统</button>
          <button class="btn btn-block" type="button" id="cpLogout">退出登录</button>
        </form>
      </div>
    </div>`;

    const form = root.querySelector('#cpForm');
    const err = root.querySelector('#cpErr');
    form.n1.addEventListener('input', () => {
      if (form.n2.value && form.n2.value !== form.n1.value) err.textContent = '两次输入的新密码不一致';
      else if (form.n1.value && form.n1.value === form.old.value) err.textContent = '新密码不能与当前密码相同';
      else err.textContent = '';
    });
    form.n2.addEventListener('input', () => {
      err.textContent = form.n2.value && form.n2.value !== form.n1.value ? '两次输入的新密码不一致' : '';
    });

    form.onsubmit = async (e) => {
      e.preventDefault();
      if (!form.old.value) { err.textContent = '请输入当前密码'; return; }
      if (form.n1.value.length < 6) { err.textContent = '新密码长度不能少于 6 位'; return; }
      if (form.n1.value === form.old.value) { err.textContent = '新密码不能与当前密码相同'; return; }
      if (form.n1.value !== form.n2.value) { err.textContent = '两次输入的新密码不一致'; return; }
      try {
        await api('/api/auth/password', { method: 'PUT', body: { oldPassword: form.old.value, newPassword: form.n1.value } });
        const me = await api('/api/auth/me');
        setUser(me.user);
        toast('密码修改成功，欢迎使用系统');
        location.hash = '#/dashboard';
      } catch (ex) {
        err.textContent = ex.message;
      }
    };

    root.querySelector('#cpLogout').onclick = async () => {
      try {
        await api('/api/auth/logout', { method: 'POST' });
      } catch {
        /* ignore */
      }
      location.hash = '#/login';
      location.reload();
    };
  },
};
