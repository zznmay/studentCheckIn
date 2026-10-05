let user = null;

export function setUser(u) {
  user = u;
  if (u) localStorage.setItem('kq_user', JSON.stringify(u));
  else localStorage.removeItem('kq_user');
}

export function getUser() {
  if (!user) {
    try {
      user = JSON.parse(localStorage.getItem('kq_user') || 'null');
    } catch {
      user = null;
    }
  }
  return user;
}

export function clearUser() {
  user = null;
  localStorage.removeItem('kq_user');
}

// ==================== 多角色助手 ====================
// 账号的实际角色集合：优先 roles 数组（多角色），旧数据回退为 [role]
export function rolesOf(u) {
  if (!u) return [];
  if (Array.isArray(u.roles) && u.roles.length) return u.roles;
  return u.role ? [u.role] : [];
}
export function hasRole(u, r) {
  return rolesOf(u).includes(r);
}
// 合并权限语义：任一角色授予即视为拥有
export function hasAnyRole(u, list) {
  return rolesOf(u).some((r) => list.includes(r));
}
