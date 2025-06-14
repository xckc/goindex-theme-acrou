// vue.config.js (已修复并优化)
const path = require("path");

function resolve(dir) {
  return path.join(__dirname, dir);
}

// ▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼
// ▼▼▼                                                                    ▼▼▼
// ▼▼▼ [至关重要] 请将这里的 URL 替换为您自己的、带版本号和 /dist/ 的 jsDelivr 地址！ ▼▼▼
// ▼▼▼                                                                    ▼▼▼
// ▼▼▼ 格式: 'https://cdn.jsdelivr.net/gh/你的GitHub用户名/你的仓库名@版本号/dist/'   ▼▼▼
// ▼▼▼ 例如: 'https://cdn.jsdelivr.net/gh/xckc/goindex-theme-acrou@v2.0.9/dist/'     ▼▼▼
// ▼▼▼                                                                    ▼▼▼
// ▼▼▼ 别忘了最后的斜杠 '/' 和中间的 '/dist/'                                 ▼▼▼
// ▼▼▼                                                                    ▼▼▼
const DEPLOY_URL = 'https://cdn.jsdelivr.net/gh/xckc/goindex-theme-acrou@v2.0.10/dist/';
// ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲

const isProd = process.env.NODE_ENV === 'production';

module.exports = {
  // [关键修复]：在生产环境中，使用您配置的完整 CDN URL 作为公共路径。
  // Webpack 会自动将这个 URL 作为所有静态资源（如 js/app.min.js, css/style.min.css）的前缀。
  publicPath: isProd ? DEPLOY_URL : '/',

  // 确保输出目录是 'dist'，这是默认值，通常无需修改。
  // outputDir: 'dist',

  // 禁用哈希，以获得固定的文件名 (app.min.js, style.min.css)，便于在 Worker 中引用。
  filenameHashing: false,
  
  // 生产环境禁用 source map，减小文件体积。
  productionSourceMap: false,
  
  css: {
    loaderOptions: {
      sass: {
        // 向所有 SCSS 文件注入 CDN 路径变量，以便在 CSS 中使用
        additionalData: `$cdnPath: "${isProd ? DEPLOY_URL : '/'}";`
      },
    },
  },

  chainWebpack: config => {
    // 路径别名 (alias)
    config.resolve.alias
      .set("@", resolve("src"))
      .set("@assets", resolve("src/assets"))
      .set("@utils", resolve("src/utils"))
      .set("@api", resolve("src/api"))
      .set("@node_modules", resolve("node_modules"));

    // 移除 prefetch 和 preload，减少不必要的网络请求。
    config.plugins.delete('prefetch');
    config.plugins.delete('preload');
    
    // 保持 HTML 插件的默认行为，让 Webpack 自动注入 JS 和 CSS 标签
    config.plugin('html').tap(args => {
      args[0].cdn = {}; // 确保旧的 cdn 注入逻辑被清空
      args[0].inject = true; // 确保 Webpack 会自动注入
      return args;
    });
  },

  // 恢复 i18n 插件的配置，以避免可能的构建错误
  pluginOptions: {
    i18n: {
      locale: "zh-chs",
      fallbackLocale: "en",
      localeDir: "locales",
      enableInSFC: true,
    },
  },
  
  // 确保 Webpack Dev Server 在本地开发时能正常工作
  devServer: {
    historyApiFallback: true
  }
};

