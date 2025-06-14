// vue.config.js (v7 - 终极完整版)
const path = require("path");

function resolve(dir) {
  return path.join(__dirname, dir);
}

// ▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼
// ▼▼▼ [重要] 请将这里的 URL 替换为您自己的、带版本号的最终 jsDelivr 地址！ ▼▼▼
// ▼▼▼ 例如: 'https://cdn.jsdelivr.net/gh/xckc/goindex-theme-acrou@v1.0.2/'       ▼▼▼
const DEPLOY_URL = 'https://cdn.jsdelivr.net/gh/xckc/goindex-theme-acrou@v1.0.4/';
// ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲

module.exports = {
  // 关键：直接使用您的完整 CDN 地址作为公共路径
  publicPath: process.env.NODE_ENV === 'production' ? DEPLOY_URL : '/',

  // 保留您必需的配置
  transpileDependencies: [
    'vue-plyr',
    'plyr'
  ],
  // 禁用哈希，确保输出文件名固定
  filenameHashing: false,
  // 禁用 map 文件，减小体积
  productionSourceMap: false,
  // [最终修正] 恢复 CSS loader options 来定义 $cdnPath 变量
  css: {
    loaderOptions: {
      sass: {
        additionalData: `$cdnPath: "${process.env.NODE_ENV === 'production' ? DEPLOY_URL : '/'}";` 
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

