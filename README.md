# GoIndex-CF-Worker 优化版

基于 https://github.com/Aicirou/goindex-theme-acrou ，使用gemini进行优化。

这是一个功能增强版的 GoIndex Cloudflare Worker 脚本。它不仅提供了 Google Drive 文件的基础索引功能，还集成了 `acrou` 主题、强大的 KV 缓存机制以及一个简单易用的后台管理面板，用于手动清理缓存。

此脚本经过优化，将所有敏感凭证（如 API 密钥和云盘列表）从代码中移除，通过 Cloudflare 的环境变量进行安全加载，极大地提升了安全性。

## ✨ 功能特性

* **安全配置**：所有敏感信息（`client_id`, `client_secret`, `refresh_token`, `roots`, `ADMIN_PASS`）均通过 Cloudflare 环境变量加载，避免硬编码在代码中。
* **强大的 KV 缓存**：通过集成 Cloudflare KV，大幅提升文件和目录列表的加载速度，并降低 Google Drive API 的请求频率。缓存的 TTL (Time-To-Live) 可自定义。
* **后台管理面板**：内置一个简洁的管理页面（通过 `/admin` 访问），可以一键清理所有或单个云盘的 KV 缓存。
* **灵活的后台权限**：
    * 可以直接访问 `/admin` 进入管理面板，无需输入特定命令。
    * 可通过 `require_admin_password_for_clear` 配置项，自由选择清理缓存时是否需要输入管理员密码。
    * **安全机制**：当 `require_admin_password_for_clear` 设置为 `true` (默认值) 时，**必须**配置 `ADMIN_PASS` 环境变量，否则后台功能将自动禁用以确保安全。如果此项设置为 `false`，则无需密码即可访问和清理。
* **多云盘/团队盘/子目录支持**：可以同时挂载多个个人云盘、团队盘，甚至是指定文件夹作为根目录。
* **Acrou 主题集成**：默认使用美观且功能丰富的 `acrou` 主题，支持视频和音频文件的在线预览。
* **快捷方式解析**：能够自动解析 Google Drive 中的快捷方式（shortcuts），直接展示其指向的目标文件或文件夹。
* **懒加载机制**：仅在访问特定云盘时才初始化其实例，优化了首次加载性能和资源占用。

## 🚀 部署与配置

部署此 Worker 需要一个 Cloudflare 账户，并完成以下步骤：

### 步骤 1: 创建 Worker 和 KV 命名空间

1.  在 Cloudflare 控制台中，进入 `Workers 和 Pages` -> `KV`。
2.  创建一个新的 KV 命名空间，例如命名为 `GD_INDEX_CACHE`。
3.  进入 `Workers 和 Pages` -> `概述` -> `创建应用程序` -> `创建 Worker`。
4.  为您的 Worker 命名，然后点击“部署”。

### 步骤 2: 绑定 KV 命名空间

1.  进入新创建的 Worker 的设置页面 (`Settings` -> `Variables`)。
2.  在 “KV 命名空间绑定” (`KV Namespace Bindings`) 部分，点击 `添加绑定`。
3.  将**变量名称**设置为 `GD_INDEX_CACHE`。
4.  在 **KV 命名空间**下拉菜单中，选择您在第一步创建的命名空间。
5.  保存并部署 (`Save and deploy`)。

### 步骤 3: 配置环境变量

在 Worker 的设置页面 (`Settings` -> `Variables`) 的 “环境变量” (`Environment Variables`) 部分，点击 `添加变量` 来设置以下**加密**变量：

* `CLIENT_ID`: 你的 Google API Client ID。
* `CLIENT_SECRET`: 你的 Google API Client Secret。
* `REFRESH_TOKEN`: 你的 Google API Refresh Token。
* `ADMIN_PASS`: 你的后台管理员密码（例如 `mysecretpassword`）。
* `DRIVE_ROOTS`: **\[重要]** 你的云盘配置列表，必须是有效的 JSON 数组格式。

**`DRIVE_ROOTS` 格式示例：**

```json
[
  {
    "id": "root",
    "name": "个人云盘",
    "user": "",
    "pass": ""
  },
  {
    "id": "0ABcdeFG12345UK9PVA",
    "name": "团队盘",
    "user": "",
    "pass": ""
  },
  {
    "id": "1-HIJklmn6789o_pqrsT-uvwxyz",
    "name": "一个子目录",
    "user": "admin",
    "pass": "password123"
  }
]
```

> **提示**：
>
> * `id` 为 `root` 表示个人 Google Drive 的根目录。
> * 团队盘和子目录需要填写其对应的 ID。
> * `user` 和 `pass` 用于为单个云盘设置 Basic Auth 身份验证，如果不需要，请留空。

### 步骤 4: 部署代码

1.  回到 Worker 的代码编辑器。
2.  将本文档附带的最新版 `goindex_worker_admin_update` 脚本的**全部内容**复制并粘贴到编辑器中。
3.  根据需要，你可以在代码顶部的 `authConfig` 对象中修改 `siteName`, `require_admin_password_for_clear` 等非敏感配置。
4.  点击**保存并部署** (`Save and deploy`)。

## 📖 使用说明

### 浏览文件

* 部署成功后，访问你的 Worker 地址（例如 `https://your-name.workers.dev`），它会自动跳转到默认的第一个云盘。
* URL 结构为 `/<盘符序号>:/<目录路径>`。例如，访问第二个云盘（索引为 1）的根目录，地址为 `https://your-name.workers.dev/1:/`。

### 管理后台

* **访问**：直接在浏览器中访问 `https://your-name.workers.dev/admin` 即可进入缓存管理面板。
* **清理缓存**：
    1.  在面板上，你会看到所有已配置云盘的清理按钮，以及一个“清理所有云盘缓存”的按钮。
    2.  如果 `require_admin_password_for_clear` 设置为 `true`，你需要先输入正确的管理员密码。
    3.  点击相应的按钮即可清理该云盘或所有云盘在 KV 中的缓存数据。
    4.  操作成功或失败后，页面会显示提示信息并自动刷新。

## ⚠️ 注意事项

* 请务必将所有敏感变量（特别是 `CLIENT_ID`, `CLIENT_SECRET`, `REFRESH_TOKEN`）设置为**加密**变量 (`Secret`)，以防止泄露。
* `DRIVE_ROOTS` 必须是严格的 JSON 格式，否则 Worker 将无法解析云盘列表。
* 清理缓存操作会删除 KV 中的所有相关键，下次访问时系统会重新从 Google Drive API 获取数据并重建缓存。在数据量巨大时，这可能会短暂影响加载速度。
