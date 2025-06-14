/**
 * =================================================================================
 * GoIndex - A Google Drive Index Worker for Cloudflare
 *
 * This script is an updated version of 'goindex-worker-secure-final.js',
 * integrating a secure, environment-variable-based cache clearing mechanism
 * to work with the latest Vue frontend modifications.
 *
 * @version 2.2.4 (Custom Build)
 * =================================================================================
 */

'use strict';

// --- 配置区域 (Configuration Area) ---
const config = {
  "client_id": "",
  "client_secret": "",
  "refresh_token": "",
  "root_folder_id": "root",
  "cache_encryption_key": "",
  "password": "",
  "cache_expires_in": 3600,
  "page_size": 1000,
  "page_title": "Google Drive Index",
  "request_fields": "files(id, name, mimeType, modifiedTime, size, iconLink, thumbnailLink, trashed)",
  "no_thumbnail_mime_types": [],
  "sort": {"type": "name", "order": "asc"},
  "sort_folders_first": true,
  "hide_mime_types": [],
  "hide_files": [],
  "hide_folders": [],
};

// --- 静态文件映射 (Static File Mapping) ---
// 此映射与不带哈希值的文件名相对应，请确保您的 vue.config.js 中设置了 filenameHashing: false
const static_files = {
    "/app.css": "dist/css/app.css",
    "/app.js": "dist/js/app.js",
    "/chunk-vendors.css": "dist/css/chunk-vendors.css",
    "/chunk-vendors.js": "dist/js/chunk-vendors.js",
    "/favicon.ico": "dist/favicon.ico",
    "/index.html": "dist/index.html",
    "/setting.js": "dist/setting.js",
    "/robots.txt": "dist/robots.txt",
    "/": "dist/index.html"
};

const required_config_keys = ["client_id", "client_secret", "refresh_token", "root_folder_id"];

/**
 * =================================================================================
 * 核心 Worker 逻辑 (Core Worker Logic)
 * =================================================================================
 */

// 检查必要的配置项是否存在
for (const key of required_config_keys) {
  if (!(key in config)) {
    throw `Missing required config key '${key}'`;
  }
}

// 主请求处理程序
addEventListener('fetch', event => {
  event.respondWith(handle_request(event.request));
});

async function handle_request(request) {
  const url = new URL(request.url);
  const path = url.pathname;
  
  // 1. 静态文件服务
  if (path in static_files) {
    // 'gd_index' 是必需的 KV 命名空间绑定名称
    return await gd_index.get(static_files[path], { type: "stream" });
  }

  // 2. 动态生成前端配置文件
  if (path === '/config.js') {
    const headers = { "Content-Type": "application/javascript" };
    
    // 'ADMIN_PASS' 是必需的 Cloudflare 后台环境变量名称
    const cacheClearEnabled = typeof ADMIN_PASS !== 'undefined' && ADMIN_PASS !== '';

    const body = `window.config = ${JSON.stringify({
      page_title: config.page_title,
      page_size: config.page_size,
      sort: config.sort,
      sort_folders_first: config.sort_folders_first,
      password: !!config.password,
      cacheClearEnabled: cacheClearEnabled // 告知前端是否启用清理缓存功能
    })}`;
    return new Response(body, {status: 200, headers: headers});
  }

  // 3. 【新增】处理清理缓存的 API 请求
  if (request.method === "POST" && path === '/api/clearcache') {
    return handleClearCacheRequest(request);
  }

  // 4. 处理用户登录
  if (request.method === "POST" && path === '/api/login') {
    const request_body = await request.json();
    const password = request_body.password;
    if (check_password(password)) {
      const cookie_value = await sha256(`${password}${new Date()}`);
      // 将密码的哈希值存储到KV中，用于后续的身份验证
      const passwords = await gd_index.get("passwords", {type: 'json'}) || [];
      if (!passwords.includes(cookie_value)) {
        passwords.push(cookie_value);
        await gd_index.put("passwords", JSON.stringify(passwords));
      }
      const cookie = `password=${cookie_value}; path=/; secure; HttpOnly; SameSite=Lax`;
      return new Response(null, {status: 200, headers: {"Set-Cookie": cookie}});
    } else {
      return new Response(null, {status: 401});
    }
  }

  // 5. 全局密码保护中间件
  if (config.password) {
    const cookie = request.headers.get("cookie");
    const cookie_password = cookie ? cookie.split('password=')[1].split(';')[0] : null;
    const passwords = await gd_index.get("passwords", {type: 'json'}) || [];
    if (!cookie_password || !passwords.includes(cookie_password)) {
      return new Response(null, {status: 401});
    }
  }

  // 6. 处理获取文件夹内容的 API 请求
  if (path === '/api/get_folder') {
    return handleGetFolder(request);
  }

  // 7. 处理文件下载的 API 请求
  if (path === "/api/download") {
    return handleDownload(request);
  }

  // 8. 其他所有路径返回 404
  return new Response(null, {status: 404});
}

/**
 * =================================================================================
 * API 端点处理函数 (API Endpoint Handlers)
 * =================================================================================
 */

/**
 * 处理清理缓存的 API 请求
 * @param {Request} request
 */
async function handleClearCacheRequest(request) {
    try {
        // 再次确认环境变量已设置
        if (typeof ADMIN_PASS === 'undefined' || ADMIN_PASS === '') {
            const msg = JSON.stringify({ message: "Admin password not set in Cloudflare secrets. Feature disabled." });
            return new Response(msg, { status: 403, headers: {"Content-Type": "application/json"} });
        }

        const body = await request.json();
        const receivedPass = body.admin_pass;

        if (receivedPass !== ADMIN_PASS) {
            const msg = JSON.stringify({ message: "Invalid password." });
            return new Response(msg, { status: 401, headers: {"Content-Type": "application/json"} });
        }
      
        const message = await clearGdriveCache();
        const msg = JSON.stringify({ message: message });
        return new Response(msg, { status: 200, headers: {"Content-Type": "application/json"} });

    } catch (e) {
        const msg = JSON.stringify({ message: e.message });
        return new Response(msg, { status: 500, headers: {"Content-Type": "application/json"} });
    }
}

/**
 * 从 Google Drive API 或缓存中获取文件夹内容
 * @param {Request} request
 */
async function handleGetFolder(request) {
    const url = new URL(request.url);
    const folder_id = url.searchParams.get("id") || config.root_folder_id;
    
    // 尝试从缓存获取
    const cached = await get_folder_from_cache(folder_id);
    if (cached) {
      return new Response(JSON.stringify(cached), {status: 200, headers: {"Content-Type": "application/json"}});
    }
    
    // 如果缓存未命中，则从 API 获取
    const access_token = await get_access_token();
    let query = `'${folder_id}' in parents and trashed = false`;
    const hidden_mime_types_query = config.hide_mime_types.map((m) => `mimeType != '${m}'`).join(" and ");
    if (hidden_mime_types_query) {
      query += ` and ${hidden_mime_types_query}`;
    }

    let result = {files: [], breadcrumbs: []};
    let page_token = null;
    
    do {
      let api_url = "https://www.googleapis.com/drive/v3/files?" +
        `q=${encodeURIComponent(query)}&orderBy=folder,name` +
        `&fields=${encodeURIComponent(config.request_fields)}&pageSize=${config.page_size}`;
      if (page_token) {
        api_url += `&pageToken=${page_token}`;
      }
      const response = await fetch(api_url, {headers: {Authorization: `Bearer ${access_token}`}});
      if (response.status != 200) {
        return new Response(JSON.stringify(await response.json()), {status: response.status, headers: {"Content-Type": "application/json"}});
      }
      const data = await response.json();
      page_token = data.nextPageToken;
      result.files = result.files.concat(data.files);
    } while(page_token);

    result.breadcrumbs = await get_breadcrumbs(folder_id, access_token);
    result.files = result.files.map((file) => {
      const file_extension = get_file_extension(file.name);
      return {
        id: file.id, name: file.name, mimeType: file.mimeType, modifiedTime: file.modifiedTime,
        size: file.size, iconLink: file.iconLink, 
        thumbnailLink: config.no_thumbnail_mime_types.includes(file.mimeType) ? null : file.thumbnailLink,
        type: get_file_type(file.mimeType),
        preview_type: get_preview_type(file.mimeType, file_extension),
        file_extension: file_extension,
      }
    });

    const hide_files = config.hide_files || [];
    const hide_folders = config.hide_folders || [];
    result.files = result.files.filter((f) => {
      const is_folder = f.mimeType === 'application/vnd.google-apps.folder';
      if (is_folder) return !hide_folders.includes(f.name);
      return !hide_files.includes(f.name);
    });
    
    await set_folder_in_cache(folder_id, result);
    return new Response(JSON.stringify(result), {status: 200, headers: {"Content-Type": "application/json"}});
}

/**
 * 处理文件下载请求
 * @param {Request} request
 */
async function handleDownload(request) {
    const url = new URL(request.url);
    const file_id = url.searchParams.get("id");
    const access_token = await get_access_token();
    const api_url = `https://www.googleapis.com/drive/v3/files/${file_id}?alt=media`;
    const response = await fetch(api_url, {headers: {Authorization: `Bearer ${access_token}`}});
    return response;
}


/**
 * =================================================================================
 * 辅助函数 (Utility Functions)
 * =================================================================================
 */

/**
 * 清理所有 Google Drive 文件夹列表的 KV 缓存
 */
async function clearGdriveCache() {
  const kv_namespace = gd_index;
  let clearedCount = 0;
  let cursor;
  
  do {
    const list = await kv_namespace.list({ prefix: "folder_", cursor: cursor });
    const keys = list.keys.map(k => k.name);
    
    if (keys.length > 0) {
        await kv_namespace.delete(keys);
        clearedCount += keys.length;
    }
    
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);

  if (clearedCount === 0) {
    return "No folder cache to clear.";
  }

  return `Successfully cleared ${clearedCount} folder cache entries. The page will reload.`;
}

async function get_folder_from_cache(folder_id) {
    const cache_key = `folder_${folder_id}`;
    let result = await gd_index.get(cache_key);
    if (!result) return null;
    if (config.cache_encryption_key) {
      result = await decrypt(config.cache_encryption_key, result);
    }
    return JSON.parse(result);
}

async function set_folder_in_cache(folder_id, data) {
    const cache_key = `folder_${folder_id}`;
    let data_to_cache = JSON.stringify(data);
    if (config.cache_encryption_key) {
      data_to_cache = await encrypt(config.cache_encryption_key, data_to_cache);
    }
    await gd_index.put(cache_key, data_to_cache, {expirationTtl: config.cache_expires_in});
}

async function get_breadcrumbs(folder_id, access_token) {
    if (folder_id === config.root_folder_id || folder_id === 'root') {
      return [];
    }
    const url = `https://www.googleapis.com/drive/v3/files/${folder_id}?fields=${encodeURIComponent("id, name, parents")}`;
    const response = await fetch(url, {headers: {Authorization: `Bearer ${access_token}`}});
    if (response.status != 200) {
      return [];
    }
    const data = await response.json();
    const parent = data.parents ? data.parents[0] : 'root';
    const breadcrumbs = await get_breadcrumbs(parent, access_token);
    breadcrumbs.push({id: data.id, name: data.name});
    return breadcrumbs;
}

async function get_access_token() {
  const url = "https://www.googleapis.com/oauth2/v4/token";
  const body = {
    "client_id": config.client_id, "client_secret": config.client_secret,
    "refresh_token": config.refresh_token, "grant_type": "refresh_token"
  };
  const response = await fetch(url, {method: "POST", body: JSON.stringify(body)});
  if (!response.ok) { throw new Error(`Failed to get access token: ${await response.text()}`); }
  return (await response.json())["access_token"];
}

async function sha256(message) {
  const msgUint8 = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function encrypt(key, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const iv_string = new TextDecoder("latin1").decode(iv);
  const key_encoded = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), {name: 'AES-GCM'}, false, ['encrypt', 'decrypt']);
  const data_encoded = await crypto.subtle.encrypt({name: "AES-GCM", iv: iv}, key_encoded, new TextEncoder().encode(data));
  const encrypted = new Uint8Array(data_encoded);
  const encrypted_string = new TextDecoder("latin1").decode(encrypted);
  return `${iv_string}${encrypted_string}`;
}

async function decrypt(key, data) {
  const key_encoded = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), {name: 'AES-GCM'}, false, ['encrypt', 'decrypt']);
  const iv = new TextEncoder("latin1").encode(data.substring(0, 12));
  const ct = new TextEncoder("latin1").encode(data.substring(12));
  try {
    const decrypted = await crypto.subtle.decrypt({name: "AES-GCM", iv: iv}, key_encoded, ct);
    return new TextDecoder().decode(decrypted);
  } catch (e) {
    throw "Failed to decrypt. Most likely the key is invalid.";
  }
}

function check_password(password) {
  return !config.password || password === config.password;
}

function is_video(mime_type) { return mime_type.startsWith("video/"); }
function is_audio(mime_type) { return mime_type.startsWith("audio/"); }
function is_text(mime_type) { return mime_type.startsWith("text/"); }
function is_pdf(mime_type) { return mime_type === "application/pdf"; }

function get_file_type(mime_type) {
  if (is_video(mime_type)) return "video";
  if (is_audio(mime_type)) return "audio";
  if (is_text(mime_type)) return "text";
  if (is_pdf(mime_type)) return "pdf";
  return "other";
}

function get_file_extension(file_name) {
  const extension = file_name.split('.').pop();
  return extension === file_name ? "" : extension.toLowerCase();
}

function get_preview_type(mime_type, file_extension) {
  const file_type = get_file_type(mime_type);
  const video_extensions = ["mp4", "mkv", "avi", "flv"];
  const audio_extensions = ["mp3", "flac", "m4a", "wav", "ogg"];
  const text_extensions = ["txt", "html", "htm", "js", "css", "json", "md", "xml", "c", "cpp", "java", "py", "sh"];
  if (file_type === "video" && video_extensions.includes(file_extension)) return "video";
  if (file_type === "audio" && audio_extensions.includes(file_extension)) return "audio";
  if (file_type === "text" && text_extensions.includes(file_extension)) return "text";
  if (file_type === "pdf" && file_extension === "pdf") return "pdf";
  return "other";
}

