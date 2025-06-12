// Optimized GoIndex Cloudflare Worker Script
// Version: 2.1.0
// Key Optimizations:
// 1. Security: Credentials and Roots config are loaded from encrypted environment variables.
// 2. Performance: Drive initialization runs only once when the worker instance starts.
// 3. Robustness: Improved error handling and logic for root item types (especially shortcuts).
// 4. Caching: Enhanced KV caching for search, file lists, and path resolution.

// =======配置项开始 (Configuration Start)=======
const authConfig = {
    siteName: "xckk",     // 网站名称 (Site Name)
    version: "1.1.2",      // 程序版本，以禁用更新提示 (Program version to disable update checks)
    theme: "acrou",

    // [重要] 凭证已移至Cloudflare环境变量，此处不再配置
    // [IMPORTANT] Credentials have been moved to Cloudflare Environment Variables. Do not configure here.
    // client_id, client_secret, refresh_token are loaded from environment variables.

    // --- KV 缓存优化配置 (KV Cache Optimization) ---
    enable_kv_cache: true,      // 设置为 true 来启用 KV 缓存功能 (Set true to enable KV cache)
    kv_cache_ttl: 3600,         // 缓存有效时间（秒），例如 3600秒 = 1小时 (Cache TTL in seconds, must be >= 60)

    // [重要] 'roots' 配置现在建议从环境变量 'DRIVE_ROOTS' 加载，以提高安全性。
    // [IMPORTANT] The 'roots' config is now recommended to be loaded from the 'DRIVE_ROOTS' environment variable for better security.
    default_gd: 0,
    files_list_page_size: 200,          // 文件列表页面, 每页显示数量 (Files per page in list view)
    search_result_list_page_size: 50, // 搜索结果页面, 每页显示数量 (Files per page in search view)
    enable_cors_file_down: false,     // 确定可以开启 cors 时, 启用此功能 (Enable CORS for file downloads)
    enable_password_file_verify: false, // 启用 .password 文件密码验证 (Enable .password file verification)
};

// --- 从环境变量安全加载 `roots` 配置 (Securely load `roots` config from environment variable) ---
try {
    // 检查 DRIVE_ROOTS 环境变量是否已设置
    // Check if the DRIVE_ROOTS environment variable is set.
    if (typeof DRIVE_ROOTS !== 'undefined' && DRIVE_ROOTS) {
        authConfig.roots = JSON.parse(DRIVE_ROOTS);
    } else {
        // 如果环境变量未设置，则回退到代码中的默认配置或空数组，防止Worker崩溃
        // Fallback to a default configuration or an empty array if the variable is not set.
        console.warn("`DRIVE_ROOTS` environment variable is not set. Using fallback config. Please set it for better security.");
        authConfig.roots = [{
            id: "", // 示例: 团队盘ID (Example: Team Drive ID)
            name: "TeamDrive",
            pass: "",
        }, {
            id: "root",
            name: "PrivateDrive",
            user: "",
            pass: "",
            protect_file_link: true,
        }, {
            id: "", // 示例: 某个文件夹的ID (Example: A folder ID)
            name: "folder1",
            pass: "",
        }, ];
    }
} catch (e) {
    console.error("Failed to parse `DRIVE_ROOTS` environment variable. Please ensure it is a valid JSON array.", e);
    authConfig.roots = []; // 解析失败时使用空数组
}


const themeOptions = {
    cdn: "https://cdn.jsdelivr.net/gh/Aicirou/goindex-theme-acrou",
    version: "2.0.8",      // 主题版本号 (Theme version)
    languages: "en",       // 可选的默认系统语言 (Default language: en/zh-chs/zh-cht)
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
// =======配置项结束 (Configuration End)=======

/**
 * 全局常量 (Global Constants)
 */
const CONSTS = {
    default_file_fields: "parents,id,name,mimeType,modifiedTime,createdTime,fileExtension,size,shortcutDetails",
    gd_root_type: {
        user_drive: 0,
        share_drive: 1,
        sub_folder: 2,
    },
    folder_mime_type: "application/vnd.google-apps.folder",
    shortcut_mime_type: "application/vnd.google-apps.shortcut",
};

// gd实例数组 (Array of Google Drive instances)
const gds = [];

/**
 * 在Worker启动时执行一次的初始化函数
 * Self-invoking async function to initialize drives on worker startup.
 */
(async () => {
    console.log("Worker instance starting, initializing drives...");
    for (let i = 0; i < authConfig.roots.length; i++) {
        const gd = new googleDrive(authConfig, i);
        // This will also load credentials from environment variables
        await gd.init(); // 确保 token 已获取 (Ensure token is fetched)
        gds.push(gd);
    }
    const initTasks = gds.map(gd => gd.initRootType());
    await Promise.all(initTasks);
    console.log("All drives initialized successfully.");
})();


addEventListener("fetch", (event) => {
    event.respondWith(handleRequest(event.request));
});

/**
 * 主请求处理函数 (Main request handler)
 * @param {Request} request
 */
async function handleRequest(request) {
    let gd;
    const url = new URL(request.url);
    let path = decodeURI(url.pathname);

    const redirectToIndexPage = () => new Response(null, {
        status: 301,
        headers: {
            Location: `/${authConfig.default_gd}:/`
        },
    });

    if (path === "/") return redirectToIndexPage();
    if (path.toLowerCase() === "/favicon.ico") {
        return new Response(null, { status: 404 });
    }

    const command_reg = /^\/(?<num>\d+):(?<command>[a-zA-Z0-9]+)(\/.*)?$/;
    const match = command_reg.exec(path);
    let command;

    if (match) {
        const order = Number(match.groups.num);
        if (order >= 0 && order < gds.length) {
            gd = gds[order];
            if (gd.root_type === -1) {
                return new Response(`Root '${gd.root.name}' (index: ${order}) is misconfigured or invalid.`, { status: 500 });
            }
        } else {
            return redirectToIndexPage();
        }

        const authResponse = gd.basicAuthResponse(request);
        if (authResponse) return authResponse;

        command = match.groups.command;

        if (command === "search") {
            return handleSearchCommand(request, gd, url);
        }
        if (command === "id2path" && request.method === "POST") {
            return handleId2Path(request, gd);
        }
        if (command === "view") {
            const params = url.searchParams;
            return gd.view(params.get("url"), request.headers.get("Range"));
        }
        if (command !== "down" && request.method === "GET") {
             return new Response(html(gd.order, { root_type: 0 }), {
                status: 200,
                headers: { 'Content-Type': 'text/html; charset=utf-8' },
            });
        }
    }

    const common_reg = /^\/(\d+):(.*)$/;
    const common_match = common_reg.exec(path);

    if (!common_match) {
        return redirectToIndexPage();
    }
    
    const order = Number(common_match[1]);
    if (order >= 0 && order < gds.length) {
        gd = gds[order];
        if (gd.root_type === -1) {
            return new Response(`Root '${gd.root.name}' (index: ${order}) is misconfigured or invalid.`, { status: 500 });
        }
    } else {
        return redirectToIndexPage();
    }
    
    const authResponse = gd.basicAuthResponse(request);
    let targetPath = "/" + common_match[2];

    if (request.method === "POST") {
        return authResponse || apiRequest(request, gd, targetPath);
    }

    const action = url.searchParams.get("a");

    if (targetPath.endsWith("/") || action != null) {
        return authResponse || new Response(html(gd.order, { root_type: 0 }), {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
    } else {
        if (targetPath.split("/").pop().toLowerCase() === ".password") {
            return authResponse || new Response(null, { status: 404 });
        }
        const file = await gd.file(targetPath);
        if (!file) {
            return new Response("File not found.", { status: 404 });
        }
        if (gd.root.protect_file_link && authResponse) return authResponse;
        
        // Command "down" might not be present, so check if download is intended.
        const isDownload = url.searchParams.has("d");
        return gd.down(file.id, request.headers.get("Range"), !isDownload);
    }
}

/**
 * Handles the 'search' command.
 * @param {Request} request
 * @param {googleDrive} gd
 * @param {URL} url
 */
function handleSearchCommand(request, gd, url) {
    if (request.method === "POST") {
        return handleSearch(request, gd);
    }
    const params = url.searchParams;
    return new Response(
        html(gd.order, {
            q: params.get("q") || "",
            is_search_page: true,
            root_type: 0,
        }), {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
        }
    );
}


/**
 * Handles API requests for file lists etc.
 * @param {Request} request
 * @param {googleDrive} gd
 * @param {string} path
 */
async function apiRequest(request, gd, path) {
    const option = { status: 200, headers: { "Access-Control-Allow-Origin": "*" } };

    if (path.endsWith("/")) {
        if (authConfig.enable_password_file_verify) {
            let body = await request.clone().json();
            const password = await gd.password(path);
            if (password && password.trim() !== body.password) {
                return new Response(JSON.stringify({
                    error: { code: 401, message: "Password error." }
                }), option);
            }
        }
        const body = await request.json();
        const list_result = await gd.list(
            path,
            body.page_token,
            Number(body.page_index) || 0
        );
        return new Response(JSON.stringify(list_result), option);
    } else {
        const file = await gd.file(path);
        return new Response(JSON.stringify(file), { ...option, status: file ? 200 : 404 });
    }
}

/**
 * Handles search API requests.
 * @param {Request} request
 * @param {googleDrive} gd
 */
async function handleSearch(request, gd) {
    const option = {
        status: 200,
        headers: { "Access-Control-Allow-Origin": "*" },
    };
    const body = await request.json();
    const search_result = await gd.search(
        body.q || "",
        body.page_token,
        Number(body.page_index) || 0
    );
    return new Response(JSON.stringify(search_result), option);
}

/**
 * Handles ID to Path conversion API requests.
 * @param {Request} request
 * @param {googleDrive} gd
 */
async function handleId2Path(request, gd) {
    const option = {
        status: 200,
        headers: { "Access-Control-Allow-Origin": "*" },
    };
    const body = await request.json();
    const path = await gd.findPathById(body.id);
    return new Response(path || "", option);
}


/**
 * Google Drive Class to handle all API interactions for a single root.
 */
class googleDrive {
    constructor(authConfig, order) {
        this.order = order;
        this.root = authConfig.roots[order];
        this.root.protect_file_link = this.root.protect_file_link || false;
        this.url_path_prefix = `/${order}:`;
        this.authConfig = { ...authConfig }; // Copy config to instance

        // Load credentials securely from environment variables
        // These MUST be set in the Cloudflare Worker's settings
        this.authConfig.client_id = typeof CLIENT_ID !== 'undefined' ? CLIENT_ID : "";
        this.authConfig.client_secret = typeof CLIENT_SECRET !== 'undefined' ? CLIENT_SECRET : "";
        this.authConfig.refresh_token = typeof REFRESH_TOKEN !== 'undefined' ? REFRESH_TOKEN : "";

        // Ephemeral cache (for a single request)
        this.paths = { "/": this.root.id };
        this.files = {};
        this.passwords = {};
        this.id_path_cache = {
            [this.root.id]: "/"
        };

        this.kv_cache_available = this.authConfig.enable_kv_cache && typeof GD_INDEX_CACHE !== 'undefined';
        if (this.authConfig.enable_kv_cache && typeof GD_INDEX_CACHE === 'undefined') {
            console.warn(`[Drive ${order}] KV Cache is enabled in config, but 'GD_INDEX_CACHE' KV Namespace is not bound. Caching will be disabled.`);
        }
    }

    /**
     * KV cache helper function - GET
     * @param {string} key
     */
    async _kv_get(key) {
        if (!this.kv_cache_available) return null;
        return GD_INDEX_CACHE.get(key, 'json');
    }

    /**
     * KV cache helper function - PUT
     * @param {string} key
     * @param {object} value
     */
    async _kv_put(key, value) {
        if (!this.kv_cache_available) return;
        const ttl = Math.max(60, this.authConfig.kv_cache_ttl);
        await GD_INDEX_CACHE.put(key, JSON.stringify(value), { expirationTtl: ttl });
    }

    /**
     * Initializes the access token and root drive ID.
     */
    async init() {
        if (!this.authConfig.client_id || !this.authConfig.client_secret || !this.authConfig.refresh_token) {
            console.error(`[Drive ${this.order}] Missing credentials in environment variables (CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN).`);
            this.root_type = -1; // Disable this drive
            return;
        }
        await this.accessToken();
        if (authConfig.user_drive_real_root_id) return;
        // The first drive instance will resolve the 'root' ID for all others.
        const root_obj = await (gds[0] || this).findItemById("root");
        if (root_obj && root_obj.id) {
            authConfig.user_drive_real_root_id = root_obj.id;
        }
    }

    /**
     * Determines the type of the root (user drive, shared drive, sub-folder).
     */
    async initRootType() {
        if (this.root_type === -1) return; // Already disabled
        let root_id = this.root.id;

        if (!root_id) {
            console.error(`[Drive ${this.order}] Root item '${this.root.name}' has no ID. Disabling.`);
            this.root_type = -1;
            return;
        }

        let root_obj = await this.findItemById(root_id, true, "id,name,mimeType,shortcutDetails");

        if (root_obj && root_obj.mimeType === CONSTS.shortcut_mime_type) {
            if (root_obj.shortcutDetails && root_obj.shortcutDetails.targetId) {
                console.log(`[Drive ${this.order}] Root '${this.root.name}' is a shortcut, resolving target...`);
                this.root.id = root_obj.shortcutDetails.targetId;
                root_obj = await this.findItemById(this.root.id, true, "id,mimeType");
                if (!root_obj || root_obj.mimeType !== CONSTS.folder_mime_type) {
                    console.error(`[Drive ${this.order}] Root shortcut '${this.root.name}' does not point to a valid folder. Disabling.`);
                    this.root_type = -1;
                    return;
                }
                root_id = this.root.id;
            } else {
                console.error(`[Drive ${this.order}] Root item '${this.root.name}' is an invalid shortcut. Disabling.`);
                this.root_type = -1;
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
                console.error(`[Drive ${this.order}] Root item '${this.root.name}' with ID '${root_id}' is not a valid folder, shared drive, or user drive. Disabling.`);
                this.root_type = -1;
            }
        }
        console.log(`[Drive ${this.order}] '${this.root.name}' initialized as type: ${this.root_type}.`);
    }

    /**
     * Processes a file object, resolving it if it's a shortcut.
     * @param {object} file
     */
    _processShortcut(file) {
        if (file && file.mimeType === CONSTS.shortcut_mime_type && file.shortcutDetails && file.shortcutDetails.targetId) {
            return {
                ...file,
                id: file.shortcutDetails.targetId,
                mimeType: file.shortcutDetails.targetMimeType,
                name: file.name.endsWith('.lnk') ? file.name.slice(0,-4) : file.name, // clean name
            };
        }
        return file;
    }

    /**
     * Processes an array of files, resolving shortcuts.
     * @param {Array<object>} files
     */
    _processShortcuts(files) {
        if (!files || files.length === 0) return files;
        return files.map(file => this._processShortcut(file));
    }

    /**
     * Handles Basic Authentication.
     * @param {Request} request
     */
    basicAuthResponse(request) {
        const user = this.root.user || "",
            pass = this.root.pass || "";
        if (!user && !pass) return null;

        const _401 = new Response("Unauthorized", {
            headers: { 'WWW-Authenticate': `Basic realm="goindex:drive:${this.order}"` },
            status: 401,
        });

        const auth = request.headers.get("Authorization");
        if (!auth) return _401;

        try {
            const [received_user, received_pass] = atob(auth.split(" ").pop()).split(":");
            return received_user === user && received_pass === pass ? null : _401;
        } catch (e) {
            return _401;
        }
    }

    /**
     * Proxy for viewing files (e.g., video streaming).
     */
    async view(url, range = "") {
        const requestOption = await this.requestOption({ 'Range': range });
        const res = await fetch(url, requestOption);
        const newRes = new Response(res.body, res);
        if (this.authConfig.enable_cors_file_down) {
            newRes.headers.set("Access-Control-Allow-Origin", "*");
        }
        newRes.headers.set("Content-Disposition", "inline");
        return newRes;
    }

    /**
     * Handles file download.
     */
    async down(id, range = "", inline = false) {
        const url = `https://www.googleapis.com/drive/v3/files/${id}?alt=media`;
        const requestOption = await this.requestOption({ 'Range': range });
        const res = await fetch(url, requestOption);
        const newRes = new Response(res.body, res);
        if (this.authConfig.enable_cors_file_down) {
            newRes.headers.set("Access-Control-Allow-Origin", "*");
        }
        if (inline) {
            newRes.headers.set("Content-Disposition", "inline");
        }
        return newRes;
    }

    /**
     * Gets file info by path. Uses cache.
     * @param {string} path
     */
    async file(path) {
        if (this.files[path]) return this.files[path];

        const cacheKey = `file:${this.order}:${path}`;
        let file = await this._kv_get(cacheKey);
        if (file) {
            this.files[path] = file;
            return file;
        }

        file = await this._file_uncached(path);
        if (file) {
            this.files[path] = file;
            await this._kv_put(cacheKey, file);
        }
        return file;
    }

    /**
     * Gets file info by path (no cache).
     * @param {string} path
     */
    async _file_uncached(path) {
        const arr = path.split('/');
        const name = arr.pop();
        const dir = arr.join('/') + '/';
        const parentId = await this.findPathId(dir);
        if (!parentId) return null;

        const url = new URL("https://www.googleapis.com/drive/v3/files");
        url.searchParams.set('includeItemsFromAllDrives', 'true');
        url.searchParams.set('supportsAllDrives', 'true');
        url.searchParams.set('q', `'${parentId}' in parents and name = '${name.replace(/'/g, "\\'")}' and trashed = false`);
        url.searchParams.set('fields', 'files(id, name, mimeType, size, createdTime, modifiedTime, shortcutDetails)');

        const requestOption = await this.requestOption();
        const response = await fetch(url.toString(), requestOption);
        const obj = await response.json();
        if (!obj.files || obj.files.length === 0) return null;
        
        return this._processShortcut(obj.files[0]);
    }

    /**
     * Lists files in a directory. Uses cache.
     * @param {string} path
     * @param {string|null} page_token
     * @param {number} page_index
     */
    async list(path, page_token = null, page_index = 0) {
        const cacheKey = `list:${this.order}:${path}:${page_index}:${page_token || ''}`;
        let list_result = await this._kv_get(cacheKey);
        if (list_result) return list_result;

        const id = await this.findPathId(path);
        list_result = await this._ls_uncached(id, page_token, page_index);

        if (list_result && list_result.data) {
            await this._kv_put(cacheKey, list_result);
        }
        return list_result;
    }

    /**
     * Lists files in a directory (no cache).
     * @param {string} parentId
     * @param {string|null} page_token
     * @param {number} page_index
     */
    async _ls_uncached(parentId, page_token = null, page_index = 0) {
        if (!parentId) return null;

        const url = new URL("https://www.googleapis.com/drive/v3/files");
        const params = {
            includeItemsFromAllDrives: 'true',
            supportsAllDrives: 'true',
            q: `'${parentId}' in parents and trashed = false AND name !='.password'`,
            orderBy: 'folder,name,modifiedTime desc',
            fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, thumbnailLink, description, shortcutDetails)',
            pageSize: this.authConfig.files_list_page_size,
        };
        if (page_token) params.pageToken = page_token;

        for (const key in params) {
            url.searchParams.set(key, params[key]);
        }

        const requestOption = await this.requestOption();
        const response = await fetch(url.toString(), requestOption);
        const obj = await response.json();

        if (obj.files) {
            obj.files = this._processShortcuts(obj.files);
        }

        return {
            nextPageToken: obj.nextPageToken || null,
            curPageIndex: page_index,
            data: obj,
        };
    }

    /**
     * Get .password file content.
     * @param {string} path
     */
    async password(path) {
        if (this.passwords[path] !== undefined) return this.passwords[path];

        const file = await this.file(path + ".password");
        if (!file) {
            this.passwords[path] = null;
        } else {
            const url = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`;
            const requestOption = await this.requestOption();
            const response = await fetch(url, requestOption);
            if (response.ok) {
                 this.passwords[path] = await response.text();
            } else {
                 this.passwords[path] = null;
            }
        }
        return this.passwords[path];
    }
    
    /**
     * Searches for files.
     * @param {string} keyword
     * @param {string|null} page_token
     * @param {number} page_index
     */
    async search(keyword, page_token = null, page_index = 0) {
        const empty_result = {
            nextPageToken: null,
            curPageIndex: page_index,
            data: { files: [] },
        };
        if (!keyword) return empty_result;
        
        // Use API search for user/shared drives
        const cacheKey = `search:${this.order}:${keyword}:${page_token || ''}`;
        let search_result = await this._kv_get(cacheKey);
        if (search_result) return search_result;
        
        const params = {
            supportsAllDrives: 'true',
            includeItemsFromAllDrives: 'true',
            fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, shortcutDetails, parents)',
            pageSize: this.authConfig.search_result_list_page_size,
            q: `trashed = false AND name !='.password' AND name contains '${keyword.replace(/'/g, "\\'")}'`
        };
        if (page_token) params.pageToken = page_token;
        
        const { user_drive, share_drive, sub_folder } = CONSTS.gd_root_type;
        switch (this.root_type) {
            case user_drive:
                params.corpora = 'user';
                break;
            case share_drive:
                params.corpora = 'drive';
                params.driveId = this.root.id;
                break;
            case sub_folder:
                 params.q += ` and '${this.root.id}' in parents`;
                 break;
            default:
                return empty_result;
        }

        const url = new URL("https://www.googleapis.com/drive/v3/files");
        for (const key in params) {
            url.searchParams.set(key, params[key]);
        }
        
        const requestOption = await this.requestOption();
        const response = await fetch(url.toString(), requestOption);
        const res_obj = await response.json();

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

    /**
     * Finds the full path of a file/folder by its ID.
     * @param {string} child_id
     */
    async findPathById(child_id) {
        if (this.id_path_cache[child_id]) return this.id_path_cache[child_id];

        const cacheKey = `id2path:${this.order}:${child_id}`;
        const cacheResult = await this._kv_get(cacheKey);
        if (cacheResult && cacheResult.path) {
            this.id_path_cache[child_id] = cacheResult.path;
            return cacheResult.path;
        }

        const p_files = await this.findParentFilesRecursion(child_id);
        if (!p_files || p_files.length === 0) return "";

        const path = "/" + p_files.map(it => it.name).reverse().join("/");
        const final_path = p_files[0].mimeType === CONSTS.folder_mime_type ? path + "/" : path;
        
        this.id_path_cache[child_id] = final_path;
        await this._kv_put(cacheKey, { path: final_path });
        return final_path;
    }
    
    /**
     * Recursively finds parent files up to the drive's root.
     * @param {string} child_id
     */
    async findParentFilesRecursion(child_id) {
        const parent_files = [];
        let meet_top = false;

        const find = async (id) => {
            if(id === this.root.id) {
                meet_top = true;
                return;
            }
            const file_obj = await this.findItemById(id, true, "id,name,mimeType,parents");
            if(file_obj) {
                parent_files.push(file_obj);
                if (file_obj.parents && file_obj.parents.length > 0) {
                     await find(file_obj.parents[0]);
                } else if (this.root_type === CONSTS.gd_root_type.user_drive) {
                    // Reached user's real root
                    meet_top = true;
                }
            }
        };

        const child_obj = await this.findItemById(child_id, true, "id,name,mimeType,parents");
        if (child_obj) {
            parent_files.push(child_obj);
            if(child_id === this.root.id) meet_top = true;
            else if (child_obj.parents && child_obj.parents.length > 0) await find(child_obj.parents[0]);
        }
        
        return meet_top ? parent_files : null;
    }


    /**
     * Finds an item's ID by its path.
     * @param {string} path
     */
    async findPathId(path) {
        if (this.paths[path]) return this.paths[path];

        const parts = path.trim('/').split('/');
        let current_id = this.root.id;
        let current_path = "/";

        for (const name of parts) {
            if (!name) continue;
            current_path += name + "/";
            if (!this.paths[current_path]) {
                const id = await this._findDirId_uncached(current_id, name);
                this.paths[current_path] = id;
            }
            current_id = this.paths[current_path];
            if (!current_id) break;
        }
        return this.paths[path];
    }
    
    /**
     * Finds a directory's ID within a parent. Uses cache.
     * @param {string} parent
     * @param {string} name
     */
    async _findDirId_uncached(parent, name) {
        if (!parent) return null;
        
        const cacheKey = `dirid:${this.order}:${parent}:${name}`;
        let id = await this._kv_get(cacheKey);
        if(id) return id;

        const url = new URL("https://www.googleapis.com/drive/v3/files");
        const params = {
            includeItemsFromAllDrives: 'true',
            supportsAllDrives: 'true',
            q: `'${parent}' in parents and (mimeType = '${CONSTS.folder_mime_type}' or mimeType = '${CONSTS.shortcut_mime_type}') and name = '${name.replace(/'/g, "\\'")}' and trashed = false`,
            fields: 'files(id, shortcutDetails)',
        };
        for (const key in params) url.searchParams.set(key, params[key]);
        
        const requestOption = await this.requestOption();
        const response = await fetch(url.toString(), requestOption);
        const obj = await response.json();
        if (!obj.files || obj.files.length === 0) return null;
        
        const file = this._processShortcut(obj.files[0]);
        id = file.id;

        await this._kv_put(cacheKey, id);
        return id;
    }
    
    // --- Helper Functions ---
    async getShareDriveObjById(id) {
        if (!id) return null;
        const url = `https://www.googleapis.com/drive/v3/drives/${id}`;
        const requestOption = await this.requestOption();
        const res = await fetch(url, requestOption);
        const obj = await res.json();
        return (res.ok && obj && obj.id) ? obj : null;
    }
    
    async findItemById(id, raw = false, fields = CONSTS.default_file_fields) {
        if(id === 'root' && authConfig.user_drive_real_root_id){
            id = authConfig.user_drive_real_root_id;
        }
        const url = `https://www.googleapis.com/drive/v3/files/${id}?fields=${fields}&supportsAllDrives=true`;
        const requestOption = await this.requestOption();
        const res = await fetch(url, requestOption);
        const file = await res.json();
        if (file.error) {
            console.error(`API Error for ID ${id}:`, file.error.message);
            return null;
        }
        return raw ? file : this._processShortcut(file);
    }
    
    async accessToken() {
        if (!this.authConfig.expires || this.authConfig.expires < Date.now()) {
            const obj = await this.fetchAccessToken();
            if (obj && obj.access_token) {
                this.authConfig.accessToken = obj.access_token;
                this.authConfig.expires = Date.now() + 3500 * 1000;
            } else {
                 console.error(`[Drive ${this.order}] Failed to refresh access token.`);
            }
        }
        return this.authConfig.accessToken;
    }

    async fetchAccessToken() {
        const url = "https://www.googleapis.com/oauth2/v4/token";
        const post_data = new URLSearchParams({
            client_id: this.authConfig.client_id,
            client_secret: this.authConfig.client_secret,
            refresh_token: this.authConfig.refresh_token,
            grant_type: "refresh_token",
        });
        const requestOption = {
            method: "POST",
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: post_data,
        };

        const response = await fetch(url, requestOption);
        return response.json();
    }

    async requestOption(headers = {}, method = "GET") {
        const accessToken = await this.accessToken();
        if (!accessToken) {
            throw new Error("Access Token is not available.");
        }
        const finalHeaders = { 'authorization': 'Bearer ' + accessToken, ...headers };
        return { method: method, headers: finalHeaders };
    }
}


/**
 * Generates the main HTML page.
 * @param {number} current_drive_order
 * @param {object} model
 */
function html(current_drive_order = 0, model = {}) {
    // Stringify and escape for injection into the script tag
    const config_str = JSON.stringify({
        version: authConfig.version,
        themeOptions: themeOptions,
    });
    const gds_str = JSON.stringify(authConfig.roots.map((it) => it.name));
    const model_str = JSON.stringify(model);

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"/>
    <title>${authConfig.siteName}</title>
    <link rel="icon" type="image/png" href="https://i.loli.net/2021/11/19/2GZpWJnBQUvLgcs.png">
    <link rel="stylesheet" href="${themeOptions.cdn}@${themeOptions.version}/dist/style.min.css">
    <script>
      window.gdconfig = JSON.parse('${config_str}');
      window.gds = JSON.parse('${gds_str}');
      window.MODEL = JSON.parse('${model_str}');
      window.current_drive_order = ${current_drive_order};
    </script>
</head>
<body>
    <div id="app"></div>
    <script src="${themeOptions.cdn}@${themeOptions.version}/dist/app.min.js"></script>
</body>
</html>`;
}
