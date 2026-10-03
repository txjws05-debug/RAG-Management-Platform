/**
 * 验证 Tailwind v4 是否为 `min-h-11 sm:min-h-0` 同时产出两个工具类。
 *
 * 这个探针存在的理由：移动端可点高度依赖「手机 44px、桌面恢复自然高度」这一对类，
 * 如果 `sm:min-h-0` 没有被产出，桌面端会被永久撑高 44px —— 而这种问题在源码上看不出来，
 * 只有编译结果才能确认。
 *
 * 用法：node scripts/check-minh.mjs（在 frontend 目录下运行）
 */
import postcss from 'postcss';
import tw from '@tailwindcss/postcss';

const SOURCES = {
  'min-h-11': 'min-h-11',
  'min-h-0': 'min-h-0',
  'sm:min-h-0': 'sm:min-h-0',
  '两者同时': 'min-h-11 sm:min-h-0',
};

/** 把 Tailwind 类名转成 CSS 里的选择器文本，用于在产物中查找。 */
function selectorOf(className) {
  // Tailwind v4 对 `:` 转义为 `\:`；`sm:min-h-0` 在媒体查询内仍写作 `.sm\:min-h-0`
  return '.' + className.replace(/:/g, '\\:');
}

let bad = 0;
for (const [name, classes] of Object.entries(SOURCES)) {
  const items = classes.split(' ').map((c) => `"${c}"`).join(',');
  const css = `@import "tailwindcss";\n@source inline(${items});`;
  try {
    const result = await postcss([tw()]).process(css, { from: 'probe.css' });
    const out = result.css;
    const rows = classes.split(' ').map((c) => {
      const sel = selectorOf(c);
      // 选择器后面可能紧跟 { 或 ,（与其他选择器合并）
      const found = out.includes(sel + '{') || out.includes(sel + ',') || out.includes(sel + ' ');
      return `${c}=${found ? '产出' : '缺失'}`;
    });
    const missing = rows.filter((r) => r.includes('缺失'));
    if (missing.length) bad += 1;
    console.log(`  ${name.padEnd(12)} ${rows.join('  ')}`);
  } catch (e) {
    bad += 1;
    console.log(`  ${name.padEnd(12)} 编译失败: ${e.message}`);
  }
}
console.log(bad === 0 ? '\n全部类都能产出 ✓' : `\n有 ${bad} 个用例存在缺失类 ✗`);
process.exit(bad === 0 ? 0 : 1);
