// vue.config.js (v5 - 最终修正版)
const path = require("path");

function resolve(dir) {
  return path.join(__dirname, dir);
}

module.exports = {
  // 关键：设置为相对路径，确保所有资源引用正确
  publicPath: './',
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
        additionalData: `$cdnPath: "/";` 
      },
    },
  },
  chainWebpack: config => {
    // [最终修正] 恢复路径别名 (alias) 配置
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

