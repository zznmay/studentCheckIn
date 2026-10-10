const TOKEN_KEY = 'kq_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}
export function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

/** 请求封装：自动携带 token，401 自动跳回登录页，业务错误抛 Error(message) */
export async function api(path, opts = {}) {
  const { method = 'GET', body } = opts;
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) {
    // X-Auth-Token 为线上部署的主通道（平台网关会覆盖 Authorization 头）；Authorization 保留以兼容本地环境
    headers['X-Auth-Token'] = token;
    headers['Authorization'] = `Bearer ${token}`;
  }
  let res;
  try {
    res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch (e) {
    // 修改79：保留底层原因到控制台（部署网关掐「单连接累计上行」时表现为 fetch 抛异常，肉眼只见这句话）
    console.error(`[api] ${method} ${path} 网络层失败:`, e);
    throw new Error('网络异常，请确认服务已启动后刷新页面');
  }
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/login')) {
      setToken('');
      localStorage.removeItem('kq_user');
      if (location.hash !== '#/login') location.hash = '#/login';
    }
    const err = new Error(data.message || `请求失败（${res.status}）`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/** 带鉴权下载文件（模板等） */
export async function apiDownload(path, filename) {
  const res = await fetch(path, { headers: { 'X-Auth-Token': getToken(), Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new Error('下载失败，请重试');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

/** POST 数据并下载返回的文件（用于 Excel 导出） */
export async function apiPostDownload(path, body, filename) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Auth-Token': getToken(), Authorization: `Bearer ${getToken()}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* ignore */
    }
    throw new Error(data.message || `导出失败（${res.status}）`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}
