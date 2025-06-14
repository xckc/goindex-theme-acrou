// =======配置项开始=======
var authConfig = {
  siteName: "xckk", // 网站名称
  version: "1.1.2", // 程序版本，修改为“1.1.2”以匹配主题的检查，从而禁用更新提示
  theme: "acrou",
  // [重要] 凭证已从代码中移除，将从Cloudflare环境变量安全加载
  // CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN, DRIVE_ROOTS
  // [选填] ADMIN_PASS 用于开启手动清理缓存的功能
  // [IMPORTANT] Credentials have been removed from the code and will be securely loaded from Cloudflare's environment variables.
  // CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN, DRIVE_ROOTS
  // [Optional] ADMIN_PASS to enable the manual cache clearing feature
  
  // --- 新增：KV 缓存优化配置 ---
  enable_kv_cache: true, // 设置为 true 来启用 KV 缓存功能。
  kv_cache_ttl: 3600,    // 缓存有效时间（秒），例如 3600 秒 = 1 小时。 TTL 必须是大于等于 60 的整数。

  // --- 新增：性能与健壮性配置 ---
  fetch_timeout: 8000, // API请求超时时间（毫秒），例如 8000ms = 8秒
  list_concurrency: 4, // 遍历文件夹时，并行请求的数量，建议值为 3-5

  roots: [],
  default_gd: 0,
  files_list_page_size: 200,
  search_result_list_page_size: 50,
  enable_cors_file_down: false,
  enable_password_file_verify: false,
};
// --- 从环境变量安全加载 `roots` 配置 ---
try {
  // 检查 DRIVE_ROOTS 环境变量是否已设置
  if (typeof DRIVE_ROOTS !== 'undefined' && DRIVE_ROOTS) {
      authConfig.roots = JSON.parse(DRIVE_ROOTS);
  } else {
      // 如果环境变量未设置，则发出警告，程序将不会加载任何驱动器。
      console.warn("`DRIVE_ROOTS` environment variable is not set. The application will not have any drives to display.");
  }
} catch (e) {
  console.error("Failed to parse `DRIVE_ROOTS` environment variable. Please ensure it is a valid JSON array.", e);
  authConfig.roots = []; // 解析失败时使用空数组
}
var themeOptions = {
  // [重要] 请将这里的 CDN 地址替换为您自己托管的新主题地址！
  // [IMPORTANT] Please replace the CDN URL here with your own hosted theme address!
  cdn: "https://cdn.jsdelivr.net/gh/Aicirou/goindex-theme-acrou",
  version: "2.0.8",
  languages: "en",
  render: {
      head_md: false,
      readme_md: false,
      desc: false,
  },
  video: {
      api: "",
      autoplay: true,
  },
  audio: {},
};
// =======配置项结束=======

// =========================================================
//            >>> 全局工具函数 <<<
// =========================================================

/**
 * 带有超时控制的 fetch 函数
 * @param {string|Request} resource
 * @param {object} options
 * @param {number} timeout 超时时间（毫秒）
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(resource, options = {}, timeout = authConfig.fetch_timeout) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(resource, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(id);
        return response;
    } catch (error) {
        clearTimeout(id);
        if (error.name === 'AbortError') {
            throw new Error(`Request timed out after ${timeout}ms`);
        }
        throw error;
    }
}


/**
* 全局常量
*/
const CONSTS = new (class {
  default_file_fields = "parents,id,name,mimeType,modifiedTime,createdTime,fileExtension,size,shortcutDetails";
  gd_root_type = {
      user_drive: 0,
      share_drive: 1,
      sub_folder: 2,
  };
  folder_mime_type = "application/vnd.google-apps.folder";
  shortcut_mime_type = "application/vnd.google-apps.shortcut";
})();

// gd实例数组 (懒加载)
var gds = [];

function html(current_drive_order = 0, model = {}) {
  // 将ADMIN_PASS的配置状态传递给前端，供主题内部逻辑使用
  const gdconfig = {
    version: authConfig.version,
    themeOptions: themeOptions,
    isAdminPassSet: typeof ADMIN_PASS !== 'undefined' && ADMIN_PASS !== ''
  };

  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"> 
<meta name="viewport" content="width=device-width, initial-scale=1.0,maximum-scale=1.0, user-scalable=no"/> 
<link rel="icon" type="image/png" sizes="32x32" href="https://i.imgur.com/rOyuGjA.gif">
<title>${authConfig.siteName}</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/5.15.3/css/all.min.css">
<style>@import url(${themeOptions.cdn}@${themeOptions.version}/dist/style.min.css);</style>
<script>
  window.gdconfig = JSON.parse('${JSON.stringify(gdconfig)}');
  window.themeOptions = JSON.parse('${JSON.stringify(themeOptions)}');
  window.gds = JSON.parse('${JSON.stringify(authConfig.roots.map((it) => it.name))}');
  window.MODEL = JSON.parse('${JSON.stringify(model)}');
  window.current_drive_order = ${current_drive_order};
</script>
</head>
<body>
  <div id="app"></div>
  <script src="${themeOptions.cdn}@${themeOptions.version}/dist/app.min.js"></script>
</body>
</html>
`;
}

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

/**
* 主请求处理函数
*/
async function handleRequest(request) {
  let gd;
  let url = new URL(request.url);
  let path = decodeURI(url.pathname);

  function redirectToIndexPage() {
      return new Response("", {
          status: 301,
          headers: { Location: `/${authConfig.default_gd}:/` },
      });
  }
  if (path == "/") return redirectToIndexPage();
  if (path.toLowerCase() == "/favicon.ico") {
      return new Response("", { status: 404 });
  }
  // 从路径中解析盘符 (order)
  let order;
  const pathSegments = path.split('/');
  if (pathSegments.length > 1 && pathSegments[1].includes(':')) {
      order = parseInt(pathSegments[1].slice(0, -1));
  } else {
      return redirectToIndexPage();
  }
  
  // 检查盘符合法性
  if (isNaN(order) || order < 0 || order >= authConfig.roots.length) {
      return redirectToIndexPage();
  }
  // =================================================
  //  懒加载优化: 按需初始化 googleDrive 实例
  // =================================================
  if (!gds[order]) {
      try {
          const newGd = new googleDrive(authConfig, order);
          await newGd.init(); // 初始化 token
          await newGd.initRootType(); // 初始化 root 类型
          if (newGd.root_type === -1) { // 检查初始化是否成功
               return new Response(`Root '${authConfig.roots[order].name}' (index: ${order}) is misconfigured or failed to initialize.`, { status: 500 });
          }
          gds[order] = newGd;
      } catch (e) {
          return new Response(`Failed to initialize drive ${order}: ${e.message}`, { status: 500 });
      }
  }
  
  gd = gds[order];
  if (!gd) {
      return new Response(`Drive ${order} is not available.`, { status: 500 });
  }
  
  // 解析命令
  const command_reg = /^\/(?<num>\d+):(?<command>[a-zA-Z0-9]+)(\/.*)?$/g;
  const match = command_reg.exec(path);
  let command;
  if (match) {
      for (const r = gd.basicAuthResponse(request); r;) return r;
      command = match.groups.command;
      if (command === "search") {
          if (request.method === "POST") {
              return handleSearch(request, gd);
          } else {
              const params = url.searchParams;
              let resp = new Response(
                  html(gd.order, {
                      q: params.get("q") || "",
                      is_search_page: true,
                      root_type: 1,
                  }), {
                      status: 200,
                      headers: { "Content-Type": "text/html; charset=utf-8" },
                  }
              );
            resp.headers.set('Cache-Control', 'no-store');
            return resp;
          }
      } else if (command === "id2path" && request.method === "POST") {
          return handleId2Path(request, gd);
      } else if (command === "clearcache" && request.method === "POST") {
          return handleClearCache(request, gd);
      } else if (command === "view") {
          const params = url.searchParams;
          return gd.view(params.get("url"), request.headers.get("Range"));
      } else if (command !== "down" && request.method === "GET") {
          let resp = new Response(html(gd.order, { root_type: 1 }), {
              status: 200,
              headers: { "Content-Type": "text/html; charset=utf-8" },
          });
          resp.headers.set('Cache-Control', 'no-store');
          return resp;
      }
  }
  if (command) {
      const reg = new RegExp(`^(/\\d+:)${command}/`, "g");
      path = path.replace(reg, (p1, p2) => {
          return p2 + "/";
      });
  }
  const basic_auth_res = gd.basicAuthResponse(request);
  path = path.replace(gd.url_path_prefix, "") || "/";
  if (request.method == "POST") {
      return basic_auth_res || apiRequest(request, gd);
  }
  let action = url.searchParams.get("a");
  if (path.substr(-1) == "/" || action != null) {
      let resp = new Response(html(gd.order, { root_type: 1 }), {
              status: 200,
              headers: { "Content-Type": "text/html; charset=utf-8" },
          });
      resp.headers.set('Cache-Control', 'no-store');
      return basic_auth_res || resp;
  } else {
      if (path.split("/").pop().toLowerCase() == ".password") {
          return basic_auth_res || new Response("", { status: 404 });
      }
      let file = await gd.file(path);
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
      let body = await request.json();
      let list_result = await gd.list(
          path,
          body.page_token,
          Number(body.page_index)
      );
      return new Response(JSON.stringify(list_result), option);
  } else {
      let file = await gd.file(path);
      return new Response(JSON.stringify(file));
  }
}
async function handleSearch(request, gd) {
  const option = {
      status: 200,
      headers: { "Access-Control-Allow-Origin": "*" },
  };
  let body = await request.json();
  let search_result = await gd.search(
      body.q || "",
      body.page_token,
      Number(body.page_index)
  );
  return new Response(JSON.stringify(search_result), option);
}
async function handleId2Path(request, gd) {
  const option = {
      status: 200,
      headers: { "Access-Control-Allow-Origin": "*" },
  };
  let body = await request.json();
  let path = await gd.findPathById(body.id);
  return new Response(path || "", option);
}
async function handleClearCache(request, gd) {
    const adminPass = typeof ADMIN_PASS !== 'undefined' ? ADMIN_PASS : null;
    const responseHeaders = { 
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
    };

    if (!adminPass) {
        return new Response(JSON.stringify({ success: false, message: "ADMIN_PASS is not configured on the worker." }), { status: 403, headers: responseHeaders });
    }

    try {
        const body = await request.json();
        if (body.password !== adminPass) {
            return new Response(JSON.stringify({ success: false, message: "Invalid password." }), { status: 401, headers: responseHeaders });
        }

        const result = await gd.clearKvCache();
        return new Response(JSON.stringify(result), { status: 200, headers: responseHeaders });

    } catch (e) {
        return new Response(JSON.stringify({ success: false, message: e.message }), { status: 500, headers: responseHeaders });
    }
}
class googleDrive {
  constructor(authConfig, order) {
      this.order = order;
      this.root = authConfig.roots[order];
      this.root.protect_file_link = this.root.protect_file_link || false;
      this.url_path_prefix = `/${order}:`;
      this.authConfig = { ...authConfig };
      this.authConfig.client_id = typeof CLIENT_ID !== 'undefined' ? CLIENT_ID : "";
      this.authConfig.client_secret = typeof CLIENT_SECRET !== 'undefined' ? CLIENT_SECRET : "";
      this.authConfig.refresh_token = typeof REFRESH_TOKEN !== 'undefined' ? REFRESH_TOKEN : "";
      
      this.cache = {
        files: new Map(),
        files_by_id: new Map(),
        paths: new Map(),
        id_to_path: new Map()
      };
      this.cache.paths.set('/', this.root['id']);
      this.cache.id_to_path.set(this.root['id'], '/');

      this.kv_cache_available = this.authConfig.enable_kv_cache && typeof GD_INDEX_CACHE !== 'undefined';
  }
  async _kv_get(key) {
      if (!this.kv_cache_available) return null;
      return await GD_INDEX_CACHE.get(key, 'json');
  }
  async _kv_put(key, value) {
      if (!this.kv_cache_available) return;
      const ttl = Math.max(60, this.authConfig.kv_cache_ttl);
      return await GD_INDEX_CACHE.put(key, JSON.stringify(value), { expirationTtl: ttl });
  }
  async init() {
      if (!this.authConfig.client_id || !this.authConfig.client_secret || !this.authConfig.refresh_token) {
          throw new Error(`Credentials are not configured in environment variables (CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN)`);
      }
      await this.accessToken();
      if (authConfig.user_drive_real_root_id) return;
      
      if (this.order === 0) {
          const root_obj = await this.findItemById("root");
          if (root_obj && root_obj.id) {
              authConfig.user_drive_real_root_id = root_obj.id;
          }
      }
  }
  async initRootType() {
      this.root_type = -1;
      let root_id = this.root["id"];
      if (!root_id) {
          console.error(`Root item '${this.root.name}' has no ID. Disabling.`);
          return;
      }
      const root_obj = await this.findItemById(root_id);
      if (root_obj && root_obj.mimeType === CONSTS.shortcut_mime_type) {
          if (root_obj.shortcutDetails && root_obj.shortcutDetails.targetId) {
              this.root.id = root_obj.shortcutDetails.targetId;
              if (root_obj.shortcutDetails.targetMimeType !== CONSTS.folder_mime_type) {
                  console.error(`Root item '${this.root.name}' is a shortcut but does not point to a folder. Disabling.`);
                  return;
              }
              root_id = this.root.id;
          } else {
              console.error(`Root item '${this.root.name}' is an invalid shortcut with no target. Disabling.`);
              return;
          }
      }
      const types = CONSTS.gd_root_type;
      if (this.order === 0 && !authConfig.user_drive_real_root_id) {
          await this.init();
      }
      if (root_id === "root" || root_id === authConfig.user_drive_real_root_id) {
          this.root_type = types.user_drive;
      } else {
          const drive_obj = await this.getShareDriveObjById(root_id);
          if (drive_obj) {
              this.root_type = types.share_drive;
          } else {
              const item_obj_to_check = (root_obj && root_obj.id === root_id) ? root_obj : await this.findItemById(root_id);
              if (item_obj_to_check && item_obj_to_check.mimeType === CONSTS.folder_mime_type) {
                  this.root_type = types.sub_folder;
              } else {
                  console.error(`Root item '${this.root.name}' with ID '${root_id}' is not a valid folder, shared drive, or user drive.`);
              }
          }
      }
  }
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
  _processShortcuts(files) {
      if (!files || files.length === 0) {
          return files;
      }
      return files.map(file => this._processShortcut(file));
  }
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
      let res = await fetchWithTimeout(url, requestOption);
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
      let res = await fetchWithTimeout(url, requestOption);
      const { headers } = (res = new Response(res.body, res));
      this.authConfig.enable_cors_file_down &&
      headers.append("Access-Control-Allow-Origin", "*");
      inline === true && headers.set("Content-Disposition", "inline");
      return res;
  }
  async file(path) {
      if (this.cache.files.has(path)) {
          return this.cache.files.get(path);
      }
      const cacheKey = `file:${this.order}:${path}`;
      let file = await this._kv_get(cacheKey);
      if (file) {
          this.cache.files.set(path, file);
          return file;
      }
      file = await this._file(path);
      if (file) {
        this.cache.files.set(path, file);
          await this._kv_put(cacheKey, file);
      }
      return file;
  }
  async _file(path) {
      let arr = path.split("/");
      let name = arr.pop();
      name = decodeURIComponent(name).replace(/\'/g, "\\'");
      let dir = arr.join("/") + "/";
      let parent = await this.findPathId(dir);
      if (!parent) return undefined;
      let url = "https://www.googleapis.com/drive/v3/files";
      let params = { includeItemsFromAllDrives: true, supportsAllDrives: true };
      params.q = `'${parent}' in parents and name = '${name}' and trashed = false`;
      params.fields = "files(id, name, mimeType, size ,createdTime, modifiedTime, iconLink, thumbnailLink, shortcutDetails)";
      url += "?" + this.enQuery(params);
      let requestOption = await this.requestOption();
      let response = await fetchWithTimeout(url, requestOption);
      let obj = await response.json();
      if (!obj.files || obj.files.length === 0) {
          return undefined;
      }
      return this._processShortcut(obj.files[0]);
  }
  async list(path, page_token = null, page_index = 0) {
      const cacheKey = `list:${this.order}:${path}:${page_index}:${page_token || ''}`;
      let list_result = await this._kv_get(cacheKey);
      if (list_result) {
          return list_result;
      }
      let id = await this.findPathId(path);
      list_result = await this._ls(id, page_token, page_index);
      if (list_result && list_result.data) {
          await this._kv_put(cacheKey, list_result);
      }
      return list_result;
  }
  async _ls(parent, page_token = null, page_index = 0) {
      if (parent == undefined) {
          return null;
      }
      let params = { includeItemsFromAllDrives: true, supportsAllDrives: true };
      params.q = `'${parent}' in parents and trashed = false AND name !='.password'`;
      params.orderBy = "folder,name,modifiedTime desc";
      params.fields = "nextPageToken, files(id, name, mimeType, size , modifiedTime, thumbnailLink, description, shortcutDetails)";
      params.pageSize = this.authConfig.files_list_page_size;
      if (page_token) {
          params.pageToken = page_token;
      }
      let url = "https://www.googleapis.com/drive/v3/files";
      url += "?" + this.enQuery(params);
      let requestOption = await this.requestOption();
      let response = await fetchWithTimeout(url, requestOption);
      let obj = await response.json();
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
      if (this.cache.passwords && this.cache.passwords[path] !== undefined) {
          return this.cache.passwords[path];
      }
      let file = await this.file(path + ".password");
      if (file == undefined) {
        if(!this.cache.passwords) this.cache.passwords = {};
          this.cache.passwords[path] = null;
      } else {
          let url = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`;
          let requestOption = await this.requestOption();
          let response = await this.fetch200(url, requestOption);
        if(!this.cache.passwords) this.cache.passwords = {};
          this.cache.passwords[path] = await response.text();
      }
      return this.cache.passwords[path];
  }
  async getShareDriveObjById(any_id) {
      if (!any_id) return null;
      if ("string" !== typeof any_id) return null;
      let url = `https://www.googleapis.com/drive/v3/drives/${any_id}`;
      let requestOption = await this.requestOption();
      let res = await fetchWithTimeout(url, requestOption);
      let obj = await res.json();
      if (obj && obj.id) return obj;
      return null;
  }
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
          return empty_result;
      }
      
      if (is_sub_folder) {
          let all_files;
          const cacheKey = `all_files:${this.order}:${this.root.id}`;
          all_files = await this._kv_get(cacheKey);
          if (!all_files) {
              all_files = await this.listAllFiles(this.root.id);
              await this._kv_put(cacheKey, all_files);
          }
          const filtered_files = all_files.filter(file => file.name.toLowerCase().includes(origin_keyword.toLowerCase()));
          
          filtered_files.forEach(file => {
              if (file.id && file.path) {
                  this.cache.id_to_path.set(file.id, file.path);
                  const id2pathCacheKey = `path_by_id:${this.order}:${file.id}`;
                  this._kv_put(id2pathCacheKey, file.path);
              }
          });
          
          return { ...empty_result, data: { files: filtered_files } };
      }

      if (!is_user_drive && !is_share_drive) {
          return empty_result;
      }
      
      const cacheKey = `search:${this.order}:${origin_keyword}:${page_token || ''}`;
      let search_result = await this._kv_get(cacheKey);
      if (search_result) {
          return search_result;
      }
      const sanitized_keyword = origin_keyword.replace(/'/g, "\\'");
      const name_search_str = `name contains '${sanitized_keyword}'`;
      let params = {};
      if (is_user_drive) params.corpora = "user";
      if (is_share_drive) {
          params.corpora = "drive";
          params.driveId = this.root.id;
          params.includeItemsFromAllDrives = true;
          params.supportsAllDrives = true;
      }
      if (page_token) params.pageToken = page_token;
      
      params.q = `trashed = false AND name !='.password' AND (${name_search_str})`;
      params.fields = "nextPageToken, files(id, name, mimeType, size , modifiedTime, thumbnailLink, description, shortcutDetails)";
      params.pageSize = this.authConfig.search_result_list_page_size;
      let url = "https://www.googleapis.com/drive/v3/files";
      url += "?" + this.enQuery(params);
      let requestOption = await this.requestOption();
      let response = await fetchWithTimeout(url, requestOption);
      let res_obj = await response.json();
      if (res_obj.files) {
          res_obj.files = this._processShortcuts(res_obj.files);
      }
      
      search_result = {
          nextPageToken: res_obj.nextPageToken || null,
          curPageIndex: page_index,
          data: res_obj,
      };
      
      await this._kv_put(cacheKey, search_result);
      return search_result;
  }
  async listAllFiles(folderId, basePath = '/') {
    const allFiles = [];
    const processedFolders = new Set();
    const queue = [{ id: folderId, path: basePath }];
    
    await this.parallelProcess(queue, async ({ id, path }) => {
        if (processedFolders.has(id)) return;
        processedFolders.add(id);

        try {
            let pageToken = null;
            do {
                const result = await this._ls(id, pageToken, 0);
                if (result && result.data && result.data.files) {
                    for (const item of result.data.files) {
                        const itemPath = (path + item.name).replace('//', '/');
                        const processedItem = this._processShortcut(item);
                        
                        if (processedItem.mimeType === CONSTS.folder_mime_type) {
                            allFiles.push({ ...processedItem, path: itemPath + '/' });
                            queue.push({ id: processedItem.id, path: itemPath + '/' });
                        } else {
                            allFiles.push({ ...processedItem, path: itemPath });
                        }
                    }
                }
                pageToken = result ? result.nextPageToken : null;
            } while (pageToken);
        } catch (e) {
            console.error(`Failed to list folder ${id}:`, e.message);
        }
    });

    return allFiles;
  }
  async parallelProcess(queue, processor) {
      const concurrency = this.authConfig.list_concurrency;
      let active_tasks = 0;
      let p = new Promise(resolve => {
          let check_queue = () => {
              if (active_tasks === 0 && queue.length === 0) return resolve();
              while (active_tasks < concurrency && queue.length > 0) {
                  active_tasks++;
                  let item = queue.shift();
                  processor(item).finally(() => {
                      active_tasks--;
                      check_queue();
                  });
              }
          };
          check_queue();
      });
      return p;
  }

  async findPathById(child_id) {
      if (this.cache.id_to_path.has(child_id)) {
          return this.cache.id_to_path.get(child_id);
      }
      
      const cacheKey = `path_by_id:${this.order}:${child_id}`;
      const cachedPath = await this._kv_get(cacheKey);
      if (cachedPath) {
          this.cache.id_to_path.set(child_id, cachedPath);
          this.cache.paths.set(cachedPath, child_id);
          return cachedPath;
      }
      
      const p_files = await this.findParentFilesRecursion(child_id);
      if (!p_files || p_files.length < 1) return "";

      const path_parts = p_files.map(it => it.name).reverse();
      let path = "/" + path_parts.join("/");
      const child_obj_raw = p_files[0];
      const child_obj_processed = this._processShortcut(child_obj_raw);

      if (child_obj_processed.mimeType === CONSTS.folder_mime_type && path !== "/") {
          path += "/";
      }
      
      this.cache.id_to_path.set(child_id, path);
      this.cache.paths.set(path, child_id);
      await this._kv_put(cacheKey, path);
      return path;
  }
  async findParentFilesRecursion(child_id, contain_myself = true) {
      const gd = this;
      const gd_root_id = gd.root.id;
      const user_drive_real_root_id = authConfig.user_drive_real_root_id;
      const is_user_drive = gd.root_type === CONSTS.gd_root_type.user_drive;
      const target_top_id = is_user_drive ? user_drive_real_root_id : gd_root_id;
      const parent_files = [];
      let meet_top = false;
      async function addItsFirstParent(file_obj) {
          if (!file_obj || !file_obj.id) return;
          if (file_obj.id === target_top_id) { meet_top = true; return; }
          if (!file_obj.parents || file_obj.parents.length < 1) { 
              if (is_user_drive) meet_top = true;
              return;
          }
          const first_p_id = file_obj.parents[0];
          if (first_p_id === target_top_id) { meet_top = true; return; }
          
          try {
              const p_file_obj = await gd.findItemById(first_p_id, true);
              if (p_file_obj && p_file_obj.id) {
                  parent_files.push(p_file_obj);
                  await addItsFirstParent(p_file_obj);
              }
          } catch (e) {
              console.error("Error finding parent:", e.message);
              meet_top = false;
          }
      }
      
      const child_obj = await gd.findItemById(child_id, true);
      if (contain_myself) parent_files.push(child_obj);
      await addItsFirstParent(child_obj);
      
      return meet_top ? parent_files : null;
  }
  async findItemById(id, raw = false) {
      if (this.cache.files_by_id.has(id)) {
        const file = this.cache.files_by_id.get(id);
        return raw ? file : this._processShortcut(file);
      }
      const is_user_drive = this.root_type === CONSTS.gd_root_type.user_drive;
      let url = `https://www.googleapis.com/drive/v3/files/${id}?fields=${CONSTS.default_file_fields}`;
      if (!is_user_drive || id !== 'root') {
          url += "&supportsAllDrives=true";
      }
      let requestOption = await this.requestOption();
      let res = await fetchWithTimeout(url, requestOption);
      const file = await res.json();
      if (file.error) {
          console.error(`API Error for ID ${id}:`, JSON.stringify(file.error));
          throw new Error(`API Error: ${file.error.message}`);
      }
      this.cache.files_by_id.set(id, file);
      return raw ? file : this._processShortcut(file);
  }
  async findPathId(path) {
      if (this.cache.paths.has(path)) return this.cache.paths.get(path);
      
      let c_path = "/";
      let c_id = this.root.id;
  
      let arr = path.trim("/").split("/");
      for (let name of arr) {
          if (!name) continue;
          c_path += name + "/";
          if (!this.cache.paths.has(c_path)) {
              let id = await this._findDirId(c_id, name);
              this.cache.paths.set(c_path, id);
          }
          c_id = this.cache.paths.get(c_path);
          if (c_id == undefined || c_id == null) {
              break;
          }
      }
      return this.cache.paths.get(path);
  }
  async _findDirId(parent, name) {
      name = decodeURIComponent(name).replace(/\'/g, "\\'");
      if (parent == undefined) return null;
      const cacheKey = `dirid:${this.order}:${parent}:${name}`;
      let id = await this._kv_get(cacheKey);
      if (id) return id;
      let url = "https://www.googleapis.com/drive/v3/files";
      let params = { includeItemsFromAllDrives: true, supportsAllDrives: true };
      params.q = `'${parent}' in parents and (mimeType = 'application/vnd.google-apps.folder' or mimeType = '${CONSTS.shortcut_mime_type}') and name = '${name}'  and trashed = false`;
      params.fields = "nextPageToken, files(id, name, mimeType, shortcutDetails)";
      url += "?" + this.enQuery(params);
      let requestOption = await this.requestOption();
      let response = await fetchWithTimeout(url, requestOption);
      let obj = await response.json();
      if (obj.files == undefined || obj.files.length === 0) {
          return null;
      }
      const file = this._processShortcut(obj.files[0]);
      id = file.id;
      await this._kv_put(cacheKey, id);
      return id;
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
      const headers = { "Content-Type": "application/x-www-form-urlencoded" };
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
      const response = await fetchWithTimeout(url, requestOption, 15000);
      return await response.json();
  }
  async fetch200(url, requestOption) {
    let response;
    const retryable_statuses = [403, 500, 502, 503, 504];
    for (let i = 0; i < 4; i++) {
        response = await fetchWithTimeout(url, requestOption);
        if (!retryable_statuses.includes(response.status)) {
            break;
        }
        if (i < 3) {
           await this.sleep(1000 * Math.pow(2, i)); 
        }
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
      return new Promise(resolve => setTimeout(resolve, ms));
  }
  async clearKvCache() {
    if (!this.kv_cache_available) {
        return { success: false, message: "KV Cache is not enabled." };
    }
    const prefixes = [
        `file:${this.order}:`,
        `list:${this.order}:`,
        `dirid:${this.order}:`,
        `path_by_id:${this.order}:`,
        `search:${this.order}:`,
        `all_files:${this.order}:`
    ];
    let deleted_count = 0;
    try {
        for (const prefix of prefixes) {
            let list_complete = false;
            let cursor = undefined;
            while (!list_complete) {
                const list = await GD_INDEX_CACHE.list({ prefix, cursor, limit: 1000 });
                if (list.keys.length > 0) {
                    await Promise.all(list.keys.map(key => GD_INDEX_CACHE.delete(key.name)));
                    deleted_count += list.keys.length;
                }
                list_complete = list.list_complete;
                cursor = list.cursor;
            }
        }
        return { success: true, message: `Successfully deleted ${deleted_count} KV entries for drive ${this.order}.` };
    } catch(e) {
        return { success: false, message: `An error occurred during cache clearing: ${e.message}` };
    }
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
