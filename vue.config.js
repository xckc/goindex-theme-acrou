const path = require("path");
// 保留原始依赖文件，但我们会在下面禁用它
const cdnDependencies = require("./dependencies-cdn"); 
const BuildAppJSPlugin = require("./buildAppJSPlugin");
const CompressionWebpackPlugin = require("compression-webpack-plugin");
const { set } = require("lodash");

function resolve(dir) {
  return path.join(__dirname, dir);
}

process.env.VUE_APP_VERSION = require("./package.json").version;
process.env.VUE_APP_G2INDEX_VERSION = require("./package.json").g2index;
process.env.VUE_APP_CDN_PATH = process.env.VUE_APP_CDN_PATH.replace("@master", "@v" + process.env.VUE_APP_VERSION) || "/";

let publicPath = process.env.VUE_APP_CDN_PATH || "/";
let cdnPath = process.env.VUE_APP_CDN_PATH;
const isProd = process.env.NODE_ENV === "production";

// 我们不再需要这个 externals 对象，因为所有东西都要打包
// let externals = {};
// cdnDependencies.forEach((item) => {
//   externals[item.name] = item.library;
// });

const cdn = {
   css: cdnDependencies.map((e) => e.css).filter((e) => e),
   js: cdnDependencies.map((e) => e.js).filter((e) => e),
};

module.exports = {
  publicPath,
  lintOnSave: true,
  // 保留您必需的配置
  transpileDependencies: [
    'vue-plyr',
    'plyr'
  ],
  // 新增：禁用文件名哈希，确保输出文件名固定为 app.js, chunk-vendors.js 等
  filenameHashing: false,
  css: {
    loaderOptions: {
      sass: {
        additionalData: `$cdnPath: "${isProd ? cdnPath : "/"}";`,
      },
    },
  },
  configureWebpack: (config) => {
    const configNew = {};
    if (isProd) {
      // 注释掉 externals，让所有库都打包进来
      // configNew.externals = externals;
      configNew.plugins = [
        new CompressionWebpackPlugin({
          filename: "[path].gz[query]",
          test: new RegExp("\\.(" + ["js", "css"].join("|") + ")$"),
          threshold: 10240,
          minRatio: 0.8,
          deleteOriginalAssets: false,
        }),
      ];
    }
    return configNew;
  },

  chainWebpack: (config) => {
    // 保留此插件
    config.plugin("BuildAppJSPlugin").use(BuildAppJSPlugin);

    // **关键修改**：我们不再让它注入CDN，而是让它使用正常的打包流程
    // 因此注释掉下面的 tap 调用
    /*
    config.plugin("html").tap((options) => {
      if (isProd) {
        set(options, "[0].cdn", cdn);
      } else {
        set(options, "[0].cdn", {
          js: cdnDependencies.filter((e) => e.name === "").map((e) => e.js),
          css: cdnDependencies.filter((e) => e.name === "").map((e) => e.css),
        });
      }
      set(options, "[0].inject", false);
      return options;
    });
    */

    if (isProd) {
      config.plugins.delete("prefetch").delete("preload");
    }
    config.resolve.symlinks(true);
    config.resolve.alias
      .set("@", resolve("src"))
      .set("@assets", resolve("src/assets"))
      .set("@utils", resolve("src/utils"))
      .set("@api", resolve("src/api"))
      .set("@node_modules", resolve("node_modules"));

    if (process.env.npm_config_report) {
      config
        .plugin("webpack-bundle-analyzer")
        .use(require("webpack-bundle-analyzer").BundleAnalyzerPlugin);
    }
  },

  productionSourceMap: false,

  devServer: {
    publicPath,
    proxy: {
      "/api": {
        target: "https://ossdev.achirou.workers.dev/",
        ws: true,
        changeOrigin: true,
        pathRewrite: {
          "^/api": "",
        },
      },
    },
  },

  pluginOptions: {
    i18n: {
      locale: "zh-chs",
      fallbackLocale: "en",
      localeDir: "locales",
      enableInSFC: true,
    },
  },
};

