/**
 * Google Drive Index - Cloudflare Worker (Refactored)
 * @version 2.3.5-refactored
 * * A comprehensive Google Drive directory index built for Cloudflare Workers.
 * This is a refactored version with improved code structure and organization.
 * * Features:
 * - Multi-drive support with secure environment variable configuration
 * - Efficient KV caching system for optimal performance  
 * - Automated cron-based cache updates
 * - Modern responsive web interface with dark/light themes
 * - Advanced search functionality across all files
 * - Admin panel for cache management (Layout Refactored)
 * - Enhanced file preview page with Plyr.io player
 * - Basic authentication support per drive
 * - Direct file download and media streaming
 */

// ===============================================================
// CONFIGURATION MODULE
// ===============================================================

const authConfig = {
    siteName: "GDrive Index",
    version: "2.3.5-refactored",
    
    // KV cache configuration
    enable_kv_cache: true,
    browsing_cache_ttl: 43200,      // 12 hours
    cron_cache_ttl: 86400,          // 24 hours
    cron_update_hour: 4,            // UTC+8
    
    // Admin functionality
    require_admin_password_for_clear: true,

    // Pagination
    files_list_page_size: 200,
    search_result_list_page_size: 50,
    
    // Security & CORS
    enable_cors_file_down: false,
    default_gd: 0,
};

const CONSTS = {
    default_file_fields: "parents,id,name,mimeType,modifiedTime,createdTime,fileExtension,size,shortcutDetails",
    gd_root_type: {
        user_drive: 0,
        share_drive: 1,
        sub_folder: 2,
    },
    folder_mime_type: "application/vnd.google-apps.folder",
    shortcut_mime_type: "application/vnd.google-apps.shortcut",
    CRON_NEXT_DRIVE_INDEX_KEY: "cron_next_drive_index",
};

let rootsParsingError = null;

function initializeRoots() {
    if (typeof authConfig.roots !== 'undefined') {
        return;
    }

    try {
        if (typeof DRIVE_ROOTS !== 'undefined' && DRIVE_ROOTS) {
            authConfig.roots = JSON.parse(DRIVE_ROOTS);
            rootsParsingError = null;
        } else {
            rootsParsingError = "配置错误: 'DRIVE_ROOTS' 环境变量未设置。请在 Cloudflare Worker 设置中添加它。";
            authConfig.roots = [];
        }
    } catch (e) {
        rootsParsingError = `配置错误: 解析 'DRIVE_ROOTS' 环境变量失败。请确保它是有效的、单行的 JSON 数组，不含注释或末尾逗号。\n\n错误详情: ${e.message}`;
        authConfig.roots = [];
    }
}

function getConfigError() {
    return rootsParsingError;
}

function parsePath(path) {
    const regex = /^\/(\d+):(\/.*)/;
    const match = path.match(regex);
    if (match) {
        return {
            driveId: parseInt(match[1]),
            filePath: match[2]
        };
    }
    return { driveId: null, filePath: '' };
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: { 
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
        },
    });
}

// ===============================================================
// GOOGLE DRIVE API MODULE
// ===============================================================

class GoogleDrive {
    constructor(config, order) {
        this.order = order;
        this.root = config.roots[order];
        this.root.protect_file_link = this.root.protect_file_link || false;

        this.authConfig = { ...config };
        this.authConfig.client_id = typeof CLIENT_ID !== 'undefined' ? CLIENT_ID : "";
        this.authConfig.client_secret = typeof CLIENT_SECRET !== 'undefined' ? CLIENT_SECRET : "";
        this.authConfig.refresh_token = typeof REFRESH_TOKEN !== 'undefined' ? REFRESH_TOKEN : "";

        this.paths = {};
        this.files = {};
        this.id_path_cache = {};
        this.id_path_cache[this.root.id] = "/";
        this.paths["/"] = this.root.id;

        this.kv_cache_available = this.authConfig.enable_kv_cache && typeof GD_INDEX_CACHE !== 'undefined';
    }

    async _kv_get(key) {
        if (!this.kv_cache_available) return null;
        try {
            return await GD_INDEX_CACHE.get(key, 'json');
        } catch (e) {
            console.error(`KV GET Error for key ${key}:`, e);
            return null;
        }
    }
    
    async _kv_put(key, value) {
        if (!this.kv_cache_available) return;

        let ttl;
        if (key.startsWith('all_files:')) {
            ttl = this.authConfig.cron_cache_ttl;
        } else {
            ttl = this.authConfig.browsing_cache_ttl;
        }

        const expirationTtl = Math.max(60, ttl);
        await GD_INDEX_CACHE.put(key, JSON.stringify(value), { expirationTtl });
    }

    async init() {
        if (!this.authConfig.client_id || !this.authConfig.client_secret || !this.authConfig.refresh_token) {
            throw new Error(`凭证未在环境变量中配置。`);
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
        let root_id = this.root.id;

        if (!root_id) {
            console.error(`根目录 '${this.root.name}' 没有 ID。`);
            return;
        }

        const root_obj = await this.findItemById(root_id);

        if (root_obj && root_obj.mimeType === CONSTS.shortcut_mime_type) {
            if (root_obj.shortcutDetails && root_obj.shortcutDetails.targetId && root_obj.shortcutDetails.targetMimeType === CONSTS.folder_mime_type) {
                this.root.id = root_obj.shortcutDetails.targetId;
                root_id = this.root.id;
            } else {
                console.error(`根目录 '${this.root.name}' 是一个无效的快捷方式或不指向文件夹。`);
                return;
            }
        }
        
        if (root_id === "root" || root_id === authConfig.user_drive_real_root_id) {
            this.root_type = CONSTS.gd_root_type.user_drive;
        } else {
            const drive_obj = await this.getShareDriveObjById(root_id);
            if (drive_obj) {
                this.root_type = CONSTS.gd_root_type.share_drive;
            } else {
                const item_obj = (root_obj && root_obj.id === root_id) ? root_obj : await this.findItemById(root_id);
                if (item_obj && item_obj.mimeType === CONSTS.folder_mime_type) {
                    this.root_type = CONSTS.gd_root_type.sub_folder;
                } else {
                     console.error(`根目录 '${this.root.name}' (ID: '${root_id}') 不是有效的文件夹、共享云盘或用户云盘。`);
                }
            }
        }
    }

    basicAuthResponse(request) {
        const user = this.root.user || "";
        const pass = this.root.pass || "";
        if (!user && !pass) return null;

        const unauthorizedResponse = new Response("Unauthorized", {
            status: 401,
            headers: { "WWW-Authenticate": `Basic realm="Protected Area"` },
        });

        const authHeader = request.headers.get("Authorization");
        if (!authHeader || !authHeader.startsWith("Basic ")) {
            return unauthorizedResponse;
        }

        try {
            const [receivedUser, receivedPass] = atob(authHeader.substring(6)).split(":");
            if (receivedUser === user && receivedPass === pass) {
                return null; 
            }
        } catch (e) {}
        return unauthorizedResponse;
    }

    async down(id, range = "", inline = false) {
        const url = `https://www.googleapis.com/drive/v3/files/${id}?alt=media`;
        const requestOption = await this.requestOption({ Range: range });
        const res = await fetch(url, requestOption);
        
        const newHeaders = new Headers(res.headers);
        newHeaders.set('Content-Disposition', inline ? 'inline' : 'attachment');

        if (this.authConfig.enable_cors_file_down) {
            newHeaders.set("Access-Control-Allow-Origin", "*");
        }
        
        return new Response(res.body, {
            status: res.status,
            statusText: res.statusText,
            headers: newHeaders,
        });
    }

    async file(path) {
        if (this.files[path]) return this.files[path];

        const cacheKey = `file:${this.order}:${path}`;
        let file = await this._kv_get(cacheKey);
        if (file) {
            this.files[path] = file;
            return file;
        }
        
        const arr = path.split('/').filter(Boolean);
        const name = decodeURIComponent(arr.pop());
        const dir = `/${arr.join('/')}/`;
        
        const parentId = await this.findPathId(dir);
        if (!parentId) return null;

        const params = {
            includeItemsFromAllDrives: true,
            supportsAllDrives: true,
            q: `'${parentId}' in parents and name = '${name.replace(/'/g, "\\'")}' and trashed = false`,
            fields: `files(${CONSTS.default_file_fields})`,
        };
        const url = `https://www.googleapis.com/drive/v3/files?${this.enQuery(params)}`;
        const requestOption = await this.requestOption();
        const response = await fetch(url, requestOption);
        const obj = await response.json();

        if (!obj.files || obj.files.length === 0) return null;
        
        file = this._processShortcut(obj.files[0]);
        if (file) {
            this.files[path] = file;
            await this._kv_put(cacheKey, file);
        }
        return file;
    }
    
    async list(path, page_token = null, page_index = 0) {
        const cacheKey = `list:${this.order}:${path}:${page_index}:${page_token || ''}`;
        let list_result = await this._kv_get(cacheKey);
        if (list_result) return list_result;
        
        const id = await this.findPathId(path);
        list_result = await this._ls(id, page_token, page_index);
        
        if (list_result && list_result.data) {
            await this._kv_put(cacheKey, list_result);
        }
        return list_result;
    }

    async _ls(parent, page_token = null, page_index = 0) {
        if (!parent) return null;
        
        const params = {
            includeItemsFromAllDrives: true,
            supportsAllDrives: true,
            q: `'${parent}' in parents and trashed = false AND name !='.password'`,
            orderBy: "folder,name,modifiedTime desc",
            fields: `nextPageToken, files(id, name, mimeType, size, modifiedTime, shortcutDetails)`,
            pageSize: this.authConfig.files_list_page_size,
        };
        if (page_token) params.pageToken = page_token;

        const url = `https://www.googleapis.com/drive/v3/files?${this.enQuery(params)}`;
        const requestOption = await this.requestOption();
        const response = await fetch(url, requestOption);
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
    
    async search(query) {
        if (!query) return { data: { files: [] } };
        
        const cacheKey = `all_files:${this.order}:${this.root.id}`;
        let cacheObject = await this._kv_get(cacheKey);

        if (!cacheObject || !cacheObject.files) {
            console.log(`[Search] 缓存未命中，为云盘 ${this.order} 按需执行扫描...`);
            console.time(`[Search] Drive ${this.order} scan duration`);
            
            const all_files = await this.listAllFiles(this.root.id);
            cacheObject = {
                files: all_files,
                last_updated: new Date().toISOString(),
                total_files: all_files.length
            };
            
            // 使用专门的搜索缓存TTL，确保立即可用
            const searchCacheKey = `search_cache:${this.order}:${this.root.id}`;
            await Promise.all([
                this._kv_put(cacheKey, cacheObject),
                this._kv_put(searchCacheKey, cacheObject)
            ]);
            
            console.timeEnd(`[Search] Drive ${this.order} scan duration`);
            console.log(`[Search] 已为云盘 ${this.order} 生成并缓存了 ${all_files.length} 个项目。`);
        } else {
            console.log(`[Search] 使用现有缓存，云盘 ${this.order}，共 ${cacheObject.files.length} 个项目，缓存时间: ${cacheObject.last_updated}`);
        }
        
        const lowerCaseQuery = query.toLowerCase();
        const filtered_files = cacheObject.files.filter(file => 
            file.name.toLowerCase().includes(lowerCaseQuery)
        );
        
        // 异步缓存路径映射，不阻塞搜索结果返回
        Promise.all(filtered_files.map(file => {
            if (file.id && file.path) {
                return this._kv_put(`path_by_id:${this.order}:${file.id}`, file.path);
            }
        })).catch(err => console.warn('路径缓存失败:', err));
        
        return { 
            data: { 
                files: filtered_files,
                cache_info: {
                    total_files: cacheObject.total_files || cacheObject.files.length,
                    filtered_count: filtered_files.length,
                    cache_timestamp: cacheObject.last_updated
                }
            } 
        };
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
                console.error(`列出文件夹 ${currentFolderId} 失败:`, e.message);
            }
        }
        return allFiles;
    }
    
    async findPathId(path) {
        if (this.paths[path]) return this.paths[path];
    
        let parentId = this.root.id;
        let currentCumulativePath = '/';
    
        if (path === '/') {
            return parentId;
        }

        const parts = path.trim('/').split('/');

        for (const name of parts) {
            if (!name) continue;
            
            const decodedName = decodeURIComponent(name);
            currentCumulativePath += decodedName + '/';
            
            let childId = this.paths[currentCumulativePath];

            if (!childId) {
                childId = await this._findDirId(parentId, decodedName);
                
                if (!childId) {
                    this.paths[path] = null; 
                    return null;
                }
                
                this.paths[currentCumulativePath] = childId;
            }
            
            parentId = childId;
        }

        this.paths[path] = parentId;
        return parentId;
    }

    async _findDirId(parentId, name) {
        if (!parentId) return null;
        
        const cacheKey = `dirid:${this.order}:${parentId}:${name}`;
        let id = await this._kv_get(cacheKey);
        if (id) return id;

        const q = `'${parentId}' in parents and (mimeType = '${CONSTS.folder_mime_type}' or mimeType = '${CONSTS.shortcut_mime_type}') and name = '${name.replace(/'/g, "\\'")}' and trashed = false`;
        const params = {
            includeItemsFromAllDrives: true,
            supportsAllDrives: true,
            q: q,
            fields: "files(id, name, mimeType, shortcutDetails)",
        };
        const url = `https://www.googleapis.com/drive/v3/files?${this.enQuery(params)}`;
        const requestOption = await this.requestOption();
        const response = await fetch(url, requestOption);
        const obj = await response.json();
        
        if (!obj.files || obj.files.length === 0) return null;

        const file = this._processShortcut(obj.files[0]);
        id = file.id;
        await this._kv_put(cacheKey, id);
        return id;
    }
    
    async findPathById(id) {
        const cacheKey = `path_by_id:${this.order}:${id}`;
        if (this.id_path_cache[id]) return this.id_path_cache[id];

        const cachedPath = await this._kv_get(cacheKey);
        if (cachedPath) {
            this.id_path_cache[id] = cachedPath;
            return cachedPath;
        }
        
        const p_files = await this.findParentFilesRecursion(id);
        if (!p_files) return "";
        
        const path_parts = p_files.map(it => it.name).reverse();
        let path = "/" + path_parts.join("/");
        if (p_files[0].mimeType === CONSTS.folder_mime_type && path !== "/") {
            path += "/";
        }
        
        this.id_path_cache[id] = path;
        await this._kv_put(cacheKey, path);
        return path;
    }

    async findParentFilesRecursion(child_id) {
        const target_top_id = this.root_type === CONSTS.gd_root_type.user_drive ? authConfig.user_drive_real_root_id : this.root.id;
        const parent_files = [];
        let meet_top = false;

        const find = async (current_id) => {
            if (current_id === target_top_id) {
                meet_top = true;
                return;
            }
            
            const file_obj = await this.findItemById(current_id, true);
            if (!file_obj) return;
            
            parent_files.push(file_obj);
            
            if (!file_obj.parents || file_obj.parents.length === 0) return;
            await find(file_obj.parents[0]);
        }
        
        await find(child_id);
        return meet_top ? parent_files : null;
    }

    async findItemById(id, raw = false) {
        const is_user_drive = this.root_type === CONSTS.gd_root_type.user_drive;
        let url = `https://www.googleapis.com/drive/v3/files/${id}?fields=${CONSTS.default_file_fields}`;
        if (!is_user_drive || id !== 'root') {
            url += "&supportsAllDrives=true";
        }
        const requestOption = await this.requestOption();
        const res = await fetch(url, requestOption);
        const file = await res.json();
        
        if (file.error) {
            console.error(`API Error for ID ${id}:`, JSON.stringify(file.error));
            return null;
        }
        return raw ? file : this._processShortcut(file);
    }
    
    async getShareDriveObjById(id) {
        const url = `https://www.googleapis.com/drive/v3/drives/${id}`;
        const requestOption = await this.requestOption();
        const res = await fetch(url, requestOption);
        const obj = await res.json();
        return obj && obj.id ? obj : null;
    }
    
    async accessToken() {
        if (this.authConfig.expires === undefined || this.authConfig.expires < Date.now()) {
            const obj = await this.fetchAccessToken();
            if (obj.access_token) {
                this.authConfig.accessToken = obj.access_token;
                this.authConfig.expires = Date.now() + 3500 * 1000;
            }
        }
        return this.authConfig.accessToken;
    }

    async fetchAccessToken() {
        const url = "https://www.googleapis.com/oauth2/v4/token";
        const post_data = {
            client_id: this.authConfig.client_id,
            client_secret: this.authConfig.client_secret,
            refresh_token: this.authConfig.refresh_token,
            grant_type: "refresh_token",
        };
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: this.enQuery(post_data),
        });
        const data = await response.json();
        if (data.error) {
            console.error("Error fetching access token:", data.error_description);
            throw new Error(`Failed to refresh access token: ${data.error_description}`);
        }
        return data;
    }
    
    async requestOption(headers = {}, method = "GET") {
        const accessToken = await this.accessToken();
        const newHeaders = new Headers(headers);
        newHeaders.set("authorization", `Bearer ${accessToken}`);
        return { method, headers: newHeaders };
    }
    
    _processShortcut(file) {
        if (file && file.mimeType === CONSTS.shortcut_mime_type && file.shortcutDetails && file.shortcutDetails.targetId) {
            return {
                ...file,
                id: file.shortcutDetails.targetId,
                mimeType: file.shortcutDetails.targetMimeType,
                isShortcut: true,
            };
        }
        return file;
    }
    
    _processShortcuts(files) {
        return files ? files.map(file => this._processShortcut(file)) : [];
    }

    enQuery(data) {
        return Object.entries(data)
            .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
            .join('&');
    }

    async clearPathCache(path) {
        if (!this.kv_cache_available) {
            return { success: true, message: "KV cache is not enabled." };
        }
        
        const prefixesToDelete = [];
        if (path.endsWith('/')) {
            prefixesToDelete.push(`list:${this.order}:${path}`);
        }
        else {
            prefixesToDelete.push(`file:${this.order}:${path}`);
        }

        let totalKeysDeleted = 0;
        try {
            for (const prefix of prefixesToDelete) {
                 let listComplete = false;
                 let cursor = undefined;
                 while(!listComplete){
                    const list = await GD_INDEX_CACHE.list({ prefix, cursor, limit: 1000 });
                    const keys = list.keys.map(key => key.name);
                    if (keys.length > 0){
                        await Promise.all(keys.map(key => GD_INDEX_CACHE.delete(key)));
                    }
                    totalKeysDeleted += keys.length;
                    listComplete = list.list_complete;
                    cursor = list.cursor;
                 }
            }
            return { success: true, keysDeleted: totalKeysDeleted };
        } catch (e) {
            console.error("KV Path Cache Clearing Error:", e);
            return { success: false, message: `清理路径缓存失败: ${e.message}` };
        }
    }
}

// Global GoogleDrive instance cache
const gds = [];

async function getGoogleDrive(driveId, forceReload = false) {
    if (!forceReload && gds[driveId]) {
        return gds[driveId];
    }
    try {
        const gd = new GoogleDrive(authConfig, driveId);
        await gd.init();
        await gd.initRootType();
        if (gd.root_type === -1) {
            console.error(`云盘 ID ${driveId} 初始化失败。`);
            return null;
        }
        gds[driveId] = gd;
        return gd;
    } catch (e) {
        console.error(`初始化云盘 ${driveId} 时出错: ${e.message}`);
        return null;
    }
}

// ===============================================================
// HTML RENDERING MODULE
// ===============================================================

async function renderHTML(driveId, filePath, urlParams, url) {
    const clientConfig = {
        siteName: authConfig.siteName,
        driveId: driveId,
        initialPath: filePath,
        drives: authConfig.roots.map(r => r.name),
        searchQuery: urlParams.get('q') || '',
    };
    
    return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${authConfig.siteName}</title>
    <link rel="icon" href="/favicon.ico">
    <style>
        :root {
            --bg-color: #ffffff; --text-color: #1a1d21; --primary-color: #007bff;
            --border-color: #dee2e6; --item-bg-hover: #f8f9fa; --header-bg: #f8f9fa;
            --icon-color: #495057; --folder-color: #ffc107; --link-color: #007bff;
            --menu-bg: #ffffff; --shadow-color: rgba(0, 0, 0, 0.1);
        }
        [data-theme="dark"] {
            --bg-color: #1a1d21; --text-color: #e9ecef; --border-color: #343a40;
            --item-bg-hover: #343a40; --header-bg: #212529; --icon-color: #adb5bd;
            --link-color: #58a6ff; --menu-bg: #2c3034; --shadow-color: rgba(0, 0, 0, 0.3);
        }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; margin: 0; background-color: var(--bg-color); color: var(--text-color); transition: background-color 0.3s, color 0.3s; line-height: 1.6; }
        * { box-sizing: border-box; }
        .container { max-width: 1200px; margin: 0 auto; padding: 1rem; }
        .header { background-color: var(--header-bg); border-bottom: 1px solid var(--border-color); padding: 0.75rem 1rem; position: sticky; top: 0; z-index: 100; backdrop-filter: blur(5px); background-color: color-mix(in srgb, var(--header-bg) 80%, transparent); }
        .nav-bar { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
        .site-name { font-size: 1.5rem; font-weight: 600; text-decoration: none; color: inherit; }
        .drive-selector { padding: 0.5rem; border-radius: 6px; border: 1px solid var(--border-color); background: var(--bg-color); color: var(--text-color); }
        .search-form { display: flex; flex-grow: 1; }
        .search-input { flex-grow: 1; padding: 0.5rem 0.75rem; border: 1px solid var(--border-color); border-right: 0; border-radius: 6px 0 0 6px; background: var(--bg-color); color: var(--text-color); min-width: 100px; }
        .search-button { padding: 0.5rem 1rem; border: 1px solid var(--primary-color); background-color: var(--primary-color); color: white; border-radius: 0 6px 6px 0; cursor: pointer; }
        .nav-actions { margin-left: auto; position: relative; }
        .settings-button { background: none; border: none; font-size: 1.5rem; cursor: pointer; color: var(--icon-color); padding: 0.25rem; }
        .settings-menu { display: none; position: absolute; right: 0; top: 100%; background-color: var(--menu-bg); border-radius: 8px; box-shadow: 0 4px 12px var(--shadow-color); border: 1px solid var(--border-color); list-style: none; padding: 0.5rem 0; margin: 0.5rem 0 0; z-index: 101; min-width: 160px; }
        .settings-menu.show { display: block; }
        .settings-menu li a, .settings-menu li button { display: flex; align-items: center; gap: 0.75rem; width: 100%; padding: 0.75rem 1rem; background: none; border: none; color: var(--text-color); text-decoration: none; text-align: left; font-size: 0.95rem; }
        .settings-menu li:hover { background-color: var(--item-bg-hover); }
        .breadcrumbs { margin-top: 1rem; display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem; font-size: 0.95rem; }
        .breadcrumbs a { text-decoration: none; color: var(--link-color); }
        .breadcrumbs a:hover { text-decoration: underline; }
        .breadcrumbs span.separator { color: var(--icon-color); }
        .file-list { list-style: none; padding: 0; margin-top: 1rem; }
        .file-item { display: flex; align-items: center; padding: 0.75rem; border-bottom: 1px solid var(--border-color); text-decoration: none; color: inherit; transition: background-color 0.2s; border-radius: 4px; }
        .file-item:hover { background-color: var(--item-bg-hover); }
        .file-item .icon { width: 24px; height: 24px; margin-right: 1rem; color: var(--icon-color); }
        .file-item .name { flex-grow: 1; word-break: break-all; }
        .file-item .folder .name { font-weight: 500; }
        .file-item .size, .file-item .date { font-size: 0.85rem; color: #6c757d; margin-left: 1rem; white-space: nowrap; }
        .loading, .empty { text-align: center; padding: 3rem; color: #6c757d; font-size: 1.1rem; }
        .loading .spinner { width: 40px; height: 40px; border: 4px solid var(--border-color); border-top-color: var(--primary-color); border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 1rem; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @media (max-width: 768px) { .file-item .date { display: none; } .site-name { font-size: 1.2rem; } .container { padding: 0.5rem; } }
        @media (max-width: 480px) { .file-item .size { display: none; } .nav-bar { flex-direction: column; align-items: stretch; } }
    </style>
</head>
<body>
    <div id="app">
        <header class="header">
            <nav class="nav-bar container">
                <a href="/" class="site-name">${authConfig.siteName}</a>
                <select id="drive-selector" class="drive-selector"></select>
                <form id="search-form" class="search-form">
                    <input type="search" id="search-input" class="search-input" placeholder="搜索文件...">
                    <button type="submit" class="search-button">搜索</button>
                </form>
                <div class="nav-actions">
                    <button id="settings-button" class="settings-button" aria-label="Settings">⚙️</button>
                    <ul id="settings-menu" class="settings-menu">
                        <li><button id="theme-toggle"><span>🌓</span><span>切换主题</span></button></li>
                        <li><button id="refresh-button"><span>🔄</span><span>刷新缓存</span></button></li>
                        <li><a href="/admin/" target="_blank"><span>🔧</span><span>管理后台</span></a></li>
                    </ul>
                </div>
            </nav>
        </header>

        <main class="container">
            <div id="breadcrumbs" class="breadcrumbs"></div>
            <ul id="file-list" class="file-list"></ul>
            <div id="loading" class="loading" style="display: none;"><div class="spinner"></div><p>加载中...</p></div>
            <div id="empty" class="empty" style="display: none;"><p>此文件夹为空。</p></div>
        </main>
    </div>

    <script type="module">
        (async () => {
            const config = ${JSON.stringify(clientConfig)};
            const appState = { driveId: config.driveId, path: config.initialPath, isLoading: false };

            const driveSelector = document.getElementById('drive-selector');
            const searchForm = document.getElementById('search-form');
            const searchInput = document.getElementById('search-input');
            const breadcrumbs = document.getElementById('breadcrumbs');
            const fileList = document.getElementById('file-list');
            const loadingIndicator = document.getElementById('loading');
            const emptyIndicator = document.getElementById('empty');
            const settingsButton = document.getElementById('settings-button');
            const settingsMenu = document.getElementById('settings-menu');
            const themeToggle = document.getElementById('theme-toggle');
            const refreshButton = document.getElementById('refresh-button');

            const ICONS = {
                folder: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="color: var(--folder-color);"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" /></svg>',
                file: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zM13 9V3.5L18.5 9H13z"/></svg>',
                image: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>',
                video: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>',
                audio: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v9.28c-.47-.17-.97-.28-1.5-.28C8.01 12 6 14.01 6 16.5S8.01 21 10.5 21s4.5-2.01 4.5-4.5V8h4V3h-7z"/></svg>',
            };

            async function apiFetch(endpoint, params) {
                setLoading(true);
                params.driveId = appState.driveId;
                const url = new URL(window.location.origin + endpoint);
                for (const key in params) url.searchParams.set(key, params[key]);
                try {
                    const response = await fetch(url);
                    if (!response.ok) throw new Error('API Error: ' + response.statusText);
                    return await response.json();
                } catch (error) {
                    console.error('Fetch error:', error);
                    alert('数据加载失败，请查看控制台获取详情。');
                    return null;
                } finally {
                    setLoading(false);
                }
            }
            
            function setLoading(isLoading) {
                appState.isLoading = isLoading;
                loadingIndicator.style.display = isLoading ? 'block' : 'none';
                fileList.style.display = isLoading ? 'none' : 'block';
                if (isLoading) emptyIndicator.style.display = 'none';
            }

            function renderBreadcrumbs() {
                breadcrumbs.innerHTML = '';
                const parts = appState.path.split('/').filter(p => p);
                let currentPath = \`/\${appState.driveId}:/\`;
                const rootLink = document.createElement('a');
                rootLink.href = currentPath;
                rootLink.textContent = '根目录';
                rootLink.dataset.path = '/';
                breadcrumbs.appendChild(rootLink);
                
                let cumulativePath = '/';
                parts.forEach(part => {
                    cumulativePath += part + '/';
                    const separator = document.createElement('span');
                    separator.className = 'separator';
                    separator.textContent = ' / ';
                    breadcrumbs.appendChild(separator);
                    const partLink = document.createElement('a');
                    partLink.href = \`/\${appState.driveId}:\${cumulativePath}\`;
                    partLink.textContent = part;
                    partLink.dataset.path = cumulativePath;
                    breadcrumbs.appendChild(partLink);
                });
            }

            function getFileIcon(file) {
                if (file.mimeType === 'application/vnd.google-apps.folder') return ICONS.folder;
                if (file.mimeType.startsWith('image/')) return ICONS.image;
                if (file.mimeType.startsWith('video/')) return ICONS.video;
                if (file.mimeType.startsWith('audio/')) return ICONS.audio;
                return ICONS.file;
            }

            function formatBytes(bytes, decimals = 2) {
                if (!+bytes) return '0 Bytes'
                const k = 1024;
                const dm = decimals < 0 ? 0 : decimals;
                const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
                const i = Math.floor(Math.log(bytes) / Math.log(k));
                return \`\${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} \${sizes[i]}\`;
            }
            
            function formatDate(dateString) {
                return new Date(dateString).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
            }

            function renderFiles(files) {
                fileList.innerHTML = '';
                if (!files || files.length === 0) {
                    emptyIndicator.style.display = 'block';
                    return;
                }
                emptyIndicator.style.display = 'none';
                
                files.sort((a, b) => {
                    const isAFolder = a.mimeType === 'application/vnd.google-apps.folder';
                    const isBFolder = b.mimeType === 'application/vnd.google-apps.folder';
                    if (isAFolder && !isBFolder) return -1;
                    if (!isAFolder && isBFolder) return 1;
                    return a.name.localeCompare(b.name, undefined, { numeric: true });
                });
                
                files.forEach(file => {
                    const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
                    const li = document.createElement('li');
                    const link = document.createElement('a');

                    const finalFilePath = file.path ? file.path : (appState.path + file.name + (isFolder ? '/' : ''));

                    link.href = \`/\${appState.driveId}:\${finalFilePath}\`;
                    link.className = 'file-item';

                    if (isFolder) {
                        link.classList.add('folder');
                        link.dataset.path = finalFilePath;
                    }

                    link.innerHTML = \`<span class="icon">\${getFileIcon(file)}</span><span class="name">\${file.name}</span><span class="size">\${file.size ? formatBytes(parseInt(file.size)) : '-'}</span><span class="date">\${formatDate(file.modifiedTime)}</span>\`;
                    li.appendChild(link);
                    fileList.appendChild(li);
                });
            }
            
            async function navigateTo(path, pushState = true) {
                if (appState.isLoading) return;
                
                appState.path = path;
                if (pushState) {
                    const url = \`/\${appState.driveId}:\${path}\`;
                    window.history.pushState({ driveId: appState.driveId, path: path }, '', url);
                }
                renderBreadcrumbs();
                
                const result = await apiFetch('/api/list', { path });
                if (result && result.data) {
                    renderFiles(result.data.files);
                } else {
                    renderFiles([]);
                }
            }

            async function performSearch(query) {
                if (appState.isLoading || !query) return;
                appState.path = \`搜索结果: "\${query}"\`;
                const url = \`/\${appState.driveId}:/?q=\${encodeURIComponent(query)}\`;
                window.history.pushState({ driveId: appState.driveId, path: '/', search: query }, '', url);

                breadcrumbs.innerHTML = \`<a href="/\${appState.driveId}:/">根目录</a><span class="separator"> / </span><span>\${appState.path}</span>\`;
                
                // 显示搜索提示
                if (!loadingIndicator.querySelector('.search-hint')) {
                    const hint = document.createElement('div');
                    hint.className = 'search-hint';
                    hint.style.cssText = 'margin-top: 1rem; font-size: 0.9rem; color: #6c757d;';
                    hint.textContent = '首次搜索需要扫描整个云盘，请耐心等待...';
                    loadingIndicator.appendChild(hint);
                }
                
                const result = await apiFetch('/api/search', { q: query });
                if (result && result.data) {
                    renderFiles(result.data.files);
                    
                    // 显示缓存信息
                    if (result.data.cache_info) {
                        const info = result.data.cache_info;
                        console.log(\`搜索完成: 总文件 \${info.total_files} 个，匹配 \${info.filtered_count} 个，缓存时间: \${info.cache_timestamp}\`);
                    }
                } else {
                    renderFiles([]);
                }
            }
            
            fileList.addEventListener('click', e => {
                const link = e.target.closest('a.file-item');
                if (link && link.classList.contains('folder')) {
                    e.preventDefault();
                    navigateTo(link.dataset.path);
                }
            });
            
            breadcrumbs.addEventListener('click', e => {
                const link = e.target.closest('a');
                if (link && link.dataset.path) {
                    e.preventDefault();
                    navigateTo(link.dataset.path);
                }
            });

            driveSelector.addEventListener('change', () => {
                appState.driveId = driveSelector.value;
                searchInput.value = '';
                navigateTo('/');
            });

            searchForm.addEventListener('submit', e => {
                e.preventDefault();
                const query = searchInput.value.trim();
                if (query) performSearch(query);
            });

            window.addEventListener('popstate', e => {
                if (e.state) {
                    appState.driveId = e.state.driveId;
                    driveSelector.value = appState.driveId;
                    if (e.state.search) {
                         searchInput.value = e.state.search;
                         performSearch(e.state.search);
                    } else {
                         searchInput.value = '';
                         navigateTo(e.state.path || '/', false);
                    }
                }
            });

            function applyTheme(theme) {
                document.documentElement.dataset.theme = theme;
                localStorage.setItem('theme', theme);
                themeToggle.querySelector('span:first-child').textContent = theme === 'dark' ? '☀️' : '🌓';
            }
            themeToggle.addEventListener('click', () => {
                const newTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
                applyTheme(newTheme);
            });

            settingsButton.addEventListener('click', (e) => {
                e.stopPropagation();
                settingsMenu.classList.toggle('show');
            });
            
            document.addEventListener('click', () => settingsMenu.classList.remove('show'));

            refreshButton.addEventListener('click', async () => {
                if (appState.isLoading) return;
                
                const originalText = refreshButton.querySelector('span:last-child').textContent;
                refreshButton.querySelector('span:last-child').textContent = '刷新中...';
                refreshButton.disabled = true;

                const result = await apiFetch('/api/refresh', { path: appState.path });
                
                if (result && result.success) {
                    await navigateTo(appState.path, false);
                } else {
                    alert('刷新失败，请稍后再试。');
                }

                refreshButton.querySelector('span:last-child').textContent = originalText;
                refreshButton.disabled = false;
                settingsMenu.classList.remove('show');
            });

            function initialize() {
                config.drives.forEach((name, index) => {
                    const option = document.createElement('option');
                    option.value = index;
                    option.textContent = name;
                    driveSelector.appendChild(option);
                });
                driveSelector.value = config.driveId;
                searchInput.value = config.searchQuery;
                applyTheme(localStorage.getItem('theme') || 'light');
                
                if (config.searchQuery) {
                    performSearch(config.searchQuery);
                } else {
                    navigateTo(config.initialPath, false);
                }
            }

            initialize();
        })();
    </script>
</body>
</html>`;
}

// --- REFACTORED FILE PREVIEW PAGE ---
async function renderFilePageHTML(driveId, file, filePath, url) {
    const fileName = file.name;
    const isVideo = file.mimeType.startsWith('video/');
    const isAudio = file.mimeType.startsWith('audio/');
    const isImage = file.mimeType.startsWith('image/');
    
    const directViewUrl = `${url.pathname}?a=view`;
    const directDownloadUrl = `${url.pathname}?a=down`;
    const fullDownloadUrl = `${url.origin}${directDownloadUrl}`;

    let mediaElement = '';
    if (isVideo) {
        mediaElement = `<video id="player" playsinline controls data-poster="" style="--plyr-color-main: #007bff;"><source src="${directViewUrl}" type="${file.mimeType}" /></video>`;
    } else if (isAudio) {
        mediaElement = `<audio id="player" controls><source src="${directViewUrl}" type="${file.mimeType}" /></audio>`;
    } else if (isImage) {
        mediaElement = `<div class="image-container"><img src="${directViewUrl}" alt="${fileName}"></div>`;
    }

    // Generate breadcrumbs HTML
    const pathParts = filePath.split('/').filter(p => p && p !== fileName);
    let cumulativePath = '';
    const breadcrumbsHtml = `
        <a href="/${driveId}:/">根目录</a>
        ${pathParts.map(part => {
            cumulativePath += `/${part}`;
            return `<span>/</span><a href="/${driveId}:${cumulativePath}/">${part}</a>`;
        }).join('')}
        <span>/</span>
        <span>${fileName}</span>
    `;

    return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${fileName} - ${authConfig.siteName}</title>
    <link rel="icon" href="/favicon.ico">
    <link rel="stylesheet" href="https://cdn.plyr.io/3.7.8/plyr.css" />
    <style>
        :root {
            --primary-color: #007bff;
            --bg-color: #f0f2f5;
            --card-bg-color: #ffffff;
            --text-color: #1a1d21;
            --text-muted-color: #6c757d;
            --border-color: #dee2e6;
            --shadow-color: rgba(0,0,0,0.1);
        }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; 
            margin: 0; 
            background-color: var(--bg-color); 
            color: var(--text-color);
        }
        .container { 
            max-width: 1000px; 
            margin: 1.5rem auto; 
            padding: 1.5rem;
        }
        .card {
            background-color: var(--card-bg-color); 
            border-radius: 8px; 
            box-shadow: 0 4px 12px var(--shadow-color);
            overflow: hidden;
        }
        .player-container {
            background-color: #000;
        }
        .image-container {
            padding: 1rem;
            text-align: center;
        }
        .image-container img {
            max-width: 100%;
            max-height: 75vh;
            border-radius: 4px;
        }
        .file-info {
            padding: 1.5rem;
        }
        .breadcrumbs {
            font-size: 0.9rem;
            color: var(--text-muted-color);
            margin-bottom: 1rem;
            white-space: nowrap;
            overflow-x: auto;
            -webkit-overflow-scrolling: touch;
            scrollbar-width: thin;
        }
        .breadcrumbs a {
            color: var(--primary-color);
            text-decoration: none;
        }
        .breadcrumbs a:hover {
            text-decoration: underline;
        }
        .breadcrumbs span {
            margin: 0 0.5rem;
        }
        h1 { 
            font-size: 1.8rem; 
            margin: 0 0 0.5rem; 
            word-break: break-all; 
        }
        .file-meta { 
            font-size: 0.9rem; 
            color: var(--text-muted-color); 
            margin-bottom: 1.5rem; 
        }
        .actions { 
            display: flex; 
            flex-wrap: wrap; 
            gap: 0.75rem; 
        }
        .btn, .dropdown-toggle {
            display: inline-flex; align-items: center; gap: 0.5rem; 
            padding: 0.6rem 1.2rem; border-radius: 6px; 
            text-decoration: none; font-size: 0.95rem; font-weight: 500; 
            cursor: pointer; transition: all 0.2s;
            border: 1px solid transparent;
        }
        .btn-primary { 
            background-color: var(--primary-color); 
            color: white; 
        }
        .btn-primary:hover { background-color: #0056b3; }
        .btn-secondary { 
            background-color: #e9ecef; 
            color: #343a40; 
            border-color: #dee2e6;
        }
        .btn-secondary:hover { background-color: #d1d5db; }
        .dropdown {
            position: relative;
            display: inline-block;
        }
        .dropdown-menu {
            display: none;
            position: absolute;
            bottom: 100%;
            left: 0;
            margin-bottom: 0.5rem;
            background-color: var(--card-bg-color);
            border-radius: 6px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            min-width: 160px;
            z-index: 10;
            overflow: hidden;
            border: 1px solid var(--border-color);
        }
        .dropdown-menu.show {
            display: block;
        }
        .dropdown-item {
            display: block;
            padding: 0.75rem 1rem;
            color: var(--text-color);
            text-decoration: none;
        }
        .dropdown-item:hover {
            background-color: #f8f9fa;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="card">
            ${mediaElement ? `<div class="player-container">${mediaElement}</div>` : ''}
            <div class="file-info">
                <div class="breadcrumbs">${breadcrumbsHtml}</div>
                <h1>${fileName}</h1>
                <p class="file-meta">
                    <span>修改于: ${new Date(file.modifiedTime).toLocaleString()}</span> | 
                    <span>大小: ${file.size ? (parseInt(file.size)/(1024*1024)).toFixed(2) + ' MB' : 'N/A'}</span>
                </p>
                <div class="actions">
                    <a href="${directDownloadUrl}" class="btn btn-primary" download><span>📥</span><span>直接下载</span></a>
                    <button id="copy-link-btn" class="btn btn-secondary"><span>🔗</span><span>复制链接</span></button>
                    ${isVideo || isAudio ? `
                    <div class="dropdown">
                        <button id="external-player-btn" class="btn btn-secondary dropdown-toggle"><span>🚀</span><span>外部播放器</span></button>
                        <div id="external-player-menu" class="dropdown-menu">
                            <a href="potplayer://${fullDownloadUrl}" class="dropdown-item">PotPlayer</a>
                            <a href="vlc://${fullDownloadUrl}" class="dropdown-item">VLC</a>
                            <a href="nplayer-${fullDownloadUrl}" class="dropdown-item">nPlayer</a>
                        </div>
                    </div>` : ''}
                </div>
            </div>
        </div>
    </div>

    <script src="https://cdn.plyr.io/3.7.8/plyr.js"></script>
    <script>
        // Initialize Plyr player if it exists
        const playerElement = document.getElementById('player');
        if (playerElement) {
            const player = new Plyr(playerElement);
        }

        // Clipboard copy functionality
        document.getElementById('copy-link-btn').addEventListener('click', (e) => {
            const linkToCopy = '${fullDownloadUrl}';
            navigator.clipboard.writeText(linkToCopy).then(() => {
                e.target.innerText = '✅ 已复制!';
                setTimeout(() => { e.target.innerHTML = '<span>🔗</span><span>复制链接</span>' }, 2000);
            }, (err) => {
                alert('复制失败，请手动复制。');
                console.error('Could not copy text: ', err);
            });
        });

        // Dropdown menu functionality
        const dropdownBtn = document.getElementById('external-player-btn');
        const dropdownMenu = document.getElementById('external-player-menu');
        if (dropdownBtn) {
            dropdownBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                dropdownMenu.classList.toggle('show');
            });
            document.addEventListener('click', () => {
                if (dropdownMenu.classList.contains('show')) {
                    dropdownMenu.classList.remove('show');
                }
            });
        }
    </script>
</body>
</html>`;
}

// ===============================================================
// ADMIN PANEL MODULE
// ===============================================================

async function handleAdminRouter(request) {
    const adminPass = typeof ADMIN_PASS !== 'undefined' ? ADMIN_PASS : null;

    if (!adminPass) {
        return new Response("Admin function is disabled: ADMIN_PASS is not set.", {
            status: 503, 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
    }

    const url = new URL(request.url);
    
    // 处理登录验证
    if (request.method === 'POST' && url.searchParams.get('action') === 'login') {
        const formData = await request.formData();
        const password = formData.get('admin_password');
        
        if (password === adminPass) {
            // 设置认证 cookie，有效期1小时
            const cookieValue = `admin_auth=${btoa(adminPass + ':' + Date.now())}; HttpOnly; Secure; SameSite=Strict; Max-Age=3600; Path=/admin`;
            return new Response(null, {
                status: 302,
                headers: {
                    'Location': url.origin + '/admin/',
                    'Set-Cookie': cookieValue
                }
            });
        } else {
            return new Response(getAdminLoginPage('密码错误，请重新输入。'), { 
                status: 401, 
                headers: { 'Content-Type': 'text/html; charset=utf-8' } 
            });
        }
    }
    
    // 检查认证状态
    const authCookie = request.headers.get('Cookie')?.match(/admin_auth=([^;]+)/)?.[1];
    let isAuthenticated = false;
    
    if (authCookie) {
        try {
            const decoded = atob(authCookie);
            const [cookiePass, timestamp] = decoded.split(':');
            const now = Date.now();
            // 检查密码正确且未过期（1小时）
            if (cookiePass === adminPass && (now - parseInt(timestamp)) < 3600000) {
                isAuthenticated = true;
            }
        } catch (e) {
            // Cookie 解析失败，需要重新登录
        }
    }
    
    // 如果未认证，显示登录页面
    if (!isAuthenticated) {
        return new Response(getAdminLoginPage(), { 
            headers: { 'Content-Type': 'text/html; charset=utf-8' } 
        });
    }

    // 处理清理操作（已认证用户）
    if (request.method === 'POST') {
        return await handleAdminPost(request, adminPass);
    }

    if (request.method === 'GET') {
        return new Response(getAdminDashboardPage(), { 
            headers: { 'Content-Type': 'text/html; charset=utf-8' } 
        });
    }

    return new Response("Method Not Allowed", { status: 405 });
}

async function handleAdminPost(request, adminPass) {
    const formData = await request.formData();
    const driveIndex = formData.get('driveIndex');

    if (driveIndex === null) {
        return new Response(getAdminDashboardPage('错误: 未选择云盘。', true), { 
            status: 400, 
            headers: { 'Content-Type': 'text/html; charset=utf-8' } 
        });
    }

    const result = await clearKVCache(driveIndex);
    const message = `${result.message}<br><br>页面将在3秒后自动刷新。 <script>setTimeout(() => window.location.reload(), 3000);</script>`;
    
    return new Response(getAdminDashboardPage(message, !result.success), {
        status: result.success ? 200 : 500,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
}

function getAdminLoginPage(errorMessage = null) {
    return `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>管理员登录 - GoIndex</title>
        <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            
            body {
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 1rem;
            }
            
            .login-container {
                background: white;
                border-radius: 12px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.1);
                padding: 3rem;
                width: 100%;
                max-width: 400px;
                text-align: center;
            }
            
            .login-header {
                margin-bottom: 2rem;
            }
            
            .login-header h1 {
                color: #333;
                margin-bottom: 0.5rem;
                font-size: 1.8rem;
            }
            
            .login-header p {
                color: #666;
                font-size: 0.95rem;
            }
            
            .form-group {
                margin-bottom: 1.5rem;
                text-align: left;
            }
            
            label {
                display: block;
                font-weight: 600;
                margin-bottom: 0.5rem;
                color: #333;
            }
            
            input[type="password"] {
                width: 100%;
                padding: 0.875rem;
                border: 2px solid #e0e0e0;
                border-radius: 8px;
                font-size: 1rem;
                transition: border-color 0.3s ease;
            }
            
            input[type="password"]:focus {
                outline: none;
                border-color: #667eea;
                box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
            }
            
            .login-btn {
                width: 100%;
                padding: 0.875rem;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                border: none;
                border-radius: 8px;
                font-size: 1rem;
                font-weight: 600;
                cursor: pointer;
                transition: transform 0.2s ease;
            }
            
            .login-btn:hover {
                transform: translateY(-1px);
            }
            
            .login-btn:active {
                transform: translateY(0);
            }
            
            .error-message {
                background: #fee;
                color: #c33;
                padding: 0.75rem;
                border-radius: 6px;
                margin-bottom: 1rem;
                font-size: 0.9rem;
                border: 1px solid #fcc;
            }
            
            .security-note {
                margin-top: 2rem;
                padding: 1rem;
                background: #f8f9fa;
                border-radius: 6px;
                font-size: 0.85rem;
                color: #666;
                border-left: 4px solid #007bff;
            }
        </style>
    </head>
    <body>
        <div class="login-container">
            <div class="login-header">
                <h1>🔐 管理员验证</h1>
                <p>请输入管理员密码以访问控制面板</p>
            </div>
            
            ${errorMessage ? `<div class="error-message">❌ ${errorMessage}</div>` : ''}
            
            <form method="post" action="/admin/?action=login">
                <div class="form-group">
                    <label for="admin_password">管理员密码:</label>
                    <input type="password" id="admin_password" name="admin_password" required autofocus>
                </div>
                <button type="submit" class="login-btn">🚀 进入管理面板</button>
            </form>
            
            <div class="security-note">
                <strong>🛡️ 安全提示:</strong><br>
                登录会话将在1小时后自动过期，请妥善保管您的密码。
            </div>
        </div>
    </body>
    </html>`;
}

// --- REFACTORED ADMIN DASHBOARD ---
function getAdminDashboardPage(message = null, isError = false) {
    const messageHtml = message ? `<div class="message ${isError ? 'error' : 'success'}">${message}</div>` : '';

    // The entire HTML, CSS, and JS are now in a single, clean template literal.
    // This is more robust for the Cloudflare Worker environment.
    return `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>GoIndex 管理面板</title>
        <style>
            :root {
                --primary-color: #007bff; --success-color: #28a745; --danger-color: #dc3545;
                --warning-color: #ffc107; --info-color: #17a2b8; --light-color: #f8f9fa;
                --dark-color: #343a40; --border-color: #dee2e6; --border-radius: 8px;
                --box-shadow: 0 4px 12px rgba(0,0,0,0.1); --transition: all 0.3s ease;
            }
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body { 
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                background-color: #f4f7f9;
                min-height: 100vh; padding: 1rem;
            }
            .admin-container {
                background: white; border-radius: var(--border-radius);
                box-shadow: var(--box-shadow); width: 100%; max-width: 1200px;
                margin: 0 auto; overflow: hidden;
            }
            .header {
                background: var(--primary-color); color: white; padding: 1.5rem 2rem;
                display: flex; justify-content: space-between; align-items: center;
                flex-wrap: wrap; gap: 1rem;
            }
            .header-left h1 { font-size: 1.8rem; margin-bottom: 0.25rem; }
            .header-left p { opacity: 0.9; font-size: 1rem; }
            .header-right { display: flex; align-items: center; gap: 1rem; }
            .logout-btn {
                background: rgba(255,255,255,0.2); color: white; border: 1px solid rgba(255,255,255,0.3);
                padding: 0.5rem 1rem; border-radius: 6px; text-decoration: none;
                font-size: 0.9rem; transition: var(--transition);
            }
            .logout-btn:hover { background: rgba(255,255,255,0.3); }
            .content { padding: 2rem; }
            .section { margin-bottom: 2.5rem; }
            .section-title {
                font-size: 1.4rem; font-weight: 700; margin-bottom: 1.5rem;
                color: var(--dark-color); display: flex; align-items: center;
                justify-content: space-between; flex-wrap: wrap; gap: 1rem;
                border-bottom: 2px solid var(--border-color); padding-bottom: 0.75rem;
            }
            .section-title-left { display: flex; align-items: center; gap: 0.75rem; }
            .status-loading {
                display: flex; align-items: center; justify-content: center;
                gap: 1rem; padding: 3rem; color: #666;
            }
            .spinner {
                width: 32px; height: 32px; border: 4px solid #f3f3f3;
                border-top: 4px solid var(--primary-color); border-radius: 50%;
                animation: spin 1s linear infinite;
            }
            @keyframes spin { 100% { transform: rotate(360deg); } }
            
            /* --- REFACTORED GRID LAYOUT --- */
            #drive-management-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
                gap: 1.5rem;
            }
            .drive-card {
                background: white; border: 1px solid var(--border-color);
                border-radius: var(--border-radius); padding: 1.25rem;
                transition: var(--transition); position: relative;
                box-shadow: 0 2px 8px rgba(0,0,0,0.05);
                display: flex; flex-direction: column;
            }
            .drive-card:hover {
                transform: translateY(-3px);
                box-shadow: 0 6px 16px rgba(0,0,0,0.1);
                border-color: var(--primary-color);
            }
            .drive-card.next-cron {
                border-color: var(--warning-color);
                background: #fffaf0;
            }
            .drive-card.next-cron::before {
                content: "⏰ 下次更新"; position: absolute; top: 0.5rem; right: 0.75rem;
                background: var(--warning-color); color: #333; padding: 0.2rem 0.6rem;
                border-radius: 20px; font-size: 0.7rem; font-weight: 600;
            }
            .drive-header { display: flex; align-items: center; margin-bottom: 1rem; }
            .drive-icon {
                background: linear-gradient(135deg, var(--primary-color) 0%, #0056b3 100%);
                color: white; width: 40px; height: 40px; border-radius: 8px;
                display: flex; align-items: center; justify-content: center;
                font-size: 1.1rem; font-weight: bold; margin-right: 1rem;
                box-shadow: 0 2px 6px rgba(0,123,255,0.3); flex-shrink: 0;
            }
            .drive-name {
                font-weight: 600; font-size: 1.1rem; color: var(--dark-color);
                line-height: 1.3; overflow: hidden; text-overflow: ellipsis;
            }
            .cache-info {
                font-size: 0.85rem; margin-bottom: 1rem;
                border-top: 1px solid var(--border-color);
                border-bottom: 1px solid var(--border-color);
                padding: 0.75rem 0;
            }
            .info-item { display: flex; justify-content: space-between; padding: 0.25rem 0; }
            .info-label { font-weight: 600; color: #555; }
            .info-value { color: var(--dark-color); }
            .info-value.cached { color: var(--success-color); font-weight: bold; }
            .info-value.not-cached { color: var(--danger-color); font-weight: bold; }
            .drive-actions { margin-top: auto; display: flex; gap: 0.75rem; }
            .btn {
                flex: 1; display: flex; align-items: center; justify-content: center;
                gap: 0.5rem; padding: 0.6rem 1rem; border-radius: 6px;
                font-size: 0.85rem; font-weight: 600; text-decoration: none;
                cursor: pointer; transition: var(--transition); border: 1px solid;
            }
            .btn-danger {
                background-color: #fff2f2; color: var(--danger-color); border-color: #ffcccc;
            }
            .btn-danger:hover { background-color: var(--danger-color); color: white; }
            .btn-update {
                background-color: #f0f9ff; color: var(--primary-color); border-color: #cce5ff;
            }
            .btn-update:hover { background-color: var(--primary-color); color: white; }
            .message {
                padding: 1.25rem 1.5rem; border-radius: var(--border-radius);
                margin-bottom: 2rem; font-weight: 500; display: flex;
                align-items: center; gap: 0.75rem; border: 1px solid;
            }
            .message.success {
                background: #d4edda; color: #155724; border-color: #c3e6cb;
            }
            .message.error {
                background: #f8d7da; color: #721c24; border-color: #f5c6cb;
            }
            .refresh-btn {
                background: var(--info-color); color: white; border: none;
                padding: 0.5rem 1rem; border-radius: 20px; cursor: pointer;
                font-size: 0.9rem; font-weight: 600; transition: var(--transition);
                display: flex; align-items: center; gap: 0.5rem;
            }
            .refresh-btn:hover { background: #138496; transform: scale(1.05); }
            @media (max-width: 768px) {
                .content { padding: 1rem; }
                .header { padding: 1rem; flex-direction: column; text-align: center; }
                #drive-management-grid { grid-template-columns: 1fr; }
            }
        </style>
    </head>
    <body>
        <div class="admin-container">
            <div class="header">
                <div class="header-left">
                    <h1>🚀 GoIndex 管理面板</h1>
                    <p>缓存管理和系统监控</p>
                </div>
                <div class.header-right">
                    <a href="/" class="logout-btn">📱 返回首页</a>
                    <a href="#" onclick="logout()" class="logout-btn">🚪 退出登录</a>
                </div>
            </div>
            
            <div class="content">
                ${messageHtml}
                
                <div class="section">
                    <div id="status-container">
                        <div class="status-loading">
                            <div class="spinner"></div>
                            <span>正在加载系统状态...</span>
                        </div>
                    </div>
                </div>
                
                <div class="section">
                    <div class="section-title">
                        <div class="section-title-left">
                            <span>💾</span>
                            <h3>云盘管理</h3>
                        </div>
                        <button class="refresh-btn" onclick="refreshCacheStatus()">
                            <span>🔄</span>
                            <span>刷新状态</span>
                        </button>
                    </div>
                    <div id="drive-management-grid">
                        <div class="status-loading">
                            <div class="spinner"></div>
                            <span>正在加载云盘列表...</span>
                        </div>
                    </div>
                    <form method="POST" onsubmit="return confirm('确定要清理所有云盘的缓存吗？\\n此操作不可恢复！');" style="margin-top: 1.5rem;">
                        <input type="hidden" name="driveIndex" value="all">
                        <button type="submit" class="btn btn-danger" style="width: 100%; padding: 0.8rem;">🗑️ 清理所有缓存</button>
                    </form>
                </div>
            </div>
        </div>

        <script>
            // --- REFACTORED SCRIPT ---
            // This script is now cleaner and only handles data logic.
            // All layout and styling are handled by CSS.
            
            let cacheStatusData = null;

            function logout() {
                if (confirm('确定要退出登录吗？')) {
                    document.cookie = 'admin_auth=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/admin';
                    window.location.href = '/admin/';
                }
            }
            
            function refreshCacheStatus() {
                const loadingHtml = '<div class="status-loading"><div class="spinner"></div><span>正在刷新...</span></div>';
                document.getElementById('status-container').innerHTML = loadingHtml;
                document.getElementById('drive-management-grid').innerHTML = loadingHtml;
                loadCacheStatus();
            }

            function createDriveCardHTML(drive) {
                const hasCache = drive.hasCache;
                const statusText = hasCache ? '已缓存' : '无缓存';
                const statusClass = hasCache ? 'cached' : 'not-cached';
                const cacheTime = drive.cacheTime ? new Date(drive.cacheTime).toLocaleString('zh-CN') : '从未';
                const nextCronClass = drive.isNextCron ? 'next-cron' : '';

                return \`
                <div class="drive-card \${nextCronClass}">
                    <div class="drive-header">
                        <div class="drive-icon">\${drive.index}</div>
                        <div class="drive-name-wrapper">
                            <div class="drive-name">\${drive.name}</div>
                        </div>
                    </div>
                    <div class="cache-info">
                        <div class="info-item">
                            <span class="info-label">状态:</span>
                            <span class="info-value \${statusClass}">\${statusText}</span>
                        </div>
                        <div class="info-item">
                            <span class="info-label">文件数:</span>
                            <span class="info-value">\${drive.fileCount.toLocaleString()}</span>
                        </div>
                        <div class="info-item">
                            <span class="info-label">更新于:</span>
                            <span class="info-value">\${cacheTime}</span>
                        </div>
                    </div>
                    <div class="drive-actions">
                        <form method="POST" onsubmit="return confirm('确定要清理云盘 \${drive.name} 的缓存吗？');" style="flex: 1;">
                            <input type="hidden" name="driveIndex" value="\${drive.index}">
                            <button type="submit" class="btn btn-danger">🗑️ 清理</button>
                        </form>
                        <form method="POST" onsubmit="return confirm('确定要强制更新云盘 \${drive.name} 的缓存吗？');" action="/api/force-update" style="flex: 1;">
                             <input type="hidden" name="driveIndex" value="\${drive.index}">
                             <button type="button" onclick="forceUpdateCache(this.form)" class="btn btn-update">🔄 更新</button>
                        </form>
                    </div>
                </div>\`;
            }
            
            function createStatusPanelHTML(data) {
                const { drives, nextCronDrive, cronUpdateHour, currentTime, cacheConfig } = data;
                const totalDrives = drives.length;
                const cachedDrives = drives.filter(d => d.hasCache).length;
                const totalFiles = drives.reduce((sum, d) => sum + d.fileCount, 0);

                return \`
                <div class="section-title">
                    <div class="section-title-left">
                        <span>📊</span>
                        <h3>系统状态总览</h3>
                    </div>
                </div>
                <div id="drive-management-grid" style="grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));">
                     <div class="drive-card"><div class="cache-info" style="border:none; margin:0; padding:0;">
                        <div class="info-item"><span class="info-label">总云盘数:</span><span class="info-value">\${totalDrives}</span></div>
                        <div class="info-item"><span class="info-label">已缓存云盘:</span><span class="info-value">\${cachedDrives}</span></div>
                        <div class="info-item"><span class="info-label">总文件数:</span><span class="info-value">\${totalFiles.toLocaleString()}</span></div>
                     </div></div>
                     <div class="drive-card"><div class="cache-info" style="border:none; margin:0; padding:0;">
                        <div class="info-item"><span class="info-label">当前时间:</span><span class="info-value">\${new Date(currentTime).toLocaleTimeString('zh-CN')}</span></div>
                        <div class="info-item"><span class="info-label">下次定时更新:</span><span class="info-value">云盘 \${nextCronDrive}</span></div>
                        <div class="info-item"><span class="info-label">更新时间:</span><span class="info-value">每日 \${cronUpdateHour}:00 (UTC+8)</span></div>
                     </div></div>
                     <div class="drive-card"><div class="cache-info" style="border:none; margin:0; padding:0;">
                        <div class="info-item"><span class="info-label">浏览缓存TTL:</span><span class="info-value">\${Math.round(cacheConfig.browsing_ttl/3600)} 小时</span></div>
                        <div class="info-item"><span class="info-label">Cron缓存TTL:</span><span class="info-value">\${Math.round(cacheConfig.cron_ttl/3600)} 小时</span></div>
                     </div></div>
                </div>
                \`;
            }

            async function loadCacheStatus() {
                try {
                    const response = await fetch('/api/cache-status');
                    if (!response.ok) throw new Error('API request failed with status ' + response.status);
                    
                    cacheStatusData = await response.json();
                    if (cacheStatusData.error) throw new Error(cacheStatusData.error);

                    const statusContainer = document.getElementById('status-container');
                    const gridContainer = document.getElementById('drive-management-grid');
                    
                    statusContainer.innerHTML = createStatusPanelHTML(cacheStatusData);
                    gridContainer.innerHTML = cacheStatusData.drives.map(createDriveCardHTML).join('');

                } catch (error) {
                    console.error('加载缓存状态失败:', error);
                    const errorMsg = '<div style="color: var(--danger-color); text-align: center; padding: 2rem;">❌ 加载状态失败: ' + error.message + '</div>';
                    document.getElementById('status-container').innerHTML = errorMsg;
                    document.getElementById('drive-management-grid').innerHTML = '';
                }
            }

            async function forceUpdateCache(form) {
                const driveIndex = form.querySelector('[name=driveIndex]').value;
                const button = form.querySelector('button');
                const originalHTML = button.innerHTML;
                button.disabled = true;
                button.innerHTML = '<span>⏳</span><span>更新中...</span>';

                try {
                    const response = await fetch('/api/force-update', {
                        method: 'POST',
                        body: new FormData(form)
                    });
                    const result = await response.json();
                    if (result.success) {
                        alert(\`强制更新成功！\\n\\n\${result.message}\`);
                        refreshCacheStatus();
                    } else {
                        throw new Error(result.message);
                    }
                } catch (error) {
                    alert('强制更新失败: ' + error.message);
                } finally {
                    button.disabled = false;
                    button.innerHTML = originalHTML;
                }
            }
            
            // Initial load
            document.addEventListener('DOMContentLoaded', loadCacheStatus);
        </script>
    </body>
    </html>`;
}


async function clearKVCache(driveIndex) {
    if (typeof GD_INDEX_CACHE === 'undefined') {
        return { success: false, message: "KV Namespace 'GD_INDEX_CACHE' is not bound." };
    }
    
    try {
        let totalKeysDeleted = 0;
        const prefixesToDelete = [];

        if (driveIndex === 'all') {
            prefixesToDelete.push('');
            await GD_INDEX_CACHE.delete(CONSTS.CRON_NEXT_DRIVE_INDEX_KEY);
        } else {
            const index = parseInt(driveIndex, 10);
            if (isNaN(index) || index < 0 || index >= authConfig.roots.length) {
                return { success: false, message: "无效的云盘索引。" };
            }
            ['file', 'list', 'all_files', 'search', 'path_by_id', 'dirid'].forEach(type => {
                prefixesToDelete.push(`${type}:${index}:`);
            });
        }
        
        for (const prefix of prefixesToDelete) {
             let listComplete = false;
             let cursor = undefined;
             while(!listComplete){
                const list = await GD_INDEX_CACHE.list({ prefix, cursor, limit: 1000 });
                const keys = list.keys.map(key => key.name);
                if(keys.length > 0){
                    await Promise.all(keys.map(key => GD_INDEX_CACHE.delete(key)));
                }
                totalKeysDeleted += keys.length;
                listComplete = list.list_complete;
                cursor = list.cursor;
             }
        }
        
        const driveName = driveIndex === 'all' ? '所有云盘' : `云盘 ${driveIndex} (${authConfig.roots[driveIndex].name})`;
        return { success: true, message: `成功为 ${driveName} 删除了 ${totalKeysDeleted} 个缓存键。` };

    } catch (e) {
        console.error("KV Cache Clearing Error:", e);
        return { success: false, message: `清理KV缓存失败: ${e.message}` };
    }
}

// ===============================================================
// HTTP ROUTING MODULE
// ===============================================================

async function handleRequest(request) {
    const configError = getConfigError();
    if (configError) {
        return new Response(configError, {
            status: 503,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
    }
    
    if (!authConfig.roots || authConfig.roots.length === 0) {
        return new Response(
            "配置错误: 'DRIVE_ROOTS' 已加载但为空数组。请至少添加一个云盘配置。", {
                status: 503,
                headers: { "Content-Type": "text/plain; charset=utf-8" },
            }
        );
    }
    
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    const urlParams = url.searchParams;

    if (path === '/admin' || path.startsWith('/admin/')) {
        return handleAdminRouter(request);
    }
    
    if (path.startsWith('/api/')) {
        if (path === '/api/cache-status') {
            const cacheStatus = await getCacheStatus();
            return jsonResponse(cacheStatus);
        }
        
        if (path === '/api/force-update' && request.method === 'POST') {
            const formData = await request.formData();
            return await handleForceUpdate(formData);
        }
        
        return handleApiRouter(request);
    }
    
    if (path === '/favicon.ico') {
        return Response.redirect("https://i.imgur.com/rOyuGjA.gif", 301);
    }
    
    if (path === '/') {
        return Response.redirect(`${url.origin}/${authConfig.default_gd || 0}:/`, 302);
    }

    const { driveId, filePath } = parsePath(path);
    
    if (driveId === null || driveId < 0 || driveId >= authConfig.roots.length) {
        return new Response('无效的云盘 ID。', { 
            status: 404, 
            headers: { "Content-Type": "text/plain; charset=utf-8" } 
        });
    }

    const gd = await getGoogleDrive(driveId);
    if (!gd) {
        return new Response(`云盘 ID ${driveId} 初始化失败。请检查您的配置。`, { 
            status: 500 
        });
    }
    
    const basicAuthResponse = gd.basicAuthResponse(request);
    if (basicAuthResponse) return basicAuthResponse;

    if (filePath.endsWith('/')) {
        return new Response(await renderHTML(driveId, filePath, urlParams, url), {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
    } 
    
    const file = await gd.file(filePath);
    if (!file) {
        return new Response('文件未找到。', { status: 404 });
    }
    
    const action = urlParams.get('a');
    if (action === 'view') {
        return gd.down(file.id, request.headers.get('Range'), true);
    }
    if (action === 'down') {
        return gd.down(file.id, request.headers.get('Range'), false);
    }

    // --- MODIFICATION: Pass filePath to renderFilePageHTML ---
    return new Response(await renderFilePageHTML(driveId, file, filePath, url), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
}

async function handleApiRouter(request) {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    const driveId = parseInt(url.searchParams.get('driveId'));

    if (isNaN(driveId) || driveId < 0 || driveId >= authConfig.roots.length) {
        return jsonResponse({ error: "缺少或无效的 'driveId' 参数" }, 400);
    }

    const gd = await getGoogleDrive(driveId);
    if (!gd) {
        return jsonResponse({ error: `云盘 ID ${driveId} 初始化失败` }, 500);
    }

    const basicAuthResponse = gd.basicAuthResponse(request);
    if (basicAuthResponse) return basicAuthResponse;
    
    switch (path) {
        case '/api/list':
            const dirPath = url.searchParams.get('path') || '/';
            const pageToken = url.searchParams.get('pageToken') || null;
            const pageIndex = parseInt(url.searchParams.get('pageIndex') || '0');
            const listResult = await gd.list(dirPath, pageToken, pageIndex);
            return jsonResponse(listResult);
        
        case '/api/search':
            const query = url.searchParams.get('q');
            const searchResult = await gd.search(query);
            return jsonResponse(searchResult);
        
        case '/api/id2path':
            const id = url.searchParams.get('id');
            if (!id) {
                return jsonResponse({ error: "缺少 'id' 参数" }, 400);
            }
            const filePath = await gd.findPathById(id);
            return jsonResponse({ path: filePath });
        
        case '/api/refresh':
            const pathToRefresh = url.searchParams.get('path');
            if (typeof pathToRefresh !== 'string') {
                return jsonResponse({ error: "Missing 'path' parameter" }, 400);
            }
            const result = await gd.clearPathCache(pathToRefresh);
            return jsonResponse(result);
        
        default:
            return jsonResponse({ error: "无效的 API 端点" }, 404);
    }
}

// ===============================================================
// CACHE STATUS FUNCTIONS
// ===============================================================

async function getCacheStatus() {
    if (typeof GD_INDEX_CACHE === 'undefined') {
        return { error: "KV namespace not available" };
    }

    const drives = [];
    const nextDriveIndex = await GD_INDEX_CACHE.get(CONSTS.CRON_NEXT_DRIVE_INDEX_KEY);
    
    for (let i = 0; i < authConfig.roots.length; i++) {
        const root = authConfig.roots[i];
        const driveInfo = {
            index: i,
            name: root.name,
            hasCache: false,
            cacheTime: null,
            fileCount: 0,
            isNextCron: parseInt(nextDriveIndex || '0') === i
        };

        try {
            const gd = await getGoogleDrive(i);
            if (!gd) continue;
            const cacheKey = `all_files:${i}:${gd.root.id}`;
            const cacheData = await gd._kv_get(cacheKey);
            
            if (cacheData && cacheData.files) {
                driveInfo.hasCache = true;
                driveInfo.cacheTime = cacheData.last_updated;
                driveInfo.fileCount = cacheData.files.length;
            }
        } catch (e) {
            console.warn(`获取驱动器 ${i} 缓存状态失败:`, e);
        }

        drives.push(driveInfo);
    }

    return {
        drives,
        nextCronDrive: parseInt(nextDriveIndex || '0'),
        cronUpdateHour: authConfig.cron_update_hour,
        currentTime: new Date().toISOString(),
        cacheConfig: {
            browsing_ttl: authConfig.browsing_cache_ttl,
            cron_ttl: authConfig.cron_cache_ttl
        }
    };
}

async function handleForceUpdate(formData) {
    try {
        const driveIndex = parseInt(formData.get('driveIndex'));
        
        if (isNaN(driveIndex) || driveIndex < 0 || driveIndex >= authConfig.roots.length) {
            return jsonResponse({ success: false, message: "无效的云盘索引" }, 400);
        }
        
        const gd = await getGoogleDrive(driveIndex, true); // 强制重新加载
        if (!gd) {
            return jsonResponse({ success: false, message: `云盘 ${driveIndex} 初始化失败` }, 500);
        }
        
        await gd.initRootType();
        if (gd.root_type === -1) {
            return jsonResponse({ success: false, message: `云盘 ${driveIndex} 根目录类型初始化失败` }, 500);
        }
        
        console.log(`[Force Update] Starting forced cache update for drive ${driveIndex} (${authConfig.roots[driveIndex].name})`);
        
        const cacheKey = `all_files:${driveIndex}:${gd.root.id}`;
        const startTime = new Date();
        
        const all_files = await gd.listAllFiles(gd.root.id);
        const newCacheObject = {
            files: all_files,
            last_updated: startTime.toISOString(),
            total_files: all_files.length,
            force_updated: true
        };
        
        await gd._kv_put(cacheKey, newCacheObject);
        
        console.log(`[Force Update] Successfully cached ${all_files.length} files for drive ${driveIndex}`);
        
        return jsonResponse({ 
            success: true, 
            message: `为云盘 ${driveIndex} (${authConfig.roots[driveIndex].name}) 缓存了 ${all_files.length} 个文件。`,
            fileCount: all_files.length,
            updateTime: startTime.toISOString()
        });
        
    } catch (error) {
        console.error('Force update error:', error);
        return jsonResponse({ 
            success: false, 
            message: `强制更新失败: ${error.message}` 
        }, 500);
    }
}

// ===============================================================
// SCHEDULED TASK (CRON) MODULE
// ===============================================================

async function handleScheduled(event) {
    const now = new Date();
    console.log(`[${now.toISOString()}] Cron job starting.`);

    if (typeof GD_INDEX_CACHE === 'undefined') {
        console.error(`[${now.toISOString()}] Cron job failed: KV namespace 'GD_INDEX_CACHE' is not bound.`);
        return;
    }
    
    const configError = getConfigError();
    if (configError || !authConfig.roots || !authConfig.roots.length) {
        console.warn(`[${now.toISOString()}] Cron job skipped: DRIVE_ROOTS not configured correctly. Error: ${configError || 'roots array is empty.'}`);
        return;
    }

    const utc8Offset = 8 * 3600 * 1000;
    const now_utc8 = new Date(now.getTime() + utc8Offset);
    const currentHour_utc8 = now_utc8.getUTCHours();
    const today_utc8_string = now_utc8.toISOString().split('T')[0];
    
    const driveIndexKey = CONSTS.CRON_NEXT_DRIVE_INDEX_KEY;
    const currentIndexStr = await GD_INDEX_CACHE.get(driveIndexKey);
    let currentIndex = currentIndexStr ? parseInt(currentIndexStr, 10) : 0;
    
    if (isNaN(currentIndex) || currentIndex >= authConfig.roots.length) {
        currentIndex = 0;
    }

    const driveId = currentIndex;
    const rootConfig = authConfig.roots[driveId];
    
    console.log(`[${now.toISOString()}] Processing drive ${driveId} (${rootConfig.name}).`);

    const gd = await getGoogleDrive(driveId, true);
    if (!gd) {
        console.error(`[${now.toISOString()}] Failed to initialize drive ${driveId} (${rootConfig.name}). Skipping.`);
        await advanceToNextDrive(driveId);
        return;
    }

    await gd.initRootType();
    if (gd.root_type === -1) {
        console.error(`[${now.toISOString()}] Failed to determine root type for drive ${driveId} (${rootConfig.name}). Skipping.`);
        await advanceToNextDrive(driveId);
        return;
    }
    
    const cacheKey = `all_files:${driveId}:${gd.root.id}`;
    const cacheObject = await gd._kv_get(cacheKey);

    if (await isCacheUpdatedToday(cacheObject, today_utc8_string, utc8Offset)) {
        console.log(`[${now.toISOString()}] Drive ${driveId} (${rootConfig.name}) already updated today. Skipping.`);
        await advanceToNextDrive(driveId);
        return;
    }

    if (cacheObject && currentHour_utc8 < authConfig.cron_update_hour) {
        console.log(`[${now.toISOString()}] It's before ${authConfig.cron_update_hour}:00 (UTC+8). Scheduled update for drive ${driveId} (${rootConfig.name}) postponed.`);
        return;
    }

    await updateDriveCache(gd, driveId, rootConfig, cacheKey, now);
    await advanceToNextDrive(driveId);
}

async function isCacheUpdatedToday(cacheObject, today_utc8_string, utc8Offset) {
    if (!cacheObject || !cacheObject.last_updated) {
        return false;
    }

    const lastUpdated_utc8 = new Date(new Date(cacheObject.last_updated).getTime() + utc8Offset);
    const lastUpdated_utc8_string = lastUpdated_utc8.toISOString().split('T')[0];

    return lastUpdated_utc8_string === today_utc8_string;
}

async function updateDriveCache(gd, driveId, rootConfig, cacheKey, startTime) {
    console.log(`[${startTime.toISOString()}] Checks passed for drive ${driveId} (${rootConfig.name}). Starting cache update.`);
    
    try {
        console.log(`[${startTime.toISOString()}] Listing all files for drive ${driveId} (${rootConfig.name})...`);
        const all_files = await gd.listAllFiles(gd.root.id);

        const newCacheObject = {
            files: all_files,
            last_updated: new Date().toISOString(),
            total_files: all_files.length
        };

        await gd._kv_put(cacheKey, newCacheObject);
        console.log(`[${startTime.toISOString()}] Successfully cached ${all_files.length} files for drive ${driveId} (${rootConfig.name}).`);

    } catch (e) {
        console.error(`[${startTime.toISOString()}] Unhandled error processing drive ${driveId} (${rootConfig.name}):`, e.message, e.stack);
    }
}

async function advanceToNextDrive(currentDriveId) {
    const nextIndex = (currentDriveId + 1) % authConfig.roots.length;
    await GD_INDEX_CACHE.put(CONSTS.CRON_NEXT_DRIVE_INDEX_KEY, nextIndex.toString());
    console.log(`[${new Date().toISOString()}] Cron job finished for drive ${currentDriveId}. Next to process is index: ${nextIndex}.`);
}

// ===============================================================
// MAIN EVENT LISTENERS
// ===============================================================

addEventListener("fetch", (event) => {
    event.respondWith(handleHttpRequest(event.request));
});

addEventListener("scheduled", (event) => {
    event.waitUntil(handleCronEvent(event));
});

async function handleHttpRequest(request) {
    try {
        initializeRoots();
        return await handleRequest(request);
    } catch (error) {
        console.error('Unhandled error in HTTP request:', error);
        return new Response(
            `服务器内部错误: ${error.message}`, 
            { 
                status: 500,
                headers: { 'Content-Type': 'text/plain; charset=utf-8' }
            }
        );
    }
}

async function handleCronEvent(event) {
    try {
        initializeRoots();
        await handleScheduled(event);
    } catch (error) {
        console.error('Unhandled error in scheduled event:', error);
    }
}
