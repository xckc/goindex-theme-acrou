// =======配置项开始=======

var authConfig = {
    siteName: "xckk", // 网站名称
    version: "1.1.2", // 程序版本
    theme: "acrou",

    // [重要] 凭证已从代码中移除，将从Cloudflare环境变量安全加载
    // client_id, client_secret, refresh_token 将从环境变量加载。

    // --- KV 缓存优化配置 ---
    enable_kv_cache: true, // 设置为 true 来启用 KV 缓存功能。
    kv_cache_ttl: 3600, // 缓存有效时间（秒），例如 3600 秒 = 1 小时。 TTL 必须是大于等于 60 的整数。

    // [重要] 'roots' 配置现在建议从环境变量 'DRIVE_ROOTS' 加载，以提高安全性。
    roots: [],
    default_gd: 0,
    files_list_page_size: 200,
    search_result_list_page_size: 50,
    enable_cors_file_down: false,
};

// --- 从环境变量安全加载 `roots` 配置 ---
try {
    if (typeof DRIVE_ROOTS !== 'undefined' && DRIVE_ROOTS) {
        const parsedRoots = JSON.parse(DRIVE_ROOTS);
        // [优化] 配置验证
        authConfig.roots = parsedRoots.filter((root, index) => {
            if (root.id && root.name) {
                return true;
            }
            console.error(`DRIVE_ROOTS[${index}] is invalid. Missing 'id' or 'name'. It will be ignored.`);
            return false;
        });
    } else {
        console.warn("`DRIVE_ROOTS` environment variable is not set. The application will not have any drives to display.");
    }
} catch (e) {
    console.error("Failed to parse `DRIVE_ROOTS` environment variable. Please ensure it is a valid JSON array.", e);
    authConfig.roots = []; // 解析失败时使用空数组
}

var themeOptions = {
    cdn: "https://cdn.jsdelivr.net/gh/Aicirou/goindex-theme-acrou",
    version: "2.0.8",
    languages: "en",
    render: { head_md: false, readme_md: false, desc: false },
    video: { api: "", autoplay: true },
    audio: {},
};
// =======配置项结束=======


/**
 * 全局常量
 */
const CONSTS = new (class {
    default_file_fields = "parents,id,name,mimeType,modifiedTime,createdTime,fileExtension,size,shortcutDetails";
    gd_root_type = { user_drive: 0, share_drive: 1, sub_folder: 2 };
    folder_mime_type = "application/vnd.google-apps.folder";
    shortcut_mime_type = "application/vnd.google-apps.shortcut";
})();


// gd实例数组 (懒加载)
var gds = [];


/**
 * [优化] 集中式 Token 管理器
 * 避免多个 gd 实例重复刷新 Token
 */
const TokenManager = new (class {
    constructor() {
        this.accessToken = null;
        this.expires = 0;
        this.kv_cache_available = authConfig.enable_kv_cache && typeof GD_INDEX_CACHE !== 'undefined';
    }

    async _kv_get(key) {
        if (!this.kv_cache_available) return null;
        return await GD_INDEX_CACHE.get(key, 'json');
    }

    async _kv_put(key, value) {
        if (!this.kv_cache_available) return;
        return await GD_INDEX_CACHE.put(key, JSON.stringify(value), { expirationTtl: 3500 });
    }

    async fetchAccessToken() {
        const url = "https://www.googleapis.com/oauth2/v4/token";
        const headers = { "Content-Type": "application/x-www-form-urlencoded" };
        const post_data = {
            client_id: typeof CLIENT_ID !== 'undefined' ? CLIENT_ID : "",
            client_secret: typeof CLIENT_SECRET !== 'undefined' ? CLIENT_SECRET : "",
            refresh_token: typeof REFRESH_TOKEN !== 'undefined' ? REFRESH_TOKEN : "",
            grant_type: "refresh_token",
        };

        if (!post_data.client_id || !post_data.client_secret || !post_data.refresh_token) {
            throw new Error(`Credentials are not configured in environment variables (CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN)`);
        }

        const requestOption = { method: "POST", headers: headers, body: this.enQuery(post_data) };
        const response = await fetch(url, requestOption);
        const obj = await response.json();
        if (obj.error) {
           throw new Error(`Failed to fetch access token: ${obj.error_description}`);
        }
        return obj;
    }

    async getAccessToken() {
        if (this.expires > Date.now()) {
            return this.accessToken;
        }
        
        // 尝试从 KV 读取全局 Token
        const tokenInfo = await this._kv_get('access_token');
        if (tokenInfo && tokenInfo.expires > Date.now()) {
            this.accessToken = tokenInfo.accessToken;
            this.expires = tokenInfo.expires;
            return this.accessToken;
        }

        // 如果 KV 没有或已过期，则重新获取
        const obj = await this.fetchAccessToken();
        if (obj.access_token) {
            this.accessToken = obj.access_token;
            this.expires = Date.now() + 3500 * 1000;
            // 存入 KV
            await this._kv_put('access_token', { accessToken: this.accessToken, expires: this.expires });
        }
        return this.accessToken;
    }

    enQuery(data) {
        const ret = [];
        for (let d in data) {
            ret.push(encodeURIComponent(d) + "=" + encodeURIComponent(data[d]));
        }
        return ret.join("&");
    }
})();


function html(current_drive_order = 0, model = {}) {
    return `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"> 
<meta name="viewport" content="width=device-width, initial-scale=1.0,maximum-scale=1.0, user-scalable=no"/> 
<link rel="icon" type="image/png" sizes="32x32" href="https://i.imgur.com/rOyuGjA.gif">
<title>${authConfig.siteName}</title>
<style>@import url(${themeOptions.cdn}@${themeOptions.version}/dist/style.min.css);</style>
<script>
    window.gdconfig = JSON.parse('${JSON.stringify({ version: authConfig.version, themeOptions: themeOptions, })}');
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

// 主 fetch 事件监听器
addEventListener("fetch", (event) => {
    event.respondWith(routeRequest(event.request));
});


/**
 * [优化] 路由处理函数
 * @param {Request} request
 */
async function routeRequest(request) {
    let url = new URL(request.url);
    let path = decodeURI(url.pathname);

    if (path === "/") return redirectToIndexPage();
    if (path.toLowerCase() === "/favicon.ico") return new Response("", { status: 404 });

    // 从路径中解析盘符 (order)
    const pathSegments = path.split('/');
    if (pathSegments.length <= 1 || !pathSegments[1].includes(':')) {
        return redirectToIndexPage();
    }
    const order = parseInt(pathSegments[1].slice(0, -1));

    // 检查盘符合法性
    if (isNaN(order) || order < 0 || order >= authConfig.roots.length) {
        return redirectToIndexPage();
    }

    // 按需初始化 gd 实例 (懒加载)
    const gd = await getGd(order);
    if (!gd) {
        return new Response(`Drive ${order} is not available or failed to initialize.`, { status: 500 });
    }

    // 基础认证
    const basicAuthResponse = gd.basicAuthResponse(request);
    if (basicAuthResponse) {
        return basicAuthResponse;
    }
    
    // 命令处理
    const command_reg = /^\/(?<num>\d+):(?<command>[a-zA-Z0-9]+)(\/.*)?$/g;
    const match = command_reg.exec(path);
    if (match) {
        return handleCommandRequest(request, gd, match.groups.command, url);
    }
    
    // API 请求处理 (POST)
    if (request.method === "POST") {
        return handleApiRequest(request, gd, path);
    }
    
    // 文件和页面请求处理 (GET)
    return handleFileRequest(request, gd, path, url);
}


/**
 * 获取或初始化 gd 实例
 * @param {number} order 
 * @returns {Promise<googleDrive|null>}
 */
async function getGd(order) {
    if (!gds[order]) {
        try {
            const newGd = new googleDrive(authConfig, order);
            await newGd.init();
            if (newGd.root_type === -1) {
                console.error(`Root '${authConfig.roots[order].name}' (index: ${order}) is misconfigured or failed to initialize.`);
                return null;
            }
            gds[order] = newGd;
        } catch (e) {
            console.error(`Failed to initialize drive ${order}: ${e.message}`);
            return null;
        }
    }
    return gds[order];
}


/**
 * 处理命令类请求，如 /0:search, /0:id2path
 * @param {Request} request 
 * @param {googleDrive} gd 
 * @param {string} command 
 * @param {URL} url
 */
function handleCommandRequest(request, gd, command, url) {
    switch (command) {
        case "search":
            if (request.method === "POST") {
                return handleSearch(request, gd);
            } else {
                const params = url.searchParams;
                return new Response(html(gd.order, { q: params.get("q") || "", is_search_page: true }), {
                    status: 200,
                    headers: { "Content-Type": "text/html; charset=utf-8" },
                });
            }
        case "id2path":
            if (request.method === "POST") {
                return handleId2Path(request, gd);
            }
            break; // 只处理 POST
        case "view":
            const params = url.searchParams;
            return gd.view(params.get("url"), request.headers.get("Range"));
        default:
            // 对于非下载类GET命令，返回主页面
            if (command !== "down" && request.method === "GET") {
                return new Response(html(gd.order), {
                    status: 200,
                    headers: { "Content-Type": "text/html; charset=utf-8" },
                });
            }
    }
    // 如果没有匹配的命令处理器，则认为是一个文件路径
    let path = decodeURI(url.pathname);
    const reg = new RegExp(`^(/\\d+:)${command}/`, "g");
    path = path.replace(reg, (p1, p2) => p2 + "/");
    return handleFileRequest(request, gd, path, url);
}

/**
 * 处理文件和页面请求
 * @param {Request} request 
 * @param {googleDrive} gd 
 * @param {string} path 
 * @param {URL} url
 */
async function handleFileRequest(request, gd, path, url) {
    let requestPath = path.replace(gd.url_path_prefix, "") || "/";
    let action = url.searchParams.get("a");

    // 如果是目录或有 action 参数，返回 HTML 页面
    if (requestPath.endsWith("/") || action != null) {
        return new Response(html(gd.order), {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
        });
    }

    // 处理文件下载
    if (requestPath.split("/").pop().toLowerCase() === ".password") {
        return new Response("", { status: 404 });
    }

    let file = await gd.file(requestPath);
    if (!file) {
        return new Response("File not found.", { status: 404 });
    }

    let range = request.headers.get("Range");
    if (gd.root.protect_file_link && gd.basicAuthResponse(request)) {
         return gd.basicAuthResponse(request);
    }
    
    // 判断是否为直接下载（非 /0:down/ 形式）
    const is_down = !url.pathname.startsWith(`${gd.url_path_prefix}down/`);
    return gd.down(file.id, range, is_down);
}

/**
 * 处理前端API请求 (POST)
 * @param {Request} request 
 * @param {googleDrive} gd 
 * @param {string} path 
 */
async function handleApiRequest(request, gd, path) {
    let requestPath = path.replace(gd.url_path_prefix, "") || "/";
    let option = { status: 200, headers: { "Access-Control-Allow-Origin": "*" } };

    if (requestPath.endsWith("/")) {
        let body = await request.json();
        let list_result = await gd.list(requestPath, body.page_token, Number(body.page_index));
        return new Response(JSON.stringify(list_result), option);
    } else {
        let file = await gd.file(requestPath);
        return new Response(JSON.stringify(file), option);
    }
}


/**
 * 重定向到默认首页
 */
function redirectToIndexPage() {
    return new Response("", {
        status: 301,
        headers: { Location: `/${authConfig.default_gd}:/` },
    });
}


/**
 * 处理搜索请求
 * @param {Request} request 
 * @param {googleDrive} gd 
 */
async function handleSearch(request, gd) {
    const option = { status: 200, headers: { "Access-Control-Allow-Origin": "*" } };
    let body = await request.json();
    let search_result = await gd.search(body.q || "", body.page_token, Number(body.page_index));
    return new Response(JSON.stringify(search_result), option);
}

/**
 * 处理 ID 到路径的转换请求
 * @param {Request} request 
 * @param {googleDrive} gd 
 */
async function handleId2Path(request, gd) {
    const option = { status: 200, headers: { "Access-Control-Allow-Origin": "*" } };
    let body = await request.json();
    let path = await gd.findPathById(body.id);
    return new Response(path || "", option);
}

// ================================================
//         GoogleDrive 类定义
// ================================================
class googleDrive {
    constructor(authConfig, order) {
        this.order = order;
        this.root = authConfig.roots[order];
        this.root.protect_file_link = this.root.protect_file_link || false;
        this.url_path_prefix = `/${order}:`;
        this.authConfig = authConfig;

        // 瞬时缓存，在单次请求中有效
        this.paths = [];
        this.files = [];
        this.passwords = [];
        this.id_path_cache = {};
        this.id_path_cache[this.root["id"]] = "/";
        this.paths["/"] = this.root["id"];

        // KV 缓存是否可用
        this.kv_cache_available = this.authConfig.enable_kv_cache && typeof GD_INDEX_CACHE !== 'undefined';
    }

    // KV 缓存辅助函数
    async _kv_get(key) {
        if (!this.kv_cache_available) return null;
        return await GD_INDEX_CACHE.get(key, 'json');
    }

    async _kv_put(key, value) {
        if (!this.kv_cache_available) return;
        const ttl = Math.max(60, this.authConfig.kv_cache_ttl);
        return await GD_INDEX_CACHE.put(key, JSON.stringify(value), { expirationTtl: ttl });
    }

    /**
     * 初始化，获取根目录类型
     */
    async init() {
        this.root_type = -1; // 默认为无效
        let root_id = this.root["id"];
        if (!root_id) {
            console.error(`Root item '${this.root.name}' has no ID. Disabling.`);
            return;
        }

        // 确保 Token 可用
        await TokenManager.getAccessToken();

        // 获取 user_drive_real_root_id，仅第一个实例执行
        if (this.order === 0 && !authConfig.user_drive_real_root_id) {
             const root_obj = await this.findItemById("root");
             if (root_obj && root_obj.id) {
                 authConfig.user_drive_real_root_id = root_obj.id;
             }
        }
        
        let root_obj = await this.findItemById(root_id);

        if (root_obj && root_obj.mimeType === CONSTS.shortcut_mime_type) {
            if (root_obj.shortcutDetails && root_obj.shortcutDetails.targetId) {
                this.root.id = root_obj.shortcutDetails.targetId;
                if (root_obj.shortcutDetails.targetMimeType !== CONSTS.folder_mime_type) {
                    console.error(`Root item '${this.root.name}' is a shortcut but does not point to a folder. Disabling.`);
                    return;
                }
                root_id = this.root.id;
                root_obj = await this.findItemById(root_id); // 更新为快捷方式指向的目标对象
            } else {
                console.error(`Root item '${this.root.name}' is an invalid shortcut with no target. Disabling.`);
                return;
            }
        }

        const types = CONSTS.gd_root_type;
        if (root_id === "root" || root_id === authConfig.user_drive_real_root_id) {
            this.root_type = types.user_drive;
        } else {
            const drive_obj = await this.getShareDriveObjById(root_id);
            if (drive_obj) {
                this.root_type = types.share_drive;
            } else if (root_obj && root_obj.mimeType === CONSTS.folder_mime_type) {
                this.root_type = types.sub_folder;
            } else {
                console.error(`Root item '${this.root.name}' with ID '${root_id}' is not a valid folder, shared drive, or user drive.`);
            }
        }
    }
    
    _processShortcut(file) {
        if (file && file.mimeType === CONSTS.shortcut_mime_type && file.shortcutDetails && file.shortcutDetails.targetId) {
            return { ...file, id: file.shortcutDetails.targetId, mimeType: file.shortcutDetails.targetMimeType };
        }
        return file;
    }

    _processShortcuts(files) {
        if (!files || files.length === 0) return files;
        return files.map(file => this._processShortcut(file));
    }

    basicAuthResponse(request) {
        const user = this.root.user || "", pass = this.root.pass || "";
        const _401 = new Response("Unauthorized", { headers: { "WWW-Authenticate": `Basic realm="goindex:drive:${this.order}"` }, status: 401 });
        if (user || pass) {
            const auth = request.headers.get("Authorization");
            if (auth) {
                try {
                    const [received_user, received_pass] = atob(auth.split(" ").pop()).split(":");
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
        this.authConfig.enable_cors_file_down && headers.append("Access-Control-Allow-Origin", "*");
        inline === true && headers.set("Content-Disposition", "inline");
        return res;
    }

    async down(id, range = "", inline = false) {
        let url = `https://www.googleapis.com/drive/v3/files/${id}?alt=media`;
        let requestOption = await this.requestOption();
        requestOption.headers["Range"] = range;
        let res = await fetch(url, requestOption);
        const { headers } = (res = new Response(res.body, res));
        this.authConfig.enable_cors_file_down && headers.append("Access-Control-Allow-Origin", "*");
        inline === true && headers.set("Content-Disposition", "inline");
        return res;
    }

    async file(path) {
        if (typeof this.files[path] !== "undefined") return this.files[path];

        const cacheKey = `file:${this.order}:${path}`;
        let file = await this._kv_get(cacheKey);
        if (file) {
            this.files[path] = file;
            return file;
        }

        file = await this._file(path);
        if (file) {
            this.files[path] = file;
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
        let response = await fetch(url, requestOption);
        let obj = await response.json();
        if (!obj.files || obj.files.length === 0) return undefined;
        return this._processShortcut(obj.files[0]);
    }

    async list(path, page_token = null, page_index = 0) {
        const cacheKey = `list:${this.order}:${path}:${page_index}:${page_token || ''}`;
        let list_result = await this._kv_get(cacheKey);
        if (list_result) return list_result;

        let id = await this.findPathId(path);
        list_result = await this._ls(id, page_token, page_index);
        if (list_result && list_result.data) {
            await this._kv_put(cacheKey, list_result);
        }
        return list_result;
    }

    async _ls(parent, page_token = null, page_index = 0) {
        if (parent == undefined) return null;
        let params = { includeItemsFromAllDrives: true, supportsAllDrives: true };
        params.q = `'${parent}' in parents and trashed = false AND name !='.password'`;
        params.orderBy = "folder,name,modifiedTime desc";
        params.fields = "nextPageToken, files(id, name, mimeType, size , modifiedTime, thumbnailLink, description, shortcutDetails)";
        params.pageSize = this.authConfig.files_list_page_size;
        if (page_token) params.pageToken = page_token;

        let url = "https://www.googleapis.com/drive/v3/files?" + this.enQuery(params);
        let requestOption = await this.requestOption();
        let response = await fetch(url, requestOption);
        let obj = await response.json();
        if (obj.files) obj.files = this._processShortcuts(obj.files);

        return { nextPageToken: obj.nextPageToken || null, curPageIndex: page_index, data: obj };
    }
    
    async getShareDriveObjById(any_id) {
        if (!any_id || typeof any_id !== "string") return null;
        let url = `https://www.googleapis.com/drive/v3/drives/${any_id}`;
        let requestOption = await this.requestOption();
        let res = await fetch(url, requestOption);
        let obj = await res.json();
        return (obj && obj.id) ? obj : null;
    }

    async search(origin_keyword, page_token = null, page_index = 0) {
        const empty_result = { nextPageToken: null, curPageIndex: page_index, data: { files: [] } };
        if (!origin_keyword) return empty_result;

        const sanitized_keyword = origin_keyword.replace(/'/g, "\\'");
        const name_search_str = `name contains '${sanitized_keyword}'`;
        let params = {};

        if (this.root_type === CONSTS.gd_root_type.user_drive) {
            params.q = `trashed = false AND name !='.password' AND (${name_search_str})`;
        } else if (this.root_type === CONSTS.gd_root_type.share_drive) {
            params.corpora = "drive";
            params.driveId = this.root.id;
            params.includeItemsFromAllDrives = true;
            params.supportsAllDrives = true;
            params.q = `trashed = false AND name !='.password' AND (${name_search_str})`;
        } else { // sub_folder
            params.q = `'${this.root.id}' in parents AND trashed = false AND name !='.password' AND (${name_search_str})`;
            params.supportsAllDrives = true;
            params.includeItemsFromAllDrives = true;
        }

        if (page_token) params.pageToken = page_token;
        params.fields = "nextPageToken, files(id, name, mimeType, size , modifiedTime, thumbnailLink, description, shortcutDetails)";
        params.pageSize = this.authConfig.search_result_list_page_size;
        let url = "https://www.googleapis.com/drive/v3/files?" + this.enQuery(params);
        let requestOption = await this.requestOption();
        let response = await fetch(url, requestOption);
        let res_obj = await response.json();
        if (res_obj.files) res_obj.files = this._processShortcuts(res_obj.files);
        return { nextPageToken: res_obj.nextPageToken || null, curPageIndex: page_index, data: res_obj };
    }

    async findPathById(child_id, force_reload = false) {
        const cacheKey = `path_by_id:${this.order}:${child_id}`;
        if (!force_reload) {
            if (this.id_path_cache[child_id]) return this.id_path_cache[child_id];
            const cachedPath = await this._kv_get(cacheKey);
            if (cachedPath) {
                this.id_path_cache[child_id] = cachedPath;
                this.paths[cachedPath] = child_id;
                return cachedPath;
            }
        }

        const p_files = await this.findParentFilesRecursion(child_id, true);
        if (!p_files || p_files.length < 1) return "";
        const path_parts = p_files.map(it => it.name).reverse();
        let path = "/" + path_parts.join("/");
        const child_obj_raw = p_files[0];
        const child_obj_processed = this._processShortcut(child_obj_raw);

        if (child_obj_processed.mimeType === CONSTS.folder_mime_type && path !== "/") {
            path += "/";
        }

        this.id_path_cache[child_id] = path;
        this.paths[path] = child_id;
        await this._kv_put(cacheKey, path);
        return path;
    }

    async findParentFilesRecursion(child_id, contain_myself = true) {
        const gd_root_id = this.root.id;
        const user_drive_real_root_id = authConfig.user_drive_real_root_id;
        const is_user_drive = this.root_type === CONSTS.gd_root_type.user_drive;
        const target_top_id = is_user_drive ? user_drive_real_root_id : gd_root_id;

        const parent_files = [];
        let meet_top = false;

        const addItsFirstParent = async (file_obj) => {
            if (!file_obj || !file_obj.id || file_obj.id === target_top_id) { meet_top = true; return; }
            if (!file_obj.parents || file_obj.parents.length < 1) {
                if (is_user_drive) meet_top = true;
                return;
            }
            const first_p_id = file_obj.parents[0];
            if (first_p_id === target_top_id) { meet_top = true; return; }
            try {
                const p_file_obj = await this.findItemById(first_p_id, true);
                if (p_file_obj && p_file_obj.id) {
                    parent_files.push(p_file_obj);
                    await addItsFirstParent(p_file_obj);
                }
            } catch (e) {
                console.error("Error finding parent:", e.message);
                meet_top = false;
            }
        }

        const child_obj = await this.findItemById(child_id, true);
        if (contain_myself) parent_files.push(child_obj);
        await addItsFirstParent(child_obj);
        return meet_top ? parent_files : null;
    }

    async findItemById(id, raw = false) {
        const cacheKey = `item:${this.order}:${id}`;
        let file = await this._kv_get(cacheKey);
        if (file) {
            return raw ? file : this._processShortcut(file);
        }

        const is_user_drive = this.root_type === CONSTS.gd_root_type.user_drive;
        let url = `https://www.googleapis.com/drive/v3/files/${id}?fields=${CONSTS.default_file_fields}`;
        if (!is_user_drive || id !== 'root') url += "&supportsAllDrives=true";

        let requestOption = await this.requestOption();
        let res = await fetch(url, requestOption);
        file = await res.json();
        if (file.error) {
            console.error(`API Error for ID ${id}:`, JSON.stringify(file.error));
            throw new Error(`API Error: ${file.error.message}`);
        }
        
        await this._kv_put(cacheKey, file);
        return raw ? file : this._processShortcut(file);
    }

    async findPathId(path) {
        if (this.paths[path]) return this.paths[path];
        let c_path = "/";
        let c_id = this.root.id;
        this.paths[c_path] = c_id;
        let arr = path.trim("/").split("/");
        for (let name of arr) {
            if (!name) continue;
            c_path += name + "/";
            if (typeof this.paths[c_path] == "undefined") {
                this.paths[c_path] = await this._findDirId(c_id, name);
            }
            c_id = this.paths[c_path];
            if (c_id == undefined || c_id == null) break;
        }
        return this.paths[path];
    }

    async _findDirId(parent, name) {
        name = decodeURIComponent(name).replace(/\'/g, "\\'");
        if (parent == undefined) return null;

        const cacheKey = `dirid:${this.order}:${parent}:${name}`;
        let id = await this._kv_get(cacheKey);
        if (id) return id;

        let url = "https://www.googleapis.com/drive/v3/files";
        let params = { includeItemsFromAllDrives: true, supportsAllDrives: true };
        params.q = `'${parent}' in parents and (mimeType = 'application/vnd.google-apps.folder' or mimeType = '${CONSTS.shortcut_mime_type}') and name = '${name}'  and trashed = false`;
        params.fields = "nextPageToken, files(id, name, mimeType, shortcutDetails)";
        url += "?" + this.enQuery(params);
        let requestOption = await this.requestOption();
        let response = await fetch(url, requestOption);
        let obj = await response.json();
        if (obj.files == undefined || obj.files.length === 0) return null;
        
        const file = this._processShortcut(obj.files[0]);
        id = file.id;
        await this._kv_put(cacheKey, id);
        return id;
    }
    
    async requestOption(headers = {}, method = "GET") {
        const accessToken = await TokenManager.getAccessToken();
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
}

String.prototype.trim = function(char) {
    if (char) return this.replace(new RegExp("^\\" + char + "+|\\" + char + "+$", "g"), "");
    return this.replace(/^\s+|\s+$/g, "");
};
