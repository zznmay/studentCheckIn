/* =============================================================================
 * 修改69：年级 → 班级 级联筛选（共享模块）
 * -----------------------------------------------------------------------------
 * 从「数据统计 → 缺勤统计」（public/js/pages/stats.js 修改60）抽取为共享模块，
 * 供 stats.js 与「班级名单管理」（public/js/pages/roster.js）共同复用，
 * 消除重复实现（roster 不再是复制粘贴，而是调用同一份逻辑）。
 *
 * 级联规则（与 stats.js 修改60 逐条等价，roster 复用后行为一致）：
 *   ① 切年级 → 班级下拉只保留该年级的班级；已选班级不属于该年级时自动清空
 *              （含恢复「全部班级」）。
 *   ② 切班级 → 选中具体班级时年级反向回写为该班级归属年级；选回「全部班级」时
 *              只解除班级过滤、保留已选年级。
 *   ③ 未选年级（全部年级）= 不限制班级，班级列出全部。
 *   ④ 传入的 gradeEls / clsEls 全部双向同步（stats 为桌面+手机双层，
 *              roster 为单元素），跨断点状态一致。
 *   ⑤ 级联变更后调用 onChange(grade, className)，由调用方决定是否立即刷新
 *              （stats 立即 loadAbsence；roster 保持「点查询才刷新」原语义）。
 *
 * 已知并接受的既有行为（与 stats 修改60 对等，不在此修正）：
 *   若某班级在数据里没有 grade、且班级名里不含 19xx/20xx 年份，
 *   gradeOfClass 会回退用班级名做归一化，可能得到一个不匹配任何年级选项的值
 *   → 该班级在任何年级被选中时都不出现。
 *
 * 本模块零依赖（不 import 任何其他模块），esc 自行实现（与 public/js/ui.js 等价）。
 * 不注入任何样式（无自有样式），不返回 DOM，只返回控制 API。
 * ========================================================================== */

// 与 public/js/ui.js 的 esc() 实现等价（& < > " ' 五字符转义）
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * 归一化年级：把混写的「2025级」「2025」「人工智能2502」统一为「2025级」。
 * 规则与 stats.js 原 normGradeAbs 逐字符等价（原样保留，不做任何"优化"）。
 * @param {*} v
 * @returns {string} 形如「2025级」；不含 19xx/20xx 时原样返回 String(v||'')
 */
export function normGrade(v) {
  const m = String(v || '').match(/(19|20)\d{2}/);
  return m ? `${m[0]}级` : String(v || '');
}

/**
 * 由班级元数据推导年级数组：归一化 → 去重 → 降序（新年级在前）。
 * @param {Array<{name:string, grade?:string}>} classList
 * @returns {string[]}
 */
export function deriveGrades(classList) {
  return [...new Set((classList || []).map((c) => normGrade(c.grade || c.name)).filter(Boolean))].sort((a, b) =>
    b.localeCompare(a, 'zh')
  );
}

/**
 * 班级 → 年级反查（元数据缺失时回退用班级名做 normGrade）。
 * @param {Array<{name:string, grade?:string}>} classList
 * @param {string} name 班级名
 * @returns {string}
 */
export function gradeOfClass(classList, name) {
  const c = (classList || []).find((x) => x.name === name);
  return normGrade((c && c.grade) || name);
}

/**
 * 创建年级 → 班级级联控制器。
 *
 * @param {object} cfg
 * @param {Array} cfg.classList 班级元数据（/api/meta/classes 的 classes）
 * @param {Element[]} cfg.gradeEls 年级下拉元素数组（全部都会被写入）
 * @param {Element[]} cfg.clsEls   班级下拉元素数组（全部都会被写入）
 * @param {string} [cfg.gradeEmptyText='全部年级'] 年级下拉的首项（空值）文案
 * @param {string} [cfg.clsEmptyText='全部班级']   班级下拉的首项（空值）文案
 * @param {(c:object)=>string} [cfg.formatClsLabel] 班级选项文案，默认 (c)=>c.name
 * @param {(grade:string, className:string)=>void} [cfg.onChange] 级联变更回调
 * @returns {{getGrade:Function, getClassName:Function, sync:Function, setClassList:Function, renderGradeOptions:Function}}
 */
export function createGradeClassCascade(cfg = {}) {
  let classList = cfg.classList || [];
  const gradeEls = (cfg.gradeEls || []).filter(Boolean);
  const clsEls = (cfg.clsEls || []).filter(Boolean);
  const gradeEmptyText = cfg.gradeEmptyText || '全部年级';
  const clsEmptyText = cfg.clsEmptyText || '全部班级';
  // 班级选项文案：⛔ value 永远是 c.name，绝不用带人数的文案当 value
  const formatClsLabel = typeof cfg.formatClsLabel === 'function' ? cfg.formatClsLabel : (c) => c.name;
  const onChange = typeof cfg.onChange === 'function' ? cfg.onChange : null;

  const firstGradeVal = () => (gradeEls[0] ? gradeEls[0].value : '');
  const firstClsVal = () => (clsEls[0] ? clsEls[0].value : '');

  function writeAll(els, val) {
    for (const el of els) el.value = val;
  }

  /**
   * 按当前年级重渲染班级选项，并同步所有 clsEls 的 value。
   * @param {{keepValue?:boolean, silent?:boolean}} [opts]
   *   keepValue=true  保留已选班级（若不属于当前年级则被清空）——用于"切年级"与刷新后重渲染
   *   keepValue=false 强制清空班级（恢复「全部班级」）——用于初始化
   *   silent=true     不触发 onChange ——用于初始化（避免多余的自动刷新）
   * @returns {string} 生效后的班级值（不合法时为 ''）
   */
  function sync(opts = {}) {
    const { keepValue = false, silent = false } = opts;
    const grade = firstGradeVal();
    const cur = keepValue ? firstClsVal() : '';
    // 所选班级是否仍属于当前年级（未选年级 = 全部合法）
    const legal = !!(cur && (!grade || gradeOfClass(classList, cur) === grade));
    const html =
      `<option value="">${esc(clsEmptyText)}</option>` +
      classList
        .filter((c) => !grade || gradeOfClass(classList, c.name) === grade)
        .map((c) => `<option value="${esc(c.name)}" ${legal && cur === c.name ? 'selected' : ''}>${esc(formatClsLabel(c))}</option>`)
        .join('');
    for (const el of clsEls) el.innerHTML = html;
    const val = legal ? cur : '';
    writeAll(clsEls, val);
    if (!silent && onChange) onChange(grade, val);
    return val;
  }

  /**
   * 切年级：来源元素的值同步到全部 gradeEls → 按新年级重渲染班级（不匹配的班级被清空）。
   * @param {Element} [srcEl] 触发变更的年级下拉
   */
  function onGradeChange(srcEl) {
    const grade = srcEl ? srcEl.value : firstGradeVal();
    writeAll(gradeEls, grade); // 规则④：桌面/手机（或未来的多层）保持一致
    sync({ keepValue: true }); // 规则①：不属该年级的已选班级在此被清空
  }

  /**
   * 切班级：选具体班级 → 年级反向回写其归属年级；选回「全部班级」→ 只解班级、保留年级。
   * 与 stats 原实现一致：此处**不**重渲染班级选项（选项已在切年级时按年级过滤）。
   * @param {Element} [srcEl] 触发变更的班级下拉
   */
  function onClsChange(srcEl) {
    const cls = srcEl ? srcEl.value : firstClsVal();
    writeAll(clsEls, cls); // 规则④
    let grade = firstGradeVal();
    if (cls) {
      grade = gradeOfClass(classList, cls); // 规则②：年级反向跟随班级归属
      writeAll(gradeEls, grade);
    }
    // cls 为空 → grade 保持不变（保留用户已选年级）
    if (onChange) onChange(grade, cls);
  }

  // 绑定：所有传入元素都要绑，缺元素容错（不抛错打断页面）
  for (const el of gradeEls) el.onchange = (e) => onGradeChange(e.target);
  for (const el of clsEls) el.onchange = (e) => onClsChange(e.target);

  return {
    /** 当前年级（取第一个年级下拉的值） */
    getGrade: () => firstGradeVal(),
    /** 当前班级（取第一个班级下拉的值） */
    getClassName: () => firstClsVal(),
    /** 按当前年级重渲染班级选项；见 sync() 的 opts 说明 */
    sync,
    /** 替换班级元数据（刷新后调用；不会自动重渲染，需再调 sync/renderGradeOptions） */
    setClassList(list) {
      classList = list || [];
    },
    /**
     * 渲染年级选项（空项 + deriveGrades 推导值），尽量保留 selected。
     * @param {string} [selected] 要选中的年级；缺省沿用当前值
     */
    renderGradeOptions(selected) {
      const cur = selected === undefined ? firstGradeVal() : selected;
      const html =
        `<option value="">${esc(gradeEmptyText)}</option>` +
        deriveGrades(classList)
          .map((g) => `<option value="${esc(g)}" ${cur === g ? 'selected' : ''}>${esc(g)}</option>`)
          .join('');
      for (const el of gradeEls) el.innerHTML = html;
      writeAll(gradeEls, cur);
    },
  };
}