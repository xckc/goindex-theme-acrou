// ======= START OF CONFIGURATION =======
/**
 * @version 2.3.2
 * @description
 * - The admin panel is now accessible via both `/admin` and `/admin/`.
 * - Fixed a critical caching bug in `findPathId` that caused folders with the same name in different directories to resolve to the same ID.
 * - The in-memory path cache now uses full, absolute paths as keys, preventing collisions.
 * - Implemented sequential cron job caching, one drive per run.
 * - Added time-based cache refresh logic for cron jobs.
 */
const authConfig = {
    siteName: "GDrive Index", // 您的网站名称
    version: "2.3.2", // 自定义版本
    
    // [重要] 凭证 (client_id, client_secret, refresh_token) 和云盘配置 (roots)
    // 现在完全通过 Cloudflare 的环境变量加载，以增强安全性。
    // 您必须在 Cloudflare Worker 设置 -> 变量 中配置以下环境变量：
    // 1. CLIENT_ID: 您的 Google API 客户端 ID。
    // 2. CLIENT_SECRET: 您的 Google API 客户端密钥。
    // 3. REFRESH_TOKEN: 您的 Google API 刷新令牌。
    // 4. DRIVE_ROOTS: 一个 JSON 数组格式的云盘配置。
    // 5. ADMIN_PASS: (可选) 用于保护缓存清理功能的密码。
    // 6. GD_INDEX_CACHE: (必须) 绑定一个 KV 命名空间。

    // --- KV 缓存配置 ---
    enable_kv_cache: true,           // 设置为 true 以启用 KV 缓存。
    browsing_cache_ttl: 43200,       // 浏览缓存 TTL (秒)。用于文件夹列表、文件信息等。默认为 12 小时。
    cron_cache_ttl: 86400,           // Cron 任务缓存 TTL (秒)。专用于全量文件列表。默认为 24 小时。
    cron_update_hour: 4,             // Cron 任务仅在此小时后执行 (UTC+8)，除非缓存不存在。
    
    // --- 管理功能配置 ---
    require_admin_password_for_clear: true,

    // --- 分页配置 ---
    files_list_page_size: 200,      // 获取文件列表时，每次 API 调用请求的项目数。
    search_result_list_page_size: 50, // API 搜索结果每页的项目数。
    
    // --- 安全与 CORS ---
    enable_cors_file_down: false,     // 为直接文件下载启用 CORS 头部。
    default_gd: 0,                   // 默认加载的云盘索引。
};

// ======= END OF CONFIGURATION =======


/**
 * 全局常量
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
    CRON_NEXT_DRIVE_INDEX_KEY: "cron_next_drive_index", 
};

// 全局 GoogleDrive 实例缓存 (懒加载)
const gds = [];
let rootsParsingError = null; // 用于存储解析 DRIVE_ROOTS 时的任何错误


// ===============================================================
// 初始化和事件监听
// ===============================================================

/**
 * 共享的初始化函数，用于加载和解析 DRIVE_ROOTS 环境变量。
 */
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

// 监听 HTTP 请求
addEventListener("fetch", (event) => {
    event.respondWith(handleRequest(event.request));
});

// 监听计划事件 (Cron 触发器)
addEventListener("scheduled", event => {
    event.waitUntil(handleScheduled(event));
});


/**
 * 主请求处理器
 * @param {Request} request
 */
async function handleRequest(request) {
    initializeRoots();
    
    if (rootsParsingError) {
        return new Response(rootsParsingError, {
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

    if (path === '/admin' || path.startsWith('/admin/')) return handleAdminRouter(request);
    if (path.startsWith('/api/')) return handleApiRouter(request);
    if (path === '/favicon.ico') return Response.redirect("https://i.imgur.com/rOyuGjA.gif", 301);
    if (path === '/') return Response.redirect(`${url.origin}/${authConfig.default_gd || 0}:/`, 302);

    const { driveId, filePath } = parsePath(path);
    
    if (driveId === null || driveId < 0 || driveId >= authConfig.roots.length) {
        return new Response('无效的云盘 ID。', { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    const gd = await getGoogleDrive(driveId);
    if (!gd) return new Response(`云盘 ID ${driveId} 初始化失败。请检查您的配置。`, { status: 500 });
    
    const basicAuthResponse = gd.basicAuthResponse(request);
    if (basicAuthResponse) return basicAuthResponse;

    if (filePath.endsWith('/')) {
        return new Response(await renderHTML(driveId, filePath, urlParams, url), {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
    } else {
        const file = await gd.file(filePath);
        if (!file) return new Response('文件未找到。', { status: 404 });
        
        const action = urlParams.get('a');
        if (action === 'view') return gd.down(file.id, request.headers.get('Range'), true);
        if (action === 'down') return gd.down(file.id, request.headers.get('Range'), false);

        return new Response(await renderFilePageHTML(driveId, file, url), {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
    }
}

/**
 * 处理 API 请求的路由
 * @param {Request} request
 */
async function handleApiRouter(request) {
    initializeRoots();
    
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
    
    if (path === '/api/list') {
        const dirPath = url.searchParams.get('path') || '/';
        const pageToken = url.searchParams.get('pageToken') || null;
        const pageIndex = parseInt(url.searchParams.get('pageIndex') || '0');
        const listResult = await gd.list(dirPath, pageToken, pageIndex);
        return jsonResponse(listResult);
    }

    if (path === '/api/search') {
        const query = url.searchParams.get('q');
        const searchResult = await gd.search(query);
        return jsonResponse(searchResult);
    }

    if (path === '/api/id2path') {
        const id = url.searchParams.get('id');
        if (!id) return jsonResponse({ error: "缺少 'id' 参数" }, 400);
        const filePath = await gd.findPathById(id);
        return jsonResponse({ path: filePath });
    }

    if (path === '/api/refresh') {
        const pathToRefresh = url.searchParams.get('path');
        if (typeof pathToRefresh !== 'string') {
            return jsonResponse({ error: "Missing 'path' parameter" }, 400);
        }
        const result = await gd.clearPathCache(pathToRefresh);
        return jsonResponse(result);
    }

    return jsonResponse({ error: "无效的 API 端点" }, 404);
}


/**
 * 处理 Cron 触发器，实现顺序、智能的缓存更新
 * @param {ScheduledEvent} event
 */
async function handleScheduled(event) {
    initializeRoots();
    
    if (rootsParsingError || !authConfig.roots || authConfig.roots.length === 0) {
        console.error(`Cron 任务跳过: DRIVE_ROOTS 配置问题. 错误: ${rootsParsingError || 'roots 数组为空.'}`);
        return;
    }
    
    if (typeof GD_INDEX_CACHE === 'undefined') {
        console.error("Cron 任务跳过: 未绑定 KV 命名空间 'GD_INDEX_CACHE'。");
        return;
    }

    const currentIndexStr = await GD_INDEX_CACHE.get(CONSTS.CRON_NEXT_DRIVE_INDEX_KEY);
    const currentIndex = currentIndexStr ? parseInt(currentIndexStr, 10) : 0;
    
    if (currentIndex >= authConfig.roots.length) {
        await GD_INDEX_CACHE.put(CONSTS.CRON_NEXT_DRIVE_INDEX_KEY, "0");
        console.log("Cron 任务: 所有云盘都已检查，索引重置。");
        return;
    }
    
    const driveId = currentIndex;
    const rootConfig = authConfig.roots[driveId];
    console.log(`Cron 任务开始: 正在检查云盘 ${driveId} (${rootConfig.name})...`);

    const now = new Date(new Date().getTime() + 8 * 3600 * 1000);
    const todayUpdateHour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), authConfig.cron_update_hour).getTime();

    const gd = await getGoogleDrive(driveId, true); 
    if (!gd || gd.root_type === -1) {
        console.error(`初始化云盘 ${driveId} (${rootConfig.name}) 失败。跳过。`);
        await GD_INDEX_CACHE.put(CONSTS.CRON_NEXT_DRIVE_INDEX_KEY, (currentIndex + 1).toString());
        return;
    }
    const cacheKey = `all_files:${driveId}:${gd.root.id}`;
    const cacheObject = await gd._kv_get(cacheKey);

    let needsUpdate = false;
    if (!cacheObject || !cacheObject.timestamp) {
        needsUpdate = true;
        console.log(`云盘 ${driveId}: 未找到缓存，需要生成。`);
    } else if (cacheObject.timestamp < todayUpdateHour) {
        needsUpdate = true;
        console.log(`云盘 ${driveId}: 缓存已过期 (生成于 ${new Date(cacheObject.timestamp).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'})})，需要更新。`);
    } else {
        console.log(`云盘 ${driveId}: 今日缓存已是最新，跳过。`);
    }

    if (needsUpdate) {
        try {
            console.log(`正在为云盘 ${driveId} (${rootConfig.name}) 生成全量文件列表...`);
            const all_files = await gd.listAllFiles(gd.root.id);
            const newCacheObject = {
                files: all_files,
                timestamp: Date.now() 
            };
            await gd._kv_put(cacheKey, newCacheObject);
            console.log(`成功为云盘 ${driveId} (${rootConfig.name}) 缓存了 ${all_files.length} 个文件。`);
        } catch(e) {
            console.error(`为云盘 ${driveId} (${rootConfig.name}) 生成缓存时出错:`, e.message, e.stack);
        }
    }
    
    const nextIndex = (currentIndex + 1) % authConfig.roots.length;
    await GD_INDEX_CACHE.put(CONSTS.CRON_NEXT_DRIVE_INDEX_KEY, nextIndex.toString());
    console.log(`Cron 任务完成。下次将检查云盘索引: ${nextIndex}`);
}


/**
 * 解析 URL 路径为 driveId 和 filePath
 * @param {string} path
 * @returns {{driveId: number|null, filePath: string}}
 */
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


/**
 * 懒加载并初始化 googleDrive 实例
 * @param {number} driveId
 * @param {boolean} forceReload
 * @returns {Promise<googleDrive|null>}
 */
async function getGoogleDrive(driveId, forceReload = false) {
    if (!forceReload && gds[driveId]) {
        return gds[driveId];
    }
    try {
        const gd = new googleDrive(authConfig, driveId);
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
// HTML, CSS, 和客户端 JS 渲染器
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
                    renderFiles([]); // Clear view on error or no data
                }
            }

            async function performSearch(query) {
                if (appState.isLoading || !query) return;
                appState.path = \`搜索结果: "\${query}"\`;
                const url = \`/\${appState.driveId}:/?q=\${encodeURIComponent(query)}\`;
                window.history.pushState({ driveId: appState.driveId, path: '/', search: query }, '', url);

                breadcrumbs.innerHTML = \`<a href="/\${appState.driveId}:/">根目录</a><span class="separator"> / </span><span>\${appState.path}</span>\`;
                
                const result = await apiFetch('/api/search', { q: query });
                if (result && result.data) {
                    renderFiles(result.data.files);
                } else {
                    renderFiles([]); // Clear view on error or no data
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
                searchInput.value = ''; // Clear search input when changing drive
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

async function renderFilePageHTML(driveId, file, url) {
    const fileName = file.name;
    const isVideo = file.mimeType.startsWith('video/');
    const isAudio = file.mimeType.startsWith('audio/');
    const isImage = file.mimeType.startsWith('image/');
    
    const directViewUrl = `${url.pathname}?a=view`;
    const directDownloadUrl = `${url.pathname}?a=down`;
    const fullDownloadUrl = `${url.origin}${directDownloadUrl}`;

    let mediaElement = '';
    if (isVideo) {
        mediaElement = `<video controls autoplay preload="auto" src="${directViewUrl}" style="width: 100%; max-height: 70vh; border-radius: 8px; background-color: #000;"></video>`;
    } else if (isAudio) {
        mediaElement = `<audio controls autoplay preload="auto" src="${directViewUrl}" style="width: 100%;"></audio>`;
    } else if (isImage) {
        mediaElement = `<img src="${directViewUrl}" alt="${fileName}" style="max-width: 100%; max-height: 70vh; display: block; margin: auto; border-radius: 8px;">`;
    }

    return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${fileName} - ${authConfig.siteName}</title>
    <link rel="icon" href="/favicon.ico">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background-color: #f0f2f5; color: #1a1d21; display: flex; flex-direction: column; min-height: 100vh; }
        .container { max-width: 900px; margin: 2rem auto; padding: 1.5rem; background-color: #fff; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); flex-grow: 1; }
        .file-header h1 { font-size: 1.8rem; margin: 0 0 0.5rem; word-break: break-all; }
        .file-header p { font-size: 0.9rem; color: #6c757d; margin: 0 0 1.5rem; }
        .player-container { margin-bottom: 2rem; }
        .actions { display: flex; flex-wrap: wrap; gap: 1rem; }
        .actions a, .actions button {
            display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.75rem 1.5rem;
            border-radius: 6px; text-decoration: none; font-size: 1rem; font-weight: 500; cursor: pointer;
            transition: background-color 0.2s, transform 0.1s;
        }
        .actions a:active, .actions button:active { transform: scale(0.98); }
        .btn-download { background-color: #007bff; color: white; border: none; }
        .btn-download:hover { background-color: #0056b3; }
        .btn-secondary { background-color: #e9ecef; color: #343a40; border: 1px solid #dee2e6; }
        .btn-secondary:hover { background-color: #d1d5db; }
        .back-link { display: inline-block; margin-top: 2rem; color: #007bff; text-decoration: none; }
    </style>
</head>
<body>
    <div class="container">
        <div class="file-header">
            <h1>${fileName}</h1>
            <p>修改于: ${new Date(file.modifiedTime).toLocaleString()} | 大小: ${file.size ? (parseInt(file.size)/(1024*1024)).toFixed(2) + ' MB' : 'N/A'}</p>
        </div>

        ${mediaElement ? `<div class="player-container">${mediaElement}</div>` : ''}

        <div class="actions">
            <a href="${directDownloadUrl}" class="btn-download" download><span>📥</span><span>直接下载</span></a>
            <button id="copy-link-btn" class="btn-secondary"><span>🔗</span><span>复制链接</span></button>
            ${isVideo || isAudio ? `
            <a href="potplayer://${fullDownloadUrl}" class="btn-secondary"><span>🎬</span><span>PotPlayer</span></a>
            <a href="vlc://${fullDownloadUrl}" class="btn-secondary"><span> VLC</span></a>` : ''}
        </div>
        
        <a href="javascript:history.back()" class="back-link">← 返回上一页</a>
    </div>
    <script>
        document.getElementById('copy-link-btn').addEventListener('click', () => {
            const linkToCopy = '${fullDownloadUrl}';
            navigator.clipboard.writeText(linkToCopy).then(() => {
                alert('链接已复制到剪贴板！');
            }, (err) => {
                alert('复制失败，请手动复制。');
                console.error('Could not copy text: ', err);
            });
        });
    </script>
</body>
</html>`;
}


// ===============================================================
// GOOGLE DRIVE API CLASS
// ===============================================================
class googleDrive {
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
            const all_files = await this.listAllFiles(this.root.id);
            cacheObject = {
                files: all_files,
                timestamp: Date.now()
            };
            await this._kv_put(cacheKey, cacheObject);
            console.log(`[Search] 已为云盘 ${this.order} 生成并缓存了 ${all_files.length} 个项目。`);
        }
        
        const lowerCaseQuery = query.toLowerCase();
        const filtered_files = cacheObject.files.filter(file => 
            file.name.toLowerCase().includes(lowerCaseQuery)
        );
        
        filtered_files.forEach(file => {
            if (file.id && file.path) {
                this._kv_put(`path_by_id:${this.order}:${file.id}`, file.path);
            }
        });
        
        return { data: { files: filtered_files } };
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
    
    /**
     * [FIXED] Finds the ID of a given path. This version fixes a critical caching bug
     * where folders with the same name in different directories would resolve to the
     * same ID due to improper cache keying. The in-memory cache (`this.paths`) now
     * uses the full, cumulative path for each segment as its key, preventing collisions.
     * @param {string} path The full path of the file or folder.
     * @returns {Promise<string|null>} The Google Drive ID of the item, or null if not found.
     */
    async findPathId(path) {
        // Check for full final path in memory cache first.
        if (this.paths[path]) return this.paths[path];
    
        let parentId = this.root.id;
        let currentCumulativePath = '/';
    
        // Handle root path separately.
        if (path === '/') {
            return parentId;
        }

        const parts = path.trim('/').split('/');

        for (const name of parts) {
            if (!name) continue;
            
            const decodedName = decodeURIComponent(name);
            // Construct the full absolute path for the current segment.
            currentCumulativePath += decodedName + '/';
            
            // Check the memory cache for the ID of this full cumulative path.
            let childId = this.paths[currentCumulativePath];

            if (!childId) {
                // If not in memory, find it via API. _findDirId has its own robust KV caching.
                childId = await this._findDirId(parentId, decodedName);
                
                if (!childId) {
                    // If any part of the path is not found, the whole path is invalid.
                    // Cache this null result to avoid re-fetching a known invalid path.
                    this.paths[path] = null; 
                    return null;
                }
                
                // Store the found ID in the memory cache using its full cumulative path as the key.
                this.paths[currentCumulativePath] = childId;
            }
            
            // The found child becomes the parent for the next iteration.
            parentId = childId;
        }

        // After the loop, parentId holds the ID of the final directory in the path.
        // Cache the full original path to the final ID as well for quicker access next time.
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

// ===============================================================
// 管理面板和辅助函数
// ===============================================================

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: { 
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
        },
    });
}

async function handleAdminRouter(request) {
    initializeRoots();
    
    const adminPass = typeof ADMIN_PASS !== 'undefined' ? ADMIN_PASS : null;

    if (authConfig.require_admin_password_for_clear && !adminPass) {
        return new Response("Admin function is disabled: ADMIN_PASS is not set.", {
            status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
    }

    if (request.method === 'POST') {
        const formData = await request.formData();
        const password = formData.get('password');
        const driveIndex = formData.get('driveIndex');

        if (authConfig.require_admin_password_for_clear && password !== adminPass) {
            return new Response(getAdminDashboardPage('密码错误。', true), { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }

        if (driveIndex === null) {
            return new Response(getAdminDashboardPage('错误: 未选择云盘。', true), { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }

        const result = await clearKVCache(driveIndex);
        const message = `${result.message}<br><br>页面将在3秒后刷新。 <script>setTimeout(() => window.location.reload(), 3000);</script>`;
        return new Response(getAdminDashboardPage(message, !result.success), {
            status: result.success ? 200 : 500,
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
    }

    if (request.method === 'GET') {
        return new Response(getAdminDashboardPage(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    return new Response("Method Not Allowed", { status: 405 });
}

function getAdminDashboardPage(message = null, isError = false) {
    let driveButtons = authConfig.roots.map((root, index) =>
        `<button type="submit" name="driveIndex" value="${index}" class="btn-drive">清理云盘 ${index} (${root.name}) 的缓存</button>`
    ).join('');

    const messageHtml = message ? `<div class="message ${isError ? 'error' : 'success'}">${message}</div>` : '';

    const passwordFieldHtml = authConfig.require_admin_password_for_clear
        ? `<label for="password">管理员密码:</label><input type="password" id="password" name="password" required>`
        : '';

    return `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>缓存管理</title>
        <style>
            body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background-color: #f0f2f5; }
            .container { background: #fff; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); width: 100%; max-width: 600px; }
            h1 { text-align: center; margin-bottom: 1rem; }
            p { text-align: center; color: #666; margin-bottom: 2rem; }
            form { display: flex; flex-direction: column; }
            label { font-weight: 600; margin-bottom: 0.5rem; }
            input[type="password"] { padding: 0.75rem; border: 1px solid #ccc; border-radius: 4px; margin-bottom: 1.5rem; }
            .button-group { display: flex; flex-direction: column; gap: 0.75rem; }
            button { padding: 0.8rem 1rem; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer; transition: background-color 0.2s; }
            .btn-drive { background-color: #e7f3ff; color: #007bff; border: 1px solid #007bff; }
            .btn-drive:hover { background-color: #d0e7ff; }
            .btn-all { background-color: #fdeaea; color: #d93025; border: 1px solid #d93025; margin-top: 1.5rem; font-weight: bold; }
            .btn-all:hover { background-color: #fbd7d4; }
            .message { padding: 1rem; margin-bottom: 1.5rem; border-radius: 4px; text-align: center; border: 1px solid; }
            .message.success { background-color: #d4edda; color: #155724; border-color: #c3e6cb; }
            .message.error { background-color: #f8d7da; color: #721c24; border-color: #f5c6cb; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>缓存管理面板</h1>
            ${messageHtml}
            <p>选择一个操作来清理相应的KV缓存。</p>
            <form method="post">
                ${passwordFieldHtml}
                <div class="button-group">${driveButtons}</div>
                <button type="submit" name="driveIndex" value="all" class="btn-all">清理所有云盘的缓存</button>
            </form>
        </div>
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
                const list = await GD_INDEX_CACHE.list({ prefix, cursor, limit:1000 });
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
