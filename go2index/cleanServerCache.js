// =======配置项开始=======
var authConfig = {
    siteName: "xckk", // 网站名称
    version: "1.1.2", // 程序版本，修改为“1.1.2”以匹配主题的检查，从而禁用更新提示
    theme: "acrou",
    // [重要] 凭证已从代码中移除，将从Cloudflare环境变量安全加载
    // [IMPORTANT] Credentials have been removed from the code and will be securely loaded from Cloudflare's environment variables.
    // client_id, client_secret, refresh_token are loaded from environment variables.
    // --- 新增：KV 缓存优化配置 ---
    enable_kv_cache: true, // 设置为 true 来启用 KV 缓存功能。
    kv_cache_ttl: 259200,    // 缓存有效时间（秒），例如 3600 秒 = 1 小时。 TTL 必须是大于等于 60 的整数。
    // [新增] 管理功能配置
    require_admin_password_for_clear: true, // true: 清理缓存需要密码。false: 不需要密码。
    // [重要] 'roots' 配置现在建议从环境变量 'DRIVE_ROOTS' 加载，以提高安全性。
    // [IMPORTANT] The 'roots' config is now recommended to be loaded from the 'DRIVE_ROOTS' environment variable for better security.
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

/**
 * 全局常量
 */
const CONSTS = new(class {
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

addEventListener("fetch", (event) => {
    event.respondWith(handleRequest(event.request));
});

/**
 * 主请求处理函数
 */
async function handleRequest(request) {
    let url = new URL(request.url);
    let path = decodeURI(url.pathname);

    // 更新：处理 /admin, /admin/, /0:/admin 等路径
    const adminRegex = /^(\/\d+:)?\/admin(\/.*)?$/;
    if (adminRegex.test(path)) {
        return handleAdminRouter(request);
    }

    let gd;

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
    //  懒加载优化: 按需初始化 googleDrive 实例
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

    // 后续逻辑保持不变
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
                return new Response(
                    html(gd.order, {
                        q: params.get("q") || "",
                        is_search_page: true,
                        root_type: 1, // 强制设置为 1（团队盘），以确保前端显示搜索框
                    }), {
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
            return new Response(html(gd.order, { root_type: 1 }), { // 强制设置为 1
                status: 200,
                headers: { "Content-Type": "text/html; charset=utf-8" },
            });
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
        return (
            basic_auth_res ||
            new Response(html(gd.order, { root_type: 1 }), { // 强制设置为 1
                status: 200,
                headers: { "Content-Type": "text/html; charset=utf-8" },
            })
        );
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

// ============== 更新：管理功能相关函数 ==============

/**
 * 处理所有 /admin/ 路径的请求
 * @param {Request} request
 */
async function handleAdminRouter(request) {
    const adminPass = typeof ADMIN_PASS !== 'undefined' ? ADMIN_PASS : null;

    // 检查管理功能是否已启用。如果配置要求密码但未在环境变量中设置，则禁用。
    if (authConfig.require_admin_password_for_clear && !adminPass) {
        return new Response("Admin functionality is disabled: ADMIN_PASS is not set in environment variables, but is required by configuration.", {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
    }

    // 处理POST请求（清理缓存）
    if (request.method === 'POST') {
        const formData = await request.formData();
        const password = formData.get('password');
        const driveIndex = formData.get('driveIndex');

        // 仅在配置要求时才验证密码
        if (authConfig.require_admin_password_for_clear && (password !== adminPass)) {
            const errorHtml = getAdminDashboardPage('密码错误，请重试。', true);
            return new Response(errorHtml, { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }

        if (driveIndex === null) {
            const errorHtml = getAdminDashboardPage('错误：未选择要清理的云盘。', true);
            return new Response(errorHtml, { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }

        const result = await clearKVCache(driveIndex);
        const message = `${result.message}<br><br>3秒后页面将刷新。 <script>setTimeout(() => window.location.reload(), 3000);</script>`;
        const resultHtml = getAdminDashboardPage(message, !result.success);

        return new Response(resultHtml, {
            status: result.success ? 200 : 500,
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
    }

    // 处理GET请求（显示仪表板）
    if (request.method === 'GET') {
        return new Response(getAdminDashboardPage(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // 其他方法的备用响应
    return new Response("Method Not Allowed", { status: 405 });
}


/**
 * 生成缓存管理仪表板
 * @param {string|null} message 要显示的消息
 * @param {boolean} isError 消息是否为错误消息
 */
function getAdminDashboardPage(message = null, isError = false) {
    let driveButtons = authConfig.roots.map((root, index) => {
        return `<button type="submit" name="driveIndex" value="${index}" class="btn-drive">清理云盘 ${index} (${root.name}) 的缓存</button>`;
    }).join('');

    const messageHtml = message ? `<div class="message ${isError ? 'error' : 'success'}">${message}</div>` : '';

    // 根据配置决定是否渲染密码字段
    const passwordFieldHtml = authConfig.require_admin_password_for_clear ?
        `<label for="password">管理员密码:</label>
         <input type="password" id="password" name="password" required>` :
        '';

    return `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>缓存管理</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 1rem; background-color: #f0f2f5; color: #333; box-sizing: border-box;}
            .container { background: #fff; padding: 2rem 2.5rem; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); width: 100%; max-width: 600px; }
            h1 { text-align: center; color: #1a1a1a; margin-bottom: 1rem; }
            p { text-align: center; color: #666; margin-bottom: 2rem; }
            form { width: 100%; }
            label { font-weight: 600; margin-bottom: 0.5rem; display: block; }
            input[type="password"] { width: 100%; box-sizing: border-box; padding: 0.75rem; border: 1px solid #ccc; border-radius: 4px; font-size: 1rem; margin-bottom: 1.5rem; }
            .button-group { display: flex; flex-direction: column; gap: 0.75rem; }
            button { padding: 0.8rem 1rem; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer; transition: background-color 0.2s; text-align: left; width: 100%; box-sizing: border-box; }
            .btn-drive { background-color: #e7f3ff; color: #007bff; border: 1px solid #007bff; }
            .btn-drive:hover { background-color: #d0e7ff; }
            .btn-all { background-color: #fdeaea; color: #d93025; border: 1px solid #d93025; margin-top: 1.5rem; text-align: center; font-weight: bold; }
            .btn-all:hover { background-color: #fbd7d4; }
            .message { padding: 1rem; margin-bottom: 1.5rem; border-radius: 4px; text-align: center; word-break: break-word; }
            .message.success { background-color: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
            .message.error { background-color: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>缓存管理仪表板</h1>
            ${messageHtml}
            <p>选择一个操作来清理相应的缓存。</p>
            <form method="post" action="">
                ${passwordFieldHtml}
                <div class="button-group">
                    ${driveButtons}
                </div>
                <button type="submit" name="driveIndex" value="all" class="btn-all">清理所有云盘的缓存</button>
            </form>
        </div>
    </body>
    </html>`;
}

/**
 * 根据前缀批量删除KV中的键
 * @param {string} prefix
 */
async function deleteKeysWithPrefix(prefix) {
    if (typeof GD_INDEX_CACHE === 'undefined') {
        return 0;
    }
    let keys_deleted = 0;
    let cursor = undefined;
    while (true) {
        const list = await GD_INDEX_CACHE.list({ prefix: prefix, cursor: cursor, limit: 1000 });
        const keyNames = list.keys.map(key => key.name);
        if (keyNames.length === 0) {
            break;
        }
        await Promise.all(keyNames.map(keyName => GD_INDEX_CACHE.delete(keyName)));
        keys_deleted += keyNames.length;
        if (list.list_complete) {
            break;
        }
        cursor = list.cursor;
    }
    return keys_deleted;
}


/**
 * 清理绑定的KV命名空间中的键
 * @param {string} driveIndex 要清理的云盘索引，或者 'all'
 */
async function clearKVCache(driveIndex = 'all') {
    if (typeof GD_INDEX_CACHE === 'undefined') {
        return { success: false, message: "KV 命名空间 'GD_INDEX_CACHE' 未绑定。" };
    }
    try {
        let total_keys_deleted = 0;

        if (driveIndex === 'all') {
            total_keys_deleted = await deleteKeysWithPrefix(''); // 空前缀匹配所有
            return { success: true, message: `成功从KV缓存中删除了所有 ${total_keys_deleted} 个键。` };
        } else {
            const index = parseInt(driveIndex, 10);
            if (isNaN(index)) {
                return { success: false, message: "无效的云盘索引。" };
            }
            // 定义与云盘相关的所有键类型前缀
            const keyTypes = ['file', 'list', 'all_files', 'search', 'path_by_id', 'dirid'];
            for (const type of keyTypes) {
                const fullPrefix = `${type}:${index}:`;
                total_keys_deleted += await deleteKeysWithPrefix(fullPrefix);
            }
            const driveName = authConfig.roots[index] ? authConfig.roots[index].name : 'Unknown';
            return { success: true, message: `成功为云盘 ${index} (${driveName}) 删除了 ${total_keys_deleted} 个缓存键。` };
        }
    } catch (e) {
        console.error("KV Cache Clearing Error:", e);
        return { success: false, message: `清理KV缓存失败: ${e.message}` };
    }
}


// ========================================================

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

class googleDrive {
    constructor(authConfig, order) {
        this.order = order;
        this.root = authConfig.roots[order];
        this.root.protect_file_link = this.root.protect_file_link || false;
        this.url_path_prefix = `/${order}:`;
        // 从环境变量安全加载凭证
        this.authConfig = { ...authConfig }; // 复制基础配置
        this.authConfig.client_id = typeof CLIENT_ID !== 'undefined' ? CLIENT_ID : "";
        this.authConfig.client_secret = typeof CLIENT_SECRET !== 'undefined' ? CLIENT_SECRET : "";
        this.authConfig.refresh_token = typeof REFRESH_TOKEN !== 'undefined' ? REFRESH_TOKEN : "";
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
     * 初始授权
     */
    async init() {
        if (!this.authConfig.client_id || !this.authConfig.client_secret || !this.authConfig.refresh_token) {
            throw new Error(`Credentials are not configured in environment variables (CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN)`);
        }
        await this.accessToken();
        if (authConfig.user_drive_real_root_id) return;

        // 只有第一个 drive 会尝试获取 user_drive_real_root_id
        if (this.order === 0) {
            const root_obj = await this.findItemById("root");
            if (root_obj && root_obj.id) {
                authConfig.user_drive_real_root_id = root_obj.id;
            }
        }
    }

    /**
     * 获取根目录类型
     */
    async initRootType() {
        this.root_type = -1; // 默认为无效
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
        // 等待 user_drive_real_root_id 被初始化
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
        if (typeof this.files[path] !== "undefined") {
            return this.files[path];
        }
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
        let response = await fetch(url, requestOption);
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
     * 搜索 (恢复第二个代码中的优化逻辑)
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
            return empty_result;
        }

        // **优化点**: 缓存 `sub_folder` 的完整文件列表
        if (is_sub_folder) {
            let all_files;
            const cacheKey = `all_files:${this.order}:${this.root.id}`;

            // 1. 尝试从缓存读取
            all_files = await this._kv_get(cacheKey);
            // 2. 如果缓存中没有，则从 API 获取并写入缓存
            if (!all_files) {
                all_files = await this.listAllFiles(this.root.id);
                await this._kv_put(cacheKey, all_files);
            }
            const filtered_files = all_files.filter(file => file.name.toLowerCase().includes(origin_keyword.toLowerCase()));

            filtered_files.forEach(file => {
                if (file.id && file.path) {
                    this.id_path_cache[file.id] = file.path;
                    // ========= FIX 1: UNIFY CACHE KEY =========
                    // 使用与 findPathById 一致的缓存键和格式
                    const pathByIdCacheKey = `path_by_id:${this.order}:${file.id}`;
                    this._kv_put(pathByIdCacheKey, file.path);
                    // ========= END FIX 1 =========
                }
            });

            return { ...empty_result, data: { files: filtered_files } };
        }

        if (!is_user_drive && !is_share_drive) {
            return empty_result;
        }

        // 对于 API 搜索，同样可以缓存结果
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
        let response = await fetch(url, requestOption);
        let res_obj = await response.json();

        if (res_obj.files) {
            res_obj.files = this._processShortcuts(res_obj.files);

            // ========= FIX 2: PRE-FETCH PATHS FOR SEARCH RESULTS =========
            // 主动解析并缓存所有搜索结果的路径
            // 这会使搜索本身变慢，但能确保链接在第一次点击时就有效
            if (res_obj.files.length > 0) {
                const pathResolutions = res_obj.files.map(file => this.findPathById(file.id));
                await Promise.all(pathResolutions);
            }
            // ========= END FIX 2 =========
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
        const foldersToProcess = [{ id: folderId, path: basePath }];
        const processedFolders = new Set();
        while (foldersToProcess.length > 0) {
            const { id: currentFolderId, path: currentPath } = foldersToProcess.shift();
            if (processedFolders.has(currentFolderId)) continue;
            processedFolders.add(currentFolderId);
            try {
                let pageToken = null;
                do {
                    const result = await this._ls(currentFolderId, pageToken, 0);
                    if (result && result.data && result.data.files) {
                        for (const item of result.data.files) {
                            const itemPath = (currentPath + item.name).replace('//', '/');
                            if (item.mimeType === CONSTS.folder_mime_type) {
                                allFiles.push({ ...item, path: itemPath + '/' });
                                foldersToProcess.push({ id: item.id, path: itemPath + '/' });
                            } else {
                                allFiles.push({ ...item, path: itemPath });
                            }
                        }
                    }
                    pageToken = result ? result.nextPageToken : null;
                } while (pageToken);
            } catch (e) {
                console.error(`Failed to list folder ${currentFolderId}:`, e.message);
            }
        }
        return allFiles;
    }

    // =========================================================
    //  增强 KV 缓存: 缓存 ID 到路径的解析结果
    // =========================================================
    async findPathById(child_id, force_reload = false) {
        const cacheKey = `path_by_id:${this.order}:${child_id}`;

        // 1. 检查内存缓存
        if (!force_reload && this.id_path_cache[child_id]) {
            return this.id_path_cache[child_id];
        }

        // 2. 检查 KV 缓存
        if (!force_reload) {
            const cachedPath = await this._kv_get(cacheKey);
            if (cachedPath) {
                this.id_path_cache[child_id] = cachedPath; // 同步到内存缓存
                this.paths[cachedPath] = child_id;
                return cachedPath;
            }
        }
        // 3. 如果缓存未命中，执行原始逻辑
        const p_files = await this.findParentFilesRecursion(child_id, true, force_reload);
        if (!p_files || p_files.length < 1) return "";
        const path_parts = p_files.map(it => it.name).reverse();
        let path = "/" + path_parts.join("/");
        const child_obj_raw = p_files[0];
        const child_obj_processed = this._processShortcut(child_obj_raw);
        if (child_obj_processed.mimeType === CONSTS.folder_mime_type && path !== "/") {
            path += "/";
        }
        // 4. 存入缓存
        this.id_path_cache[child_id] = path;
        this.paths[path] = child_id;
        await this._kv_put(cacheKey, path); // 存入 KV
        return path;
    }

    async findParentFilesRecursion(child_id, contain_myself = true, force_reload = false) {
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
        // 对于 User Drive 的根目录 "root"，特殊处理
        const is_user_drive = this.root_type === CONSTS.gd_root_type.user_drive;
        let url = `https://www.googleapis.com/drive/v3/files/${id}?fields=${CONSTS.default_file_fields}`;
        if (!is_user_drive || id !== 'root') {
            url += "&supportsAllDrives=true";
        }
        let requestOption = await this.requestOption();
        let res = await fetch(url, requestOption);
        const file = await res.json();
        if (file.error) {
            console.error(`API Error for ID ${id}:`, JSON.stringify(file.error));
            throw new Error(`API Error: ${file.error.message}`);
        }
        return raw ? file : this._processShortcut(file);
    }

    async findPathId(path) {
        if (this.paths[path]) return this.paths[path];
        let c_path = "/";
        let c_id = this.root.id; // Start from the root id.
        this.paths[c_path] = c_id;

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
            if (response.status != 403) break;
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
            setTimeout(resolve, ms);
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
