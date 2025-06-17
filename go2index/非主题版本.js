// ======= START OF CONFIGURATION =======

const authConfig = {
    siteName: "GDrive Index", // Your website name
    version: "2.1.1", // Custom version
    
    // [IMPORTANT] Credentials (client_id, client_secret, refresh_token) and drive configurations (roots)
    // are now loaded exclusively from Cloudflare's environment variables for enhanced security.
    // You MUST set the following environment variables in your Cloudflare Worker settings:
    // 1. CLIENT_ID: Your Google API client ID.
    // 2. CLIENT_SECRET: Your Google API client secret.
    // 3. REFRESH_TOKEN: Your Google API refresh token.
    // 4. DRIVE_ROOTS: A JSON array of your drive configurations. See example format below.
    // 5. ADMIN_PASS: (Optional) A password to protect the cache clearing functionality.
    
    // Example for DRIVE_ROOTS environment variable (must be a single line of valid JSON):
    // [
    //   {"name": "My Drive", "id": "root", "protect_file_link": false},
    //   {"name": "Shared Drive", "id": "0AGxxxxxxxxxxxxxx", "user": "admin", "pass": "123456"},
    //   {"name": "Subfolder", "id": "1Bxxxxxxxxxxxxxx", "protect_file_link": true}
    // ]

    // --- KV Caching Configuration ---
    enable_kv_cache: true, // Set to true to enable KV caching. Requires a KV namespace binding.
    kv_cache_ttl: 3600,    // Cache Time-To-Live in seconds. Minimum 60. (e.g., 3600 = 1 hour)
    
    // --- Admin Functionality Configuration ---
    require_admin_password_for_clear: true, // true: require password for cache clearing. false: no password needed.

    // --- Pagination Configuration ---
    files_list_page_size: 200,      // Number of files to fetch per API call for file listings.
    search_result_list_page_size: 50, // Number of results per page for API search (legacy, not used by default search).
    
    // --- Security & CORS ---
    enable_cors_file_down: false,     // Enable CORS headers for direct file downloads.
    enable_password_file_verify: false, // Legacy setting, not used in this version.
    default_gd: 0, // Default drive index to load.
};

// ======= END OF CONFIGURATION =======


/**
 * Global Constants
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

// Global cache for GoogleDrive instances (lazy loaded)
const gds = [];
let rootsParsingError = null; // To store any errors from parsing DRIVE_ROOTS


// ===============================================================
// MAIN WORKER LOGIC: REQUEST AND CRON HANDLING
// ===============================================================

// Listen for incoming HTTP requests
addEventListener("fetch", (event) => {
    // Load roots configuration at the beginning of each request
    // This ensures that changes in environment variables are picked up without redeploying.
    try {
        if (typeof DRIVE_ROOTS !== 'undefined' && DRIVE_ROOTS) {
            authConfig.roots = JSON.parse(DRIVE_ROOTS);
            rootsParsingError = null; // Clear previous errors
        } else {
            rootsParsingError = "Configuration Error: 'DRIVE_ROOTS' environment variable is not set. Please add it in your Cloudflare Worker settings.";
        }
    } catch (e) {
        rootsParsingError = `Configuration Error: Failed to parse 'DRIVE_ROOTS' environment variable. Please ensure it is a valid, single-line JSON array without comments or trailing commas.\n\nError details: ${e.message}`;
        authConfig.roots = []; // Ensure roots is an empty array on failure
    }
    event.respondWith(handleRequest(event.request));
});

// Listen for scheduled events (Cron Triggers) for cache pre-warming
addEventListener("scheduled", event => {
  event.waitUntil(handleScheduled(event));
});


/**
 * Main request handler.
 * Routes requests to the appropriate function.
 * @param {Request} request The incoming request
 */
async function handleRequest(request) {
    // Immediately fail if the roots configuration is invalid
    if (rootsParsingError) {
        return new Response(rootsParsingError, {
            status: 503,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
    }
    if (!authConfig.roots || authConfig.roots.length === 0) {
        return new Response(
            "Configuration Error: 'DRIVE_ROOTS' is loaded but is an empty array. Please add at least one drive configuration.", {
                status: 503,
                headers: { "Content-Type": "text/plain; charset=utf-8" },
            }
        );
    }
    
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    const urlParams = url.searchParams;

    // Route for Admin Panel
    if (path.startsWith('/admin/')) {
        return handleAdminRouter(request);
    }

    // Route for API requests from the frontend
    if (path.startsWith('/api/')) {
        return handleApiRouter(request);
    }

    // Favicon
    if (path === '/favicon.ico') {
        const favIconUrl = "https://i.imgur.com/rOyuGjA.gif";
        return Response.redirect(favIconUrl, 301);
    }
    
    // Redirect root to default drive
    if (path === '/') {
        return Response.redirect(`${url.origin}/${authConfig.default_gd || 0}:/`, 302);
    }

    // Main file/folder serving logic
    const { driveId, filePath } = parsePath(path);
    
    if (driveId === null || driveId < 0 || driveId >= authConfig.roots.length) {
        return new Response('Invalid drive ID.', { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    const gd = await getGoogleDrive(driveId);
    if (!gd) {
        return new Response(`Drive initialization failed for ID ${driveId}. Check your configuration.`, { status: 500 });
    }
    
    // Handle Basic Auth if configured for the drive
    const basicAuthResponse = gd.basicAuthResponse(request);
    if (basicAuthResponse) return basicAuthResponse;

    // If path is a directory, render the folder browser
    if (filePath.endsWith('/')) {
        return new Response(await renderHTML(driveId, filePath, urlParams, url), {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
    } else {
        // If path is a file, handle actions (view, down) or render the file view page
        const file = await gd.file(filePath);
        if (!file) {
            return new Response('File not found.', { status: 404 });
        }
        
        const action = urlParams.get('a');

        if (action === 'view') {
            return gd.down(file.id, request.headers.get('Range'), true); // inline view
        }
        if (action === 'down') {
            return gd.down(file.id, request.headers.get('Range'), false); // download
        }

        // Default action: render the file page with player/download buttons
        return new Response(await renderFilePageHTML(driveId, file, url), {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
    }
}


/**
 * Handles API requests from the frontend.
 * @param {Request} request
 */
async function handleApiRouter(request) {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    const driveId = parseInt(url.searchParams.get('driveId'));

    if (isNaN(driveId)) {
        return jsonResponse({ error: "Missing or invalid 'driveId' parameter" }, 400);
    }

    const gd = await getGoogleDrive(driveId);
    if (!gd) {
        return jsonResponse({ error: `Drive initialization failed for ID ${driveId}` }, 500);
    }

    // Basic Auth Check
    const basicAuthResponse = gd.basicAuthResponse(request);
    if (basicAuthResponse) return basicAuthResponse;
    
    // API: List files in a directory
    if (path === '/api/list') {
        const dirPath = url.searchParams.get('path') || '/';
        const pageToken = url.searchParams.get('pageToken') || null;
        const pageIndex = parseInt(url.searchParams.get('pageIndex') || '0');
        const listResult = await gd.list(dirPath, pageToken, pageIndex);
        return jsonResponse(listResult);
    }

    // API: Search for files
    if (path === '/api/search') {
        const query = url.searchParams.get('q');
        const searchResult = await gd.search(query);
        return jsonResponse(searchResult);
    }

    // API: Get file path by its ID
    if (path === '/api/id2path') {
        const id = url.searchParams.get('id');
        if (!id) return jsonResponse({ error: "Missing 'id' parameter" }, 400);
        const filePath = await gd.findPathById(id);
        return jsonResponse({ path: filePath });
    }

    return jsonResponse({ error: "Invalid API endpoint" }, 404);
}

/**
 * Handles cron triggers to pre-warm the cache.
 * @param {ScheduledEvent} event
 */
async function handleScheduled(event) {
    console.log(`[${new Date().toISOString()}] Cron job started: Pre-warming cache...`);

    if (rootsParsingError || !authConfig.roots || authConfig.roots.length === 0) {
        console.warn(`[${new Date().toISOString()}] Cron job skipped: DRIVE_ROOTS not configured. Error: ${rootsParsingError || 'roots array is empty.'}`);
        return;
    }

    for (let i = 0; i < authConfig.roots.length; i++) {
        const rootConfig = authConfig.roots[i];
        console.log(`[${new Date().toISOString()}] Processing drive ${i} (${rootConfig.name})...`);

        try {
            const gd = await getGoogleDrive(i, true); // Force re-initialization
            if (!gd || gd.root_type === -1) {
                console.error(`[${new Date().toISOString()}] Failed to initialize drive ${i} (${rootConfig.name}). Skipping.`);
                continue;
            }

            console.log(`[${new Date().toISOString()}] Starting to list all files for drive ${i} (${rootConfig.name})...`);
            const all_files = await gd.listAllFiles(gd.root.id);
            const cacheKey = `all_files:${i}:${gd.root.id}`;
            await gd._kv_put(cacheKey, all_files);

            console.log(`[${new Date().toISOString()}] Successfully cached ${all_files.length} files for drive ${i} (${rootConfig.name}).`);

        } catch (e) {
            console.error(`[${new Date().toISOString()}] Error processing drive ${i} (${rootConfig.name}):`, e.message);
        }
    }

    console.log(`[${new Date().toISOString()}] Cron job finished.`);
}

/**
 * Parses the URL path into driveId and filePath.
 * @param {string} path The URL path.
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
 * Lazy-loads and initializes a googleDrive instance.
 * @param {number} driveId The index of the drive in the configuration.
 * @param {boolean} forceReload Force re-initialization.
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
            console.error(`Initialization failed for drive ID ${driveId}.`);
            return null;
        }
        gds[driveId] = gd;
        return gd;
    } catch (e) {
        console.error(`Error initializing drive ${driveId}: ${e.message}`);
        return null;
    }
}


// ===============================================================
// HTML, CSS, and CLIENT-SIDE JS RENDERER
// ===============================================================

/**
 * Renders the file/folder browser HTML page.
 * @param {number} driveId The current drive ID.
 * @param {string} filePath The current file path.
 * @param {URLSearchParams} urlParams The URL parameters.
 * @param {URL} url The full URL object.
 * @returns {string} The complete HTML document.
 */
async function renderHTML(driveId, filePath, urlParams, url) {
    // These window variables will be used by the client-side script
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

            const ICONS = {
                folder: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="color: var(--folder-color);"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>',
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
                    if (!response.ok) throw new Error(\`API Error: \${response.statusText}\`);
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

                    // If file.path exists (from search results), use it directly.
                    // Otherwise, construct the path from the current directory view.
                    const finalFilePath = file.path ? file.path : (appState.path + file.name + (isFolder ? '/' : ''));

                    link.href = \`/\${appState.driveId}:\${finalFilePath}\`;
                    link.className = 'file-item';

                    if (isFolder) {
                        link.classList.add('folder');
                        // The dataset.path is used by navigateTo(), which expects a root-relative path.
                        // `finalFilePath` provides this correctly for both search and folder views.
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
                if (result && result.data) renderFiles(result.data.files);
            }

            async function performSearch(query) {
                if (appState.isLoading || !query) return;
                appState.path = \`搜索结果: "\${query}"\`;
                const url = \`/\${appState.driveId}:/?q=\${encodeURIComponent(query)}\`;
                window.history.pushState({ driveId: appState.driveId, path: '/', search: query }, '', url);

                breadcrumbs.innerHTML = \`<a href="/\${appState.driveId}:/">根目录</a><span class="separator"> / </span><span>\${appState.path}</span>\`;
                
                const result = await apiFetch('/api/search', { q: query });
                if (result && result.data) renderFiles(result.data.files);
            }
            
            fileList.addEventListener('click', e => {
                const link = e.target.closest('a.file-item');
                if (link && link.classList.contains('folder')) {
                    e.preventDefault();
                    navigateTo(link.dataset.path);
                }
                // For files, let the browser handle the navigation to the file view page.
            });
            
            breadcrumbs.addEventListener('click', e => {
                e.preventDefault();
                const link = e.target.closest('a');
                if (link && link.dataset.path) navigateTo(link.dataset.path);
            });

            driveSelector.addEventListener('change', () => {
                appState.driveId = driveSelector.value;
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

/**
 * Renders the dedicated file view/player page.
 * @param {number} driveId The current drive ID.
 * @param {object} file The file object from the Drive API.
 * @param {URL} url The full URL object for creating links.
 * @returns {string} The complete HTML document for the file view.
 */
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
    constructor(authConfig, order) {
        this.order = order;
        this.root = authConfig.roots[order];
        this.root.protect_file_link = this.root.protect_file_link || false;

        // Load credentials from environment variables bound to the worker
        this.authConfig = { ...authConfig };
        this.authConfig.client_id = typeof CLIENT_ID !== 'undefined' ? CLIENT_ID : "";
        this.authConfig.client_secret = typeof CLIENT_SECRET !== 'undefined' ? CLIENT_SECRET : "";
        this.authConfig.refresh_token = typeof REFRESH_TOKEN !== 'undefined' ? REFRESH_TOKEN : "";

        // In-memory cache for the duration of a single request
        this.paths = {};
        this.files = {};
        this.id_path_cache = {};
        this.id_path_cache[this.root.id] = "/";
        this.paths["/"] = this.root.id;

        this.kv_cache_available = this.authConfig.enable_kv_cache && typeof GD_INDEX_CACHE !== 'undefined';
    }

    // KV cache helper methods
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
        const ttl = Math.max(60, this.authConfig.kv_cache_ttl);
        await GD_INDEX_CACHE.put(key, JSON.stringify(value), { expirationTtl: ttl });
    }

    async init() {
        if (!this.authConfig.client_id || !this.authConfig.client_secret || !this.authConfig.refresh_token) {
            throw new Error(`Credentials are not configured in environment variables.`);
        }
        await this.accessToken();
        if (authConfig.user_drive_real_root_id) return;

        // This is fetched only once by the first drive instance
        if (this.order === 0) {
            const root_obj = await this.findItemById("root");
            if (root_obj && root_obj.id) {
                authConfig.user_drive_real_root_id = root_obj.id;
            }
        }
    }
    
    async initRootType() {
        this.root_type = -1; // Default to invalid
        let root_id = this.root.id;

        if (!root_id) {
            console.error(`Root item '${this.root.name}' has no ID.`);
            return;
        }

        const root_obj = await this.findItemById(root_id);

        // Handle shortcuts pointing to a folder
        if (root_obj && root_obj.mimeType === CONSTS.shortcut_mime_type) {
            if (root_obj.shortcutDetails && root_obj.shortcutDetails.targetId && root_obj.shortcutDetails.targetMimeType === CONSTS.folder_mime_type) {
                this.root.id = root_obj.shortcutDetails.targetId;
                root_id = this.root.id;
            } else {
                console.error(`Root item '${this.root.name}' is an invalid shortcut or does not point to a folder.`);
                return;
            }
        }
        
        // Determine root type
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
                     console.error(`Root item '${this.root.name}' with ID '${root_id}' is not a valid folder, shared drive, or user drive.`);
                }
            }
        }
    }

    // Handle Basic Authentication
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
                return null; // Authenticated
            }
        } catch (e) {
            // Decoding failed
        }
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
        let all_files = await this._kv_get(cacheKey);

        if (!all_files) {
            console.log(`[Search] Cache miss for drive ${this.order}. Triggering on-demand scan...`);
            all_files = await this.listAllFiles(this.root.id);
            await this._kv_put(cacheKey, all_files);
        }
        
        const lowerCaseQuery = query.toLowerCase();
        const filtered_files = all_files.filter(file => 
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
                console.error(`Failed to list folder ${currentFolderId}:`, e.message);
            }
        }
        return allFiles;
    }
    
    async findPathId(path) {
        if (this.paths[path]) return this.paths[path];
        
        let currentId = this.root.id;
        if (path === '/') return currentId;
        
        const parts = path.trim('/').split('/');
        for (const name of parts) {
            if (!name) continue;
            const decodedName = decodeURIComponent(name);
            const nextPath = (this.paths[currentId] || '') + decodedName + '/';

            if (this.paths[nextPath]) {
                currentId = this.paths[nextPath];
            } else {
                 const dirId = await this._findDirId(currentId, decodedName);
                 if (!dirId) return null;
                 this.paths[nextPath] = dirId;
                 currentId = dirId;
            }
        }
        this.paths[path] = currentId;
        return currentId;
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
}

// ===============================================================
// ADMIN PANEL AND HELPER FUNCTIONS
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
        } else {
            const index = parseInt(driveIndex, 10);
            if (isNaN(index)) return { success: false, message: "无效的云盘索引。" };
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
                    // This is a batched operation in the Workers runtime.
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
