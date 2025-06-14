// vue.config.js (v9 - 终极路径修正版)
const path = require("path");

// ▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼
// ▼▼▼ [重要] 请将这里的 URL 替换为您自己的、不带版本号的基础地址！ ▼▼▼
// ▼▼▼ 例如: 'https://cdn.jsdelivr.net/gh/xckc/goindex-theme-acrou'      ▼▼▼
const GITHUB_REPO_URL = 'https://cdn.jsdelivr.net/gh/xckc/goindex-theme-acrou';
// ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲

const pkg = require("./package.json");
const isProd = process.env.NODE_ENV === 'production';
// 动态构建包含 /dist/ 的正确公共路径
const publicPath = isProd ? `${GITHUB_REPO_URL}@${pkg.version}/dist/` : '/';

function resolve(dir) {
  return path.join(__dirname, dir);
}

module.exports = {
  // 关键：直接使用您的完整 CDN 地址作为公共路径
  publicPath: publicPath,

  // 保留您必需的配置
  transpileDependencies: [
    'vue-plyr',
    'plyr'
  ],
  // 禁用哈希，确保输出文件名固定
  filenameHashing: false,
  // 禁用 map 文件，减小体积
  productionSourceMap: false,

  css: {
    loaderOptions: {
      sass: {
        additionalData: `$cdnPath: "${isProd ? publicPath : '/'}";` 
      },
    },
  },

  chainWebpack: config => {
    // 恢复路径别名 (alias) 配置
    config.resolve.alias
      .set("@", resolve("src"))
      .set("@api", resolve("src/api"))
      .set("@utils", resolve("src/utils"));

    // 移除 prefetch 和 preload，减少不必要的请求
    config.plugins.delete('prefetch');
    config.plugins.delete('preload');
    // 移除生成 app.min.js 的自定义插件
    config.plugins.delete('BuildAppJSPlugin'); 
    // 移除注入CDN的逻辑
    config.plugin('html').tap(args => {
      args[0].cdn = {}; // 确保 CDN 对象为空
      args[0].inject = true; // 确保 Webpack 会自动注入 JS 和 CSS
      return args;
    });
  },
  // 恢复 i18n 插件的配置以修复构建错误
  pluginOptions: {
    i18n: {
      locale: "zh-chs",
      fallbackLocale: "en",
      localeDir: "locales",
      enableInSFC: true,
    },
  },
};

