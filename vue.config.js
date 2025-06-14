const path = require('path');
const webpack = require('webpack');

// 辅助函数，用于获取绝对路径
function resolve(dir) {
  return path.join(__dirname, dir);
}

module.exports = {
  // 我们正在构建一个库/主题，而不是一个完整的网站，所以不需要 publicPath
  publicPath: './',
  // 减小最终文件体积
  productionSourceMap: false,
  // 禁用文件名哈希，得到固定的文件名
  filenameHashing: false,
  
  // 明确告诉 Babel 去编译 plyr 依赖，以解决兼容性问题
  transpileDependencies: ['plyr'],

  // 修复 i18n 插件的编译错误
  pluginOptions: {
    i18n: {
      locale: 'zh-chs',
      fallbackLocale: 'en',
      localeDir: 'locales',
      enableInSFC: true,
    },
  },

  // 修复 Sass 变量未定义的错误
  css: {
    loaderOptions: {
      scss: {
        // 将 $cdnPath 设置为根路径, 以正确引用 public 目录下的图片
        additionalData: `$cdnPath: "/";`
      }
    }
  },

  chainWebpack: config => {
    // ---------------------------------------------------------------------
    // 最终修正：强制 Webpack 只生成一个文件
    // ---------------------------------------------------------------------
    
    // 1. 移除默认的代码分割策略
    config.optimization.delete('splitChunks');
    
    // 2. 使用插件强制所有代码合并到一个块 (chunk) 中
    config
      .plugin('limit-chunk-count')
      .use(webpack.optimize.LimitChunkCountPlugin, [{
          maxChunks: 1,
      }]);

    // 3. 配置最终输出的文件名
    config.output
      .filename('app.min.js');

    // 4. 配置 CSS 输出文件名
    if (config.plugins.has('extract-css')) {
      const extractCssPlugin = config.plugin('extract-css');
      extractCssPlugin.tap(args => {
        args[0].filename = 'style.min.css';
        // 由于只有一个块，所以不需要 chunkFilename
        delete args[0].chunkFilename;
        return args;
      });
    }

    // ---------------------------------------------------------------------
    // 保留之前的修复
    // ---------------------------------------------------------------------
    
    // 1. 添加路径别名
    config.resolve.alias
      .set('@api', resolve('src/api'))
      .set('@utils', resolve('src/utils'));
      
    // 2. 移除用于网站构建、但对主题库无用的插件
    config.plugins.delete('html');
    config.plugins.delete('preload');
    config.plugins.delete('prefetch');
    config.plugins.delete('pwa');
    config.plugins.delete('workbox');
    config.plugins.delete('htmlPathCorrection');
    config.plugins.delete('buildAppJSPlugin');
  }
};

