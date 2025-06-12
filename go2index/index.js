// =======配置项开始=======
var  authConfig  =  {
  siteName : "xckk",  // 网站名称
  version : "1.1.2" ,  // 程序版本，修改为“1.1.2”以匹配主题的检查，从而禁用更新提示
  theme: "acrou",
  // 强烈建议使用您自己的 client_id 和 client_secret
  client_id: "746239575955-oao9hkv614p8glrqpvuh5i8mqfoq145b.apps.googleusercontent.com", // 从 Google Cloud Console 获取的客户端 ID
   client_secret: "u5a1CSY5pNjdD2tGTU93TTnI",
   refresh_token: "", // 授权 token
  /*
   * 设置要显示的多个网盘；请按格式添加多个
   * [id]: 可以是团队盘id、子文件夹id、快捷方式id, 或者是 "root" (代表个人盘根目录);
   * [name]: 显示的名称
   * [user]: Basic Auth 用户名
   * [pass]: Basic Auth 密码
   * [protect_file_link]: 是否使用Basic Auth保护文件链接，默认值(不设置时)为false, 即不保护文件链接(可直链下载/外链播放等)
   * 每个盘的Basic Auth可分别设置, Basic Auth保护此盘下所有文件夹/子文件夹的路径,
   * [注意] 文件链接默认不保护, 可方便直链下载/外链播放;
   * 若您想保护文件链接, 您需要设置 protect_file_link 为 true, 如果想进行外链播放等操作, 需要将 host 换成 user:pass@host
   * 不需要Basic Auth的盘, 只需同时留空user和pass即可.(直接不设置也可以)
   * [注意] 文件夹快捷方式的搜索是在浏览器端模拟的，对于超大文件夹可能会有性能影响。
   */
  roots: [
    {
      id: "",
      name: "TeamDrive",
      pass: "",
    },
    {
      id: "root",
      name: "PrivateDrive",
      user: "",
      pass: "",
      protect_file_link: true,
    },
    {
      id: "",
      name: "folder1",
      pass: "",
    },
  ],
  default_gd: 0,
    /**
     * 文件列表页面, 每页显示数量. [推荐设置范围 100 ~ 1000];
     * 如果设置大于1000, 将导致请求drive api时出错;
     * 如果设置过小, 将导致文件列表页面滚动条滚动增量加载(分页加载)体验不好;
     * 此设置项的另一个作用是: 如果目录中文件数大于此设置值(即需要多页显示), 程序会将首次列出的目录结果缓存.
     */
  files_list_page_size: 200,
    /**
     * 搜索结果页面, 每页显示数量. [推荐设置范围 50 ~ 1000];
     * 如果设置大于1000, 将导致请求drive api时出错;
     * 如果设置过小, 将导致搜索结果页面滚动条滚动增量加载(分页加载)体验不好;
     * 此设置项的大小会影响搜索操作的响应速度.
     */
  search_result_list_page_size: 50,
// 确定可以开启 cors 时, 启用此功能
  enable_cors_file_down: false,
    /**
     * 上述 basic_auth 已包含对全盘的保护功能. 因此, 默认不再对 .password 文件中的密码进行认证;
     * 如果在全盘认证的基础上, 仍然需要对某些目录单独进行 .password 文件中的密码验证, 请将此选项设置为 true;
     * [注意] 开启 .password 文件密码验证, 会额外增加列目录时查询目录下是否存在 .password 文件的开销.
     */
  enable_password_file_verify: false,
};

var themeOptions = {
  cdn: "https://cdn.jsdelivr.net/gh/Aicirou/goindex-theme-acrou",
  // 主题版本号。必须保持 "2.0.8" 以确保能正确加载主题文件。
  version: "2.0.8",
  // 可选的默认系统语言: en/zh-chs/zh-cht
  languages: "en",
  render: {
    /**
     * 是否渲染 HEAD.md 文件
     */
    head_md: false,
    /**
     * 是否渲染 README.md 文件
     */
    readme_md: false,
    /**
     * 是否渲染文件/文件夹描述
     */
    desc: false,
  },
  /**
   * 视频播放器选项
   */
  video: {
    /**
     * 播放器api (不指定则使用默认播放器)
     */
    api: "",
    autoplay: true,
  },
  /**
   * 音频播放器选项
   */
  audio: {},
};
// =======配置项结束=======

/**
 * 全局函数
 */
const FUNCS = {
  /**
     * 转换成Google搜索语法相对安全的搜索关键字
     */
  formatSearchKeyword: function(keyword) {
    let nothing = "";
    let space = " ";
    if (!keyword) return nothing;
    return keyword
      .replace(/(!=)|['"=<>/\\:]/g, nothing)
      .replace(/[,，|(){}]/g, space)
      .trim();
  },
};

/**
 * 全局常量
 * @type {{folder_mime_type: string, default_file_fields: string, gd_root_type: {share_drive: number, user_drive: number, sub_folder: number}}}
 */
const CONSTS = new (class {
  default_file_fields =
    "parents,id,name,mimeType,modifiedTime,createdTime,fileExtension,size,shortcutDetails"; // MOD: 添加 shortcutDetails 以获取快捷方式详情
  gd_root_type = {
    user_drive: 0,
    share_drive: 1,
    sub_folder: 2,
  };
  folder_mime_type = "application/vnd.google-apps.folder";
  shortcut_mime_type = "application/vnd.google-apps.shortcut"; // ADD: 定义快捷方式的MIME类型
})();

// gd实例数组
var gds = [];

function html(current_drive_order = 0, model = {}) {
  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"> 
<meta name="viewport" content="width=device-width, initial-scale=1.0,maximum-scale=1.0, user-scalable=no"/> 
<link rel="icon" type="image/png" sizes="32x32" href="https://i.imgur.com/rOyuGjA.gif">
<script async src="https://www.googletagmanager.com/gtag/js?id=UA-86099016-6">
</script>
<script>window.dataLayer=window.dataLayer || []; function gtag(){dataLayer.push(arguments);}gtag('js', new Date()); gtag('config', 'UA-86099016-6');</script>
<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','GTM-MR47R4M');</script> 
  <title>${authConfig.siteName}</title>
  <style>
    @import url(${themeOptions.cdn}@${themeOptions.version}/dist/style.min.css);
  </style>
  <script>
    window.gdconfig = JSON.parse('${JSON.stringify({
      version: authConfig.version,
      themeOptions: themeOptions,
    })}');
    window.themeOptions = JSON.parse('${JSON.stringify(themeOptions)}');
    window.gds = JSON.parse('${JSON.stringify(
      authConfig.roots.map((it) => it.name)
    )}');
    window.MODEL = JSON.parse('${JSON.stringify(model)}');
    window.current_drive_order = ${current_drive_order};
  </script>
</head>
<body>
    <div id="app"></div>
    <script src="${themeOptions.cdn}@${
    themeOptions.version
  }/dist/app.min.js">
  </script>
</body>
</html>
`;
}

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

/**
 * 处理请求
 * @param {Request} request
 */
async function handleRequest(request) {
  if (gds.length === 0) {
    for (let i = 0; i < authConfig.roots.length; i++) {
      const gd = new googleDrive(authConfig, i);
      await gd.init();
      gds.push(gd);
    }
// 并行执行以提高效率
    let tasks = [];
    gds.forEach((gd) => {
      tasks.push(gd.initRootType());
    });
    for (let task of tasks) {
      await task;
    }
  }

    // 从路径中提取网盘顺序
      // 并根据顺序获取对应的gd实例
  let gd;
  let url = new URL(request.url);
  let path = decodeURI(url.pathname);

  /**
* 重定向到起始页
    * @returns {Response}
    */
  function redirectToIndexPage() {
    return new Response("", {
      status: 301,
      headers: { Location: `/${authConfig.default_gd}:/` },
    });
  }

  if (path == "/") return redirectToIndexPage();
  if (path.toLowerCase() == "/favicon.ico") {
// 以后可以找一个网站图标
    return new Response("", { status: 404 });
  }

// 特殊命令格式
  const command_reg = /^\/(?<num>\d+):(?<command>[a-zA-Z0-9]+)(\/.*)?$/g;
  const match = command_reg.exec(path);
  let command;
  if (match) {
    const num = match.groups.num;
    const order = Number(num);
    if (order >= 0 && order < gds.length) {
      gd = gds[order];
      // 检查根目录是否有效
      if (gd.root_type === -1) {
          return new Response(`Root '${gd.root.name}' (index: ${order}) is misconfigured or invalid.`, { status: 500 });
      }
    } else {
      return redirectToIndexPage();
    }
    // Basic Auth
    for (const r = gd.basicAuthResponse(request); r; ) return r;
    command = match.groups.command;

// 搜索
    if (command === "search") {
      if (request.method === "POST") {
// 搜索结果
        return handleSearch(request, gd);
      } else {
        const params = url.searchParams;
// 搜索页面
        return new Response(
          html(gd.order, {
            q: params.get("q") || "",
            is_search_page: true,
            // 修复：始终传递一个支持搜索的类型给前端，以强制显示搜索框
            root_type: 0, 
          }),
          {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          }
        );
      }
    } else if (command === "id2path" && request.method === "POST") {
      return handleId2Path(request, gd);
    } else if (command === "view") {
      const params = url.searchParams;
      return gd.view(params.get("url"), request.headers.get("Range"));
    } else if (command !== "down" && request.method === "GET") {
      return new Response(html(gd.order, { root_type: 0 }), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
  }
  const reg = new RegExp(`^(/\\d+:)${command}/`, "g");
  path = path.replace(reg, (p1, p2) => {
    return p2 + "/";
  });
// 预期的路径格式
  const common_reg = /^\/\d+:\/.*$/g;
  try {
    if (!path.match(common_reg)) {
      return redirectToIndexPage();
    }
    let split = path.split("/");
    let order = Number(split[1].slice(0, -1));
    if (order >= 0 && order < gds.length) {
      gd = gds[order];
      // 检查根目录是否有效
      if (gd.root_type === -1) {
          return new Response(`Root '${gd.root.name}' (index: ${order}) is misconfigured or invalid.`, { status: 500 });
      }
    } else {
      return redirectToIndexPage();
    }
  } catch (e) {
    return redirectToIndexPage();
  }

  // Basic Auth
  const basic_auth_res = gd.basicAuthResponse(request);
  path = path.replace(gd.url_path_prefix, "") || "/";
  if (request.method == "POST") {
    return basic_auth_res || apiRequest(request, gd);
  }

  let action = url.searchParams.get("a");

  if (path.substr(-1) == "/" || action != null) {
    return (
      basic_auth_res ||
      // 修复：始终传递一个支持搜索的类型给前端，以强制显示搜索框
      new Response(html(gd.order, { root_type: 0 }), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    );
  } else {
    if (
      path
        .split("/")
        .pop()
        .toLowerCase() == ".password"
    ) {
      return basic_auth_res || new Response("", { status: 404 });
    }
    let file = await gd.file(path);
    // FIX: 增加文件存在性检查
    if (!file) {
        return new Response("File not found.", { status: 404 });
    }
    let range = request.headers.get("Range");
    if (gd.root.protect_file_link && basic_auth_res) return basic_auth_res;
    const is_down = !(command && command == "down");
    return gd.down(file.id, range, is_down);
  }
}

async function apiRequest(request, gd) {
  let url = new URL(request.url);
  let path = url.pathname;
  path = path.replace(gd.url_path_prefix, "") || "/";

  let option = { status: 200, headers: { "Access-Control-Allow-Origin": "*" } };

  if (path.substr(-1) == "/") {
    let deferred_pass = gd.password(path);
    let body = await request.text();
    body = JSON.parse(body);
// 这可以在第一次列出目录时提高速度。缺点是如果密码验证失败，仍然会产生列出目录的开销
    let deferred_list_result = gd.list(
      path,
      body.page_token,
      Number(body.page_index)
    );

    // 检查 .password 文件, 如果 `enable_password_file_verify` 为 true
    if (authConfig["enable_password_file_verify"]) {
      let password = await gd.password(path);
      // console.log("dir password", password);
      if (password && password.replace("\n", "") !== body.password) {
        let html = `{"error": {"code": 401,"message": "password error."}}`;
        return new Response(html, option);
      }
    }

    let list_result = await deferred_list_result;
    return new Response(JSON.stringify(list_result), option);
  } else {
    let file = await gd.file(path);
    let range = request.headers.get("Range");
    return new Response(JSON.stringify(file));
  }
}

// 处理搜索
async function handleSearch(request, gd) {
  const option = {
    status: 200,
    headers: { "Access-Control-Allow-Origin": "*" },
  };
  let body = await request.text();
  body = JSON.parse(body);
  let search_result = await gd.search(
    body.q || "",
    body.page_token,
    Number(body.page_index)
  );
  return new Response(JSON.stringify(search_result), option);
}

/**
* 处理 id2path
 * @param request 需要 id 参数
 * @param gd
 * @returns {Promise<Response>} [注意] 如果前台接收到的id所代表的item不在目标gd盘下,此响应将返回空字符串""给前台
 */
async function handleId2Path(request, gd) {
  const option = {
    status: 200,
    headers: { "Access-Control-Allow-Origin": "*" },
  };
  let body = await request.text();
  body = JSON.parse(body);
  let path = await gd.findPathById(body.id);
  return new Response(path || "", option);
}

class googleDrive {
  constructor(authConfig, order) {
    // 每个盘对应一个 order, 对应一个 gd 实例
    this.order = order;
    this.root = authConfig.roots[order];
    this.root.protect_file_link = this.root.protect_file_link || false;
    this.url_path_prefix = `/${order}:`;
    this.authConfig = authConfig;
    // TODO: 稍后可以制定这些缓存失效刷新策略
    // 路径 id
    this.paths = [];
    // 路径文件
    this.files = [];
    // 路径密码
    this.passwords = [];
    // id <-> 路径
    this.id_path_cache = {};
    this.id_path_cache[this.root["id"]] = "/";
    this.paths["/"] = this.root["id"];
  }

  /**
   * 初始授权；然后获取 user_drive_real_root_id
   * @returns {Promise<void>}
   */
  async init() {
    await this.accessToken();
    // 等待 user_drive_real_root_id, 只获取一次
    if (authConfig.user_drive_real_root_id) return;
    const root_obj = await (gds[0] || this).findItemById("root");
    if (root_obj && root_obj.id) {
      authConfig.user_drive_real_root_id = root_obj.id;
    }
  }

  /**
   * 获取根目录类型, 设置到 root_type
   * @returns {Promise<void>}
   */
  async initRootType() {
    let root_id = this.root["id"];
    
    // 如果根目录ID为空，则将其标记为无效并返回
    if (!root_id) {
        console.error(`Root item '${this.root.name}' has no ID. Disabling.`);
        this.root_type = -1; // -1 表示无效根目录
        return;
    }

    // 检查根ID本身是否指向一个快捷方式
    const root_obj = await this.findItemById(root_id);

    if (root_obj && root_obj.mimeType === CONSTS.shortcut_mime_type) {
        if(root_obj.shortcutDetails && root_obj.shortcutDetails.targetId) {
            // 是快捷方式。将根ID更新为目标ID。
            this.root.id = root_obj.shortcutDetails.targetId;
            // 如果快捷方式指向的不是文件夹，则这是一个错误的配置。
            if (root_obj.shortcutDetails.targetMimeType !== CONSTS.folder_mime_type) {
                console.error(`Root item '${this.root.name}' is a shortcut but does not point to a folder. Disabling.`);
                this.root_type = -1; // 标记为无效
                return;
            }
            // 更新 root_id 以进行下一步的分类
            root_id = this.root.id;
        } else {
            // 是一个无效的快捷方式，没有目标
            console.error(`Root item '${this.root.name}' is an invalid shortcut with no target. Disabling.`);
            this.root_type = -1;
            return;
        }
    }

    // 现在，使用可能已解析的ID对根进行分类
    const types = CONSTS.gd_root_type;
    if (root_id === "root" || root_id === authConfig.user_drive_real_root_id) {
      this.root_type = types.user_drive;
    } else {
      // 检查解析后的ID是否为共享云端硬盘
      const drive_obj = await this.getShareDriveObjById(root_id);
      if (drive_obj) {
        this.root_type = types.share_drive;
      } else {
        // 如果不是共享云端硬盘，它必须是另一个云端硬盘中的文件夹。
        // 我们需要验证它是一个文件夹。
        const item_obj_to_check = (root_obj && root_obj.id === root_id) ? root_obj : await this.findItemById(root_id);
        if (item_obj_to_check && item_obj_to_check.mimeType === CONSTS.folder_mime_type) {
            this.root_type = types.sub_folder;
        } else {
            // 它是其他东西，可能是被配置为根的文件？无效。
            console.error(`Root item '${this.root.name}' with ID '${root_id}' is not a valid folder, shared drive, or user drive.`);
            this.root_type = -1; // 标记为无效
        }
      }
    }
  }

  /**
    * 处理单个快捷方式文件对象
    * @param {object} file
    * @returns {object}
    */
  _processShortcut(file) {
      if (file && file.mimeType === CONSTS.shortcut_mime_type && file.shortcutDetails && file.shortcutDetails.targetId) {
          return {
                ...file,
                id: file.shortcutDetails.targetId,
                mimeType: file.shortcutDetails.targetMimeType,
          };
      }
      return file;
  }

  /**
    * 处理文件列表中的所有快捷方式
    * @param {Array} files
    * @returns {Array}
    */
  _processShortcuts(files) {
      if (!files || files.length === 0) {
          return files;
      }
      return files.map(file => this._processShortcut(file));
  }


  /**
   * 返回需要授权的 response , 或者 null
   * @param request
   * @returns {Response|null}
   */
  basicAuthResponse(request) {
    const user = this.root.user || "",
      pass = this.root.pass || "",
      _401 = new Response("Unauthorized", {
        headers: {
          "WWW-Authenticate": `Basic realm="goindex:drive:${this.order}"`,
        },
        status: 401,
      });
    if (user || pass) {
      const auth = request.headers.get("Authorization");
      if (auth) {
        try {
          const [received_user, received_pass] = atob(
            auth.split(" ").pop()
          ).split(":");
          return received_user === user && received_pass === pass ? null : _401;
        } catch (e) {}
      }
    } else return null;
    return _401;
  }

  async view(url, range = "", inline = true) {
    let requestOption = await this.requestOption();
    requestOption.headers["Range"] = range;
    let res = await fetch(url, requestOption);
    const { headers } = (res = new Response(res.body, res));
    this.authConfig.enable_cors_file_down &&
      headers.append("Access-Control-Allow-Origin", "*");
    inline === true && headers.set("Content-Disposition", "inline");
    return res;
  }

  async down(id, range = "", inline = false) {
    let url = `https://www.googleapis.com/drive/v3/files/${id}?alt=media`;
    let requestOption = await this.requestOption();
    requestOption.headers["Range"] = range;
    let res = await fetch(url, requestOption);
    const { headers } = (res = new Response(res.body, res));
    this.authConfig.enable_cors_file_down &&
      headers.append("Access-Control-Allow-Origin", "*");
    inline === true && headers.set("Content-Disposition", "inline");
    return res;
  }

  async file(path) {
    if (typeof this.files[path] == "undefined") {
      this.files[path] = await this._file(path);
    }
    return this.files[path];
  }

  async _file(path) {
    let arr = path.split("/");
    let name = arr.pop();
    name = decodeURIComponent(name).replace(/\'/g, "\\'");
    let dir = arr.join("/") + "/";
    let parent = await this.findPathId(dir);
    let url = "https://www.googleapis.com/drive/v3/files";
    let params = { includeItemsFromAllDrives: true, supportsAllDrives: true };
    params.q = `'${parent}' in parents and name = '${name}' and trashed = false`;
    params.fields =
      "files(id, name, mimeType, size ,createdTime, modifiedTime, iconLink, thumbnailLink, shortcutDetails)";
    url += "?" + this.enQuery(params);
    let requestOption = await this.requestOption();
    let response = await fetch(url, requestOption);
    let obj = await response.json();
    if (!obj.files || obj.files.length === 0) {
        return undefined;
    }
    return this._processShortcut(obj.files[0]);
  }

  // 通过请求缓存进行缓存
  async list(path, page_token = null, page_index = 0) {
    if (this.path_children_cache == undefined) {
      // { <path> :[ {nextPageToken:'',data:{}}, {nextPageToken:'',data:{}} ...], ...}
      this.path_children_cache = {};
    }

    if (
      this.path_children_cache[path] &&
      this.path_children_cache[path][page_index] &&
      this.path_children_cache[path][page_index].data
    ) {
      let child_obj = this.path_children_cache[path][page_index];
      return {
        nextPageToken: child_obj.nextPageToken || null,
        curPageIndex: page_index,
        data: child_obj.data,
      };
    }

    let id = await this.findPathId(path);
    let result = await this._ls(id, page_token, page_index);
    let data = result.data;
    // 缓存多页
    if (result.nextPageToken && data.files) {
      if (!Array.isArray(this.path_children_cache[path])) {
        this.path_children_cache[path] = [];
      }
      this.path_children_cache[path][Number(result.curPageIndex)] = {
        nextPageToken: result.nextPageToken,
        data: data,
      };
    }

    return result;
  }

  async _ls(parent, page_token = null, page_index = 0) {
    if (parent == undefined) {
      return null;
    }
    let obj;
    let params = { includeItemsFromAllDrives: true, supportsAllDrives: true };
    params.q = `'${parent}' in parents and trashed = false AND name !='.password'`;
    params.orderBy = "folder,name,modifiedTime desc";
    params.fields =
      "nextPageToken, files(id, name, mimeType, size , modifiedTime, thumbnailLink, description, shortcutDetails)";
    params.pageSize = this.authConfig.files_list_page_size;

    if (page_token) {
      params.pageToken = page_token;
    }
    let url = "https://www.googleapis.com/drive/v3/files";
    url += "?" + this.enQuery(params);
    let requestOption = await this.requestOption();
    let response = await fetch(url, requestOption);
    obj = await response.json();

    if (obj.files) {
        obj.files = this._processShortcuts(obj.files);
    }

    return {
      nextPageToken: obj.nextPageToken || null,
      curPageIndex: page_index,
      data: obj,
    };
  }

  async password(path) {
    if (this.passwords[path] !== undefined) {
      return this.passwords[path];
    }

    let file = await this.file(path + ".password");
    if (file == undefined) {
      this.passwords[path] = null;
    } else {
      let url = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`;
      let requestOption = await this.requestOption();
      let response = await this.fetch200(url, requestOption);
      this.passwords[path] = await response.text();
    }

    return this.passwords[path];
  }

  /**
   * 通过id获取share drive信息
   * @param any_id
   * @returns {Promise<null|{id}|any>} 任何异常情况返回null
   */
  async getShareDriveObjById(any_id) {
    if (!any_id) return null;
    if ("string" !== typeof any_id) return null;

    let url = `https://www.googleapis.com/drive/v3/drives/${any_id}`;
    let requestOption = await this.requestOption();
    let res = await fetch(url, requestOption);
    let obj = await res.json();
    if (obj && obj.id) return obj;

    return null;
  }

  /**
   * 搜索
   * @returns {Promise<{data: null, nextPageToken: null, curPageIndex: number}>}
   */
  async search(origin_keyword, page_token = null, page_index = 0) {
    const types = CONSTS.gd_root_type;
    const is_user_drive = this.root_type === types.user_drive;
    const is_share_drive = this.root_type === types.share_drive;
    const is_sub_folder = this.root_type === types.sub_folder;

    const empty_result = {
      nextPageToken: null,
      curPageIndex: page_index,
      data: { files: [] },
    };

    if (!origin_keyword) {
      // 关键字为空，返回
      return empty_result;
    }
    
    // 如果是子文件夹（或指向子文件夹的快捷方式），执行客户端模拟搜索
    if (is_sub_folder) {
        // listAllFiles 函数会返回带有正确路径的文件列表
        const all_files = await this.listAllFiles(this.root.id);
        
        // 直接根据文件名过滤
        const filtered_files = all_files.filter(file => file.name.toLowerCase().includes(origin_keyword.toLowerCase()));
        
        // FIX: 将找到的文件的路径缓存起来，以便id2path可以正确工作
        filtered_files.forEach(file => {
          if (file.id && file.path) {
            this.id_path_cache[file.id] = file.path;
          }
        });
        
        return {
            ...empty_result,
            data: { files: filtered_files },
        };
    }


    if (!is_user_drive && !is_share_drive) {
      return empty_result;
    }

    const sanitized_keyword = origin_keyword.replace(/'/g, "\\'");
    const name_search_str = `name contains '${sanitized_keyword}'`;

    let params = {};
    if (is_user_drive) {
      params.corpora = "user";
    }
    if (is_share_drive) {
      params.corpora = "drive";
      params.driveId = this.root.id;
      params.includeItemsFromAllDrives = true;
      params.supportsAllDrives = true;
    }
    if (page_token) {
      params.pageToken = page_token;
    }
    params.q = `trashed = false AND name !='.password' AND (${name_search_str})`;
    params.fields =
      "nextPageToken, files(id, name, mimeType, size , modifiedTime, thumbnailLink, description, shortcutDetails)";
    params.pageSize = this.authConfig.search_result_list_page_size;

    let url = "https://www.googleapis.com/drive/v3/files";
    url += "?" + this.enQuery(params);
    let requestOption = await this.requestOption();
    let response = await fetch(url, requestOption);
    let res_obj = await response.json();

    if (res_obj.files) {
        res_obj.files = this._processShortcuts(res_obj.files);
    }

    return {
      nextPageToken: res_obj.nextPageToken || null,
      curPageIndex: page_index,
      data: res_obj,
    };
  }

  // REVISED: 递归获取文件夹下所有文件，并构建其相对路径
  async listAllFiles(folderId, basePath = '/') {
    const allFiles = [];
    // 队列中现在存储对象，包含ID和其对应的路径
    const foldersToProcess = [{ id: folderId, path: basePath }];
    const processedFolders = new Set();

    while (foldersToProcess.length > 0) {
      const { id: currentFolderId, path: currentPath } = foldersToProcess.shift();

      if (processedFolders.has(currentFolderId)) {
        continue;
      }
      processedFolders.add(currentFolderId);

      try {
        let pageToken = null;
        do {
          // _ls 内部已经调用了 _processShortcuts, 返回的是处理过的文件列表
          const result = await this._ls(currentFolderId, pageToken, 0);
          if (result && result.data && result.data.files) {
            for (const item of result.data.files) {
              // 构建当前文件/文件夹的完整相对路径
              const itemPath = (currentPath + item.name).replace('//', '/');
              
              if (item.mimeType === CONSTS.folder_mime_type) {
                // 如果是文件夹，将其完整路径和ID加入处理队列
                allFiles.push({ ...item, path: itemPath + '/' });
                foldersToProcess.push({ id: item.id, path: itemPath + '/' });
              } else {
                // 如果是文件，直接添加
                allFiles.push({ ...item, path: itemPath });
              }
            }
          }
          pageToken = result.nextPageToken;
        } while (pageToken);
      } catch (e) {
        console.error(`Failed to list folder ${currentFolderId}:`, e.message);
        // 如果无法列出某个文件夹（如权限不足），则跳过并继续处理其他文件夹
      }
    }
    return allFiles;
  }

    /**
     * 逐个向上获取此文件或文件夹的父级文件夹的文件对象. 注意:会很慢!!!
     * 最多向上查找至当前gd对象的根目录(root id)
     * 只考虑单个向上链。
     * [注]如果此id代表的item不在目标gd盘下,那么此方法将返回null
     *
     * @param child_id
     * @param contain_myself
     * @param force_reload 强制重新加载，忽略缓存
     * @returns {Promise<[]>}
     */
  async findParentFilesRecursion(child_id, contain_myself = true, force_reload = false) {
    const gd = this;
    const gd_root_id = gd.root.id;
    const user_drive_real_root_id = authConfig.user_drive_real_root_id;
    const is_user_drive = gd.root_type === CONSTS.gd_root_type.user_drive;

    // 自下而上查询的终点id
    const target_top_id = is_user_drive ? user_drive_real_root_id : gd_root_id;
    const fields = CONSTS.default_file_fields;

    const parent_files = [];
    let meet_top = false;

    async function addItsFirstParent(file_obj) {
      if (!file_obj || !file_obj.id) return;
      
      if (file_obj.id === target_top_id) {
        meet_top = true;
        return;
      }

      if (!file_obj.parents || file_obj.parents.length < 1) {
        // 如果一个文件没有父文件夹，它可能位于"我的云端硬盘"的根目录中
        if (is_user_drive) meet_top = true;
        return;
      }
      
      // 它的第一个父级
      const first_p_id = file_obj.parents[0];
      if (first_p_id === target_top_id) {
        meet_top = true;
        return;
      }

      try {
        const p_file_obj = await gd.findItemById(first_p_id, true); // 获取原始对象
        if (p_file_obj && p_file_obj.id) {
          parent_files.push(p_file_obj);
          await addItsFirstParent(p_file_obj);
        }
      } catch (e) {
        console.error("Error finding parent:", e.message);
        meet_top = false;
      }
    }

    const child_obj = await gd.findItemById(child_id, true); // 获取原始对象
    if (contain_myself) {
      parent_files.push(child_obj);
    }
    await addItsFirstParent(child_obj);

    return meet_top ? parent_files : null;
  }

  /**
   * 获取文件相对于本盘根目录的路径
   * @param child_id
   * @param force_reload - 是否强制忽略并刷新缓存
   * @returns {Promise<string>} [注]如果此id代表的item不在目标gd盘下,那么此方法将返回空字符串""
   */
  async findPathById(child_id, force_reload = false) {
    if (!force_reload && this.id_path_cache[child_id]) {
      return this.id_path_cache[child_id];
    }

    const p_files = await this.findParentFilesRecursion(child_id, true, force_reload);
    if (!p_files || p_files.length < 1) return "";

    // p_files is [child, parent1, parent2, ...]. We need to reverse it for path building.
    const path_parts = p_files.map(it => it.name).reverse();
    let path = "/" + path_parts.join("/");

    // The first file in p_files is the child object itself.
    const child_obj_raw = p_files[0];
    const child_obj_processed = this._processShortcut(child_obj_raw);

    if (child_obj_processed.mimeType === CONSTS.folder_mime_type) {
        path += "/";
    }

    // Only set cache if not forcing reload
    if (!force_reload) {
        // 缓存时使用原始ID
        this.id_path_cache[child_obj_raw.id] = path;
        this.paths[path] = child_obj_raw.id;
    }
    
    return path;
  }

  // 根据id获取文件item
  async findItemById(id, raw = false) {
    const is_user_drive = this.root_type === CONSTS.gd_root_type.user_drive;
    let url = `https://www.googleapis.com/drive/v3/files/${id}?fields=${
      CONSTS.default_file_fields
    }${is_user_drive ? "" : "&supportsAllDrives=true"}`;
    let requestOption = await this.requestOption();
    let res = await fetch(url, requestOption);
    const file = await res.json();
    if (file.error) {
        throw new Error(`API Error: ${file.error.message}`);
    }
    return raw ? file : this._processShortcut(file);
  }

  async findPathId(path) {
    let c_path = "/";
    let c_id = this.paths["/"];

    let arr = path.trim("/").split("/");
    for (let name of arr) {
        if (!name) continue;
      c_path += name + "/";

      if (typeof this.paths[c_path] == "undefined") {
        let id = await this._findDirId(c_id, name);
        this.paths[c_path] = id;
      }

      c_id = this.paths[c_path];
      if (c_id == undefined || c_id == null) {
        break;
      }
    }
    return this.paths[path];
  }

  async _findDirId(parent, name) {
    name = decodeURIComponent(name).replace(/\'/g, "\\'");

    if (parent == undefined) {
      return null;
    }

    let url = "https://www.googleapis.com/drive/v3/files";
    let params = { includeItemsFromAllDrives: true, supportsAllDrives: true };
    params.q = `'${parent}' in parents and (mimeType = 'application/vnd.google-apps.folder' or mimeType = '${CONSTS.shortcut_mime_type}') and name = '${name}'  and trashed = false`;
    params.fields = "nextPageToken, files(id, name, mimeType, shortcutDetails)";
    url += "?" + this.enQuery(params);
    let requestOption = await this.requestOption();
    let response = await fetch(url, requestOption);
    let obj = await response.json();
    if (obj.files == undefined || obj.files.length === 0) {
      return null;
    }
    
    const file = this._processShortcut(obj.files[0]);
    return file.id;
  }

  async accessToken() {
    if (
      this.authConfig.expires == undefined ||
      this.authConfig.expires < Date.now()
    ) {
      const obj = await this.fetchAccessToken();
      if (obj.access_token != undefined) {
        this.authConfig.accessToken = obj.access_token;
        this.authConfig.expires = Date.now() + 3500 * 1000;
      }
    }
    return this.authConfig.accessToken;
  }

  async fetchAccessToken() {
    const url = "https://www.googleapis.com/oauth2/v4/token";
    const headers = {
      "Content-Type": "application/x-www-form-urlencoded",
    };
    const post_data = {
      client_id: this.authConfig.client_id,
      client_secret: this.authConfig.client_secret,
      refresh_token: this.authConfig.refresh_token,
      grant_type: "refresh_token",
    };

    let requestOption = {
      method: "POST",
      headers: headers,
      body: this.enQuery(post_data),
    };

    const response = await fetch(url, requestOption);
    return await response.json();
  }

  async fetch200(url, requestOption) {
    let response;
    for (let i = 0; i < 3; i++) {
      response = await fetch(url, requestOption);
      console.log(response.status);
      if (response.status != 403) {
        break;
      }
      await this.sleep(800 * (i + 1));
    }
    return response;
  }

  async requestOption(headers = {}, method = "GET") {
    const accessToken = await this.accessToken();
    headers["authorization"] = "Bearer " + accessToken;
    return { method: method, headers: headers };
  }

  enQuery(data) {
    const ret = [];
    for (let d in data) {
      ret.push(encodeURIComponent(d) + "=" + encodeURIComponent(data[d]));
    }
    return ret.join("&");
  }

  sleep(ms) {
    return new Promise(function(resolve, reject) {
      let i = 0;
      setTimeout(function() {
        i++;
        if (i >= 2) reject(new Error("i>=2"));
        else resolve(i);
      }, ms);
    });
  }
}

String.prototype.trim = function(char) {
  if (char) {
    return this.replace(
      new RegExp("^\\" + char + "+|\\" + char + "+$", "g"),
      ""
    );
  }
  return this.replace(/^\s+|\s+$/g, "");
};
