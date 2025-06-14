const CompressionWebpackPlugin = require("compression-webpack-plugin");
const { cdn, externals } = require("./dependencies-cdn");
const isProd = process.env.NODE_ENV === "production";
const path = require('path');

function resolve(dir) {
  return path.join(__dirname, dir);
}

class HtmlPathCorrectionPlugin {
  apply(compiler) {
    compiler.hooks.emit.tapAsync('HtmlPathCorrectionPlugin', (compilation, callback) => {
      if (compilation.assets['index.html']) {
        let html = compilation.assets['index.html'].source();
        html = html.replace(/(href|src)="\/(js|css)\/([^"]+)"/g, '$1="/$3"');
        compilation.assets['index.html'] = {
          source: () => html,
          size: () => html.length,
        };
      }
      callback();
    });
  }
}

module.exports = {
  publicPath: "/",
  productionSourceMap: false,
  filenameHashing: false,
  
  // 核心改动：告诉 Babel 去编译 plyr 依赖，以解决兼容性问题
  transpileDependencies: ['plyr'],

  pluginOptions: {
    i18n: {
      locale: 'zh-chs',
      fallbackLocale: 'en',
      localeDir: 'locales',
      enableInSFC: true,
    },
  },

  css: {
    loaderOptions: {
      scss: {
        additionalData: `$cdnPath: "${process.env.VUE_APP_CDN_PATH || '/'}";`
      }
    }
  },

  configureWebpack: {
    externals: isProd ? externals : {}
  },

  chainWebpack: config => {
    config.resolve.alias
      .set('@api', resolve('src/api'))
      .set('@utils', resolve('src/utils'));

    config.plugin("html").tap(args => {
      if (isProd) args[0].cdn = cdn;
      args[0].title = 'GoIndex';
      return args;
    });
    
    if (isProd) {
      config.plugins.delete("buildAppJSPlugin");
      config.plugin("htmlPathCorrection").use(new HtmlPathCorrectionPlugin());
      config.plugin("compressionWebpackPlugin").use(
        new CompressionWebpackPlugin({
          test: /\.(js|css|html)$/,
          threshold: 10240,
        })
      );
    }
  }
};

