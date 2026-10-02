/**
 * Tailwind CSS v4 使用 CSS-first 配置：
 * 主题与内容扫描都在 src/app/globals.css 中通过 `@import "tailwindcss"` 完成，
 * 因此这里只需要挂载 PostCSS 插件，不生成 tailwind.config.js。
 */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
