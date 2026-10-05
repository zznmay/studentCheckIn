import { api } from '../api.js';
import { getUser, rolesOf } from '../session.js';
import { esc, ICONS, countMini, fmtTime, periodTags } from '../ui.js';

const ICON_BY_LABEL = {
  系统账号: 'users',
  班级数: 'book',
  班级学生数: 'book',
  学生总数: 'users',
  今日点名: 'check',
  我的点名记录: 'check',
  我的班级: 'book',
  待生效假单: 'file',
};
const ICON_COLOR = ['si-blue', 'si-green', 'si-orange', 'si-purple'];

// 修改46：QUICK 同时服务两端——桌面层（4.6 原样）只用 label，手机层（设计稿）用 sub/icon/tone
const QUICK = {
  admin: [
    { label: '新建账号', sub: '添加系统账号', hash: '#/accounts', icon: 'plus', tone: 'si-blue' },
    { label: '导入班级名单', sub: '批量导入学生', hash: '#/roster', icon: 'upload', tone: 'si-green' },
    { label: '查看数据统计', sub: '考勤一目了然', hash: '#/stats', icon: 'chart', tone: 'si-purple' },
  ],
  rights: [
    { label: '发起点名', sub: '记录出勤情况', hash: '#/rollcall/new', icon: 'plus', tone: 'si-blue' },
    { label: '导入班级名单', sub: '批量导入学生', hash: '#/roster', icon: 'upload', tone: 'si-green' },
    { label: '导入假单', sub: '请假自动核销', hash: '#/leaves', icon: 'file', tone: 'si-orange' },
    { label: '导出统计数据', sub: '考勤报表留存', hash: '#/stats', icon: 'download', tone: 'si-purple' },
  ],
  discipline: [{ label: '发起点名', sub: '记录出勤情况', hash: '#/rollcall/new', icon: 'plus', tone: 'si-blue' }],
};

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function weekdayOf(date) {
  const d = new Date(`${date}T00:00:00`);
  return Number.isNaN(d.getTime()) ? '' : WEEKDAYS[d.getDay()];
}

function greeting() {
  const h = new Date().getHours();
  if (h < 6) return '夜深了';
  if (h < 9) return '早上好';
  if (h < 12) return '上午好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

export default {
  async mount(root) {
    const user = getUser();
    root.innerHTML = '<div class="page"><div class="muted" style="padding:40px;text-align:center">加载中…</div></div>';
    const d = await api('/api/dashboard');
    // 多角色：按账号角色顺序取第一个有快捷入口配置的角色
    const quickRoles = rolesOf(user).filter((r) => QUICK[r]);
    const quick = quickRoles.length ? QUICK[quickRoles[0]] : [];

    root.innerHTML = `
    <div class="page page-dash">
      <!-- 修改46：桌面层（4.6 原样，>720px 显示） -->
      <div class="d-layer">
        <div class="hello">
          <div>
            <h2>${greeting()}，${esc(user.name)}</h2>
            <p>欢迎使用学生考勤工作台，今天也要认真考勤哦。</p>
          </div>
          <div class="quick">${quick.map((q) => `<a class="btn btn-primary btn-sm" href="${q.hash}">${q.label}</a>`).join('')}</div>
        </div>
        <div class="stat-cards">
          ${d.cards
            .map(
              (c, i) => `
          <div class="stat-card">
            <div class="stat-icon ${ICON_COLOR[i % 4]}">${ICONS[ICON_BY_LABEL[c.label] || 'grid']}</div>
            <div><div class="stat-value">${c.value}</div><div class="stat-label">${esc(c.label)}</div></div>
          </div>`
            )
            .join('')}
        </div>
        <div class="card">
          <div class="card-title">最近点名记录</div>
          <div class="table-wrap">
            <table class="table" data-card="t,s,g,b,-,m,m,m,x">
              <thead>
                <tr><th>日期</th><th>班级</th><th>节次</th><th>课程</th><th>任课老师</th><th>出勤情况</th><th>发起人</th><th>最后更新</th><th></th></tr>
              </thead>
              <tbody>
                ${
                  d.recent.length
                    ? d.recent
                        .map(
                          (s) => `
                  <tr>
                    <td class="num">${esc(s.date)}</td>
                    <td>${esc(s.className)}</td>
                    <td>${periodTags(s.periods)}</td>
                    <td>${esc(s.courseName)}</td>
                    <td>${esc(s.teacher) || '<span class="muted">—</span>'}</td>
                    <td>${countMini(s.counts)}</td>
                    <td>${esc(s.createdBy)}</td>
                    <td class="muted small">${fmtTime(s.updatedAt)}</td>
                    <td class="td-actions"><a href="#/rollcall/${s.id}">查看</a></td>
                  </tr>`
                        )
                        .join('')
                    : '<tr><td colspan="9" class="table-empty">暂无点名记录</td></tr>'
                }
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <!-- 手机层（修改39/40 设计稿，≤720px 显示） -->
      <div class="m-layer">
        <section class="hero">
          <div class="hero-tx">
            <h2>${greeting()}，${esc(user.name)}<span class="hero-wave">👋</span></h2>
            <p>认真考勤，让课堂更有温度</p>
          </div>
          <div class="hero-deco" aria-hidden="true">${ICONS.file}</div>
        </section>
        <nav class="quick-cards">
          ${quick
            .map(
              (q) => `
          <a class="qcard" href="${q.hash}">
            <span class="qcard-ic ${q.tone}">${ICONS[q.icon] || ICONS.grid}</span>
            <span class="qcard-tx">${q.label}</span>
            <span class="qcard-sub">${q.sub}</span>
          </a>`
            )
            .join('')}
        </nav>
        <section class="card stat-panel">
          <div class="panel-head"><span class="panel-title">${ICONS.chart}数据概览</span></div>
          <div class="stat-cards">
            ${d.cards
              .map(
                (c, i) => `
            <div class="stat-card">
              <div class="stat-icon ${ICON_COLOR[i % 4]}">${ICONS[ICON_BY_LABEL[c.label] || 'grid']}</div>
              <div class="stat-tx"><div class="stat-value">${c.value}</div><div class="stat-label">${esc(c.label)}</div></div>
            </div>`
              )
              .join('')}
          </div>
        </section>
        <section class="card recent-panel">
          <div class="panel-head">
            <span class="panel-title">最近点名记录</span>
            <a class="panel-more" href="#/rollcall">查看更多${ICONS.chevronR}</a>
          </div>
          <div class="rec-list">
            ${
              d.recent.length
                ? d.recent
                    .map(
                      (s) => `
            <a class="rec-item" href="#/rollcall/${s.id}">
              <div class="rec-date"><b>${esc(String(s.date).slice(5))}</b><span>${weekdayOf(s.date)}</span></div>
              <div class="rec-info">
                <div class="rec-name">${esc(s.courseName)}</div>
                <div class="rec-meta">${esc(s.className)} · ${esc((s.periods || []).join('、'))}</div>
                <div class="rec-counts">${countMini(s.counts)}</div>
              </div>
              <span class="rec-arrow" aria-hidden="true">${ICONS.chevronR}</span>
            </a>`
                    )
                    .join('')
                : '<div class="rec-empty">暂无点名记录</div>'
            }
          </div>
        </section>
        <div class="dash-quote">✨ 用数据记录成长，用坚持陪伴未来<span class="dash-quote-by">—— 学生考勤工作台</span></div>
      </div>
    </div>`;
  },
};
