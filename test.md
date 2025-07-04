# GoIndex Cloudflare Worker 增强版使用说明

这是一个功能增强且更稳定的 GoIndex Worker 脚本版本。它基于原始版本，并集成了多项关键优化，包括缓存、定时任务、管理后台以及全面的错误处理机制，旨在提供更流畅、更可靠的使用体验。

---

## ✨ 功能特性

* **🔒 配置安全加载**：所有敏感信息（如云盘列表、API凭证）均通过 Cloudflare 的**环境变量**加载，避免硬编码在代码中，提高了安全性。
* **💽 支持多云盘**：可以在 `DRIVE_ROOTS` 变量中配置任意数量的 Google Drive 云盘（个人盘、团队盘或子目录）。
* **⚡ KV 缓存加速**：利用 Cloudflare KV 缓存文件和目录列表，大幅减少对 Google Drive API 的请求次数，显著提升了加载速度。
* **⏰ 定时任务预热**：通过 Cloudflare Cron 触发器，可以定时自动遍历所有云盘并生成全量文件缓存。这使得首次搜索和访问速度极快。
* **🔧 后台管理面板**：提供一个简单的管理后台 (`/admin`)，可以手动清理指定云盘或全部云盘的 KV 缓存，方便维护。
* **🚨 强大的错误处理**：针对各种常见的配置错误（如 `DRIVE_ROOTS` 格式错误、云盘ID无效、凭证缺失等）提供了明确的页面提示，彻底告别“重定向次数过多”的困扰。
* **🔍 统一的搜索行为**：**所有类型**的云盘（个人盘、团队盘、子目录）现在都支持在首次搜索时自动构建高速缓存。

---

## 🚀 部署步骤

部署过程分为以下几个关键步骤：

### 1. 创建 Worker

1.  登录到 Cloudflare 仪表板。
2.  在左侧菜单中，转到 **Workers 和 Pages**。
3.  点击 **创建应用程序** -> **创建 Worker**。
4.  为你的 Worker 指定一个名称（例如 `my-goindex`），然后点击 **部署**。

### 2. 复制代码

1.  部署后，点击 **编辑代码**。
2.  将本文档附带的最新版 Worker 脚本的**全部内容**复制并粘贴到代码编辑器中，覆盖原有的默认代码。
3.  点击 **保存并部署**。

### 3. 创建 KV Namespace

1.  回到你的 Worker 管理页面，点击 **设置** -> **变量**。
2.  向下滚动到 **KV Namespace 绑定**。
3.  点击 **添加绑定**：
    * **变量名称 (Variable Name)**：必须输入 `GD_INDEX_CACHE`。
    * **KV Namespace**：点击下拉框并选择 **创建 Namespace**。输入一个新名称（例如 `GOINDEX_CACHE`），然后点击 **添加**。
4.  点击 **保存并部署**。

### 4. 配置环境变量

这是最关键的一步。在 **设置** -> **变量** -> **环境变量** 部分，点击 **添加变量** 来设置以下所有必需的变量：

* #### `CLIENT_ID`
    * **值**：你的 Google API `client_id`。

* #### `CLIENT_SECRET`
    * **值**：你的 Google API `client_secret`。

* #### `REFRESH_TOKEN`
    * **值**：你获取到的 Google Drive `refresh_token`。

* #### `ADMIN_PASS` (可选，但强烈推荐)
    * **值**：用于访问 `/admin` 管理面板的密码。
    * **重要**：脚本中的 `require_admin_password_for_clear` 默认设置为 `true`。在此设置下，你**必须**设置此 `ADMIN_PASS` 环境变量，否则管理后台将因安全原因被禁用并显示错误信息。
    * 如果你希望无需密码即可访问管理后台（**不推荐**），你需要同时在脚本代码中将 `require_admin_password_for_clear` 的值修改为 `false`，并确保 `ADMIN_PASS` 环境变量未设置。

* #### `DRIVE_ROOTS` (核心配置)
    * **值**：这是一个 **单行的 JSON 字符串**，用于定义你的云盘列表。请务必确保格式正确，否则脚本会报错。

    **格式说明：**
    1.  先在文本编辑器中写好多行、格式化的 JSON，便于检查。
    2.  确认无误后，将其压缩成**一行**再粘贴到 Cloudflare 的变量值中。
    3.  **注意**：JSON 中不能有注释，且最后一个对象 `}` 后面不能有逗号。

    **多行示例（用于编写和检查）：**
    ```json
    [
      {
        "id": "root",
        "name": "我的个人盘",
        "user": "",
        "pass": ""
      },
      {
        "id": "0ABcdeFG12345UK9PVA",
        "name": "电影收藏",
        "user": "",
        "pass": ""
      },
      {
        "id": "1-HIJklmn6789o_pqrsT-uvwxyz",
        "name": "加密文件夹",
        "user": "admin",
        "pass": "password123"
      }
    ]
    ```

    **单行格式（用于粘贴到 Cloudflare）：**
    ```
    [{"id":"root","name":"我的个人盘","user":"","pass":""},{"id":"0ABcdeFG12345UK9PVA","name":"电影收藏","user":"","pass":""},{"id":"1-HIJklmn6789o_pqrsT-uvwxyz","name":"加密文件夹","user":"admin","pass":"password123"}]
    ```

配置完所有变量后，点击 **保存并部署**。

> **提示**：除了环境变量，脚本中还有一些高级参数可以直接修改。详情请参阅下方的 **高级配置说明**。

### 5. 配置 Cron 触发器 (可选，但推荐)

此功能用于自动预热缓存，极大提升搜索速度。

1.  在 Worker 的管理页面，点击 **触发器 (Triggers)**。
2.  在 **Cron 触发器** 部分，点击 **添加 Cron 触发器**。
3.  **频率 (Frequency)**：选择一个合适的频率，例如 **每天 (Daily)** 或 **每12小时 (Every 12 hours)**。过于频繁的触发没有必要。
4.  点击 **添加触发器**。

---

## ⚙️ 高级配置说明

除了通过环境变量配置核心凭证外，你还可以在脚本代码的开头直接修改 `authConfig` 对象中的一些参数，以实现更精细的控制。

### 脚本内主要配置项 (`authConfig`)

* `siteName: "xckk"`
    * **说明**：你的网站标题，会显示在浏览器标签页上。

* `default_gd: 0`
    * **说明**：默认加载的云盘索引号。索引从 `0` 开始，对应 `DRIVE_ROOTS` 数组中的第一个云盘。

* `enable_kv_cache: true`
    * **说明**：是否启用 Cloudflare KV 缓存。强烈建议保持 `true` 以获得最佳性能。

* `kv_cache_ttl: 259200`
    * **说明**：KV 缓存的有效期，单位为秒。默认值为 `259200` 秒（3天）。你可以根据文件更新频率调整此值。

* `require_admin_password_for_clear: true`
    * **说明**：是否要求管理后台 (`/admin`) 使用密码。`true` 表示必须提供 `ADMIN_PASS` 环境变量才能使用后台；`false` 表示无需密码即可访问（不推荐）。

* `files_list_page_size: 200`
    * **说明**：文件列表页面每页显示的项目数量。

* `enable_cors_file_down: false`
    * **说明**：是否允许文件跨域下载。如果你需要在其他网站上直接引用此 Worker 提供的文件链接，请将其设置为 `true`。

* `enable_password_file_verify: false`
    * **说明**：是否启用文件夹密码验证功能。此功能已在较新版本中被弃用，不建议开启。

### `DRIVE_ROOTS` 内的云盘专属配置

你可以在 `DRIVE_ROOTS` 环境变量的每个云盘对象中添加额外的配置项。

* `"protect_file_link": true`
    * **说明**：是否保护文件下载链接。如果设置为 `true`，那么当这个云盘设置了密码时 (`user` 和 `pass` 字段不为空)，获取文件下载链接也需要进行 Basic Auth 验证。这可以防止下载链接被轻易分享。
    * **示例**：
        ```json
        {
          "id": "1-HIJklmn6789o_pqrsT-uvwxyz",
          "name": "机密文件",
          "user": "admin",
          "pass": "password123",
          "protect_file_link": true
        }
        ```
---

## 🛠️ 管理与维护

### 访问管理面板

直接在你的 Worker 域名后加上 `/admin` 即可访问。例如：`https://my-goindex.user.workers.dev/admin`。
如果脚本中要求密码 (`require_admin_password_for_clear: true`)，你需要输入正确的 `ADMIN_PASS` 才能执行清理缓存等操作。

### 清理缓存

在管理面板中，你可以：
* 点击对应的云盘按钮，清理该云盘的所有缓存。
* 点击红色的“清理所有云盘的缓存”按钮，一次性清除所有缓存。

这在更新了云盘文件后手动刷新内容时非常有用。

---

## ❓ 常见问题 (FAQ)

* **问：为什么我遇到了“重定向次数过多”的错误？**
    * **答**：这个优化版的脚本已经极力避免此问题。如果你仍然遇到，请检查：
        1.  你的 `DRIVE_ROOTS` 环境变量是否**未设置**或**格式完全错误**。
        2.  你是否访问了一个**不存在的盘符索引**（例如 `/99:/`）。
        请使用此脚本的最新版本，它会对这些情况返回明确的错误提示。

* **问：页面提示 `DRIVE_ROOTS` 解析失败怎么办？**
    * **答**：这说明你的 JSON 字符串格式有问题。请严格按照上文“单行格式”的要求检查：
        1.  是否是**单行**？
        2.  是否有多余的**逗号**（尤其是在最后一个 `}` 之后）？
        3.  所有**键名**和**字符串值**是否都用了英文双引号 `"` 包围？

* **问：搜索非常慢怎么办？**
    * **答**：这个脚本的搜索速度现在完全依赖于KV缓存。有两种方式来构建这个缓存：
        1.  **首次搜索时自动构建 (On-Demand)**：当你**首次**在任何一个**未被缓存**的云盘上执行搜索时，脚本会**自动扫描该云盘并构建完整缓存**。这个过程的耗时取决于云盘内文件的数量，但一旦完成，后续的所有搜索都会变得非常快。
        2.  **自动预热 (推荐)**：配置 **Cron 触发器**。它会定时在后台扫描所有云盘并提前建立好缓存。这样可以避免任何用户需要经历“缓慢的第一次搜索”，提供最佳的访问体验。
    * **结论**：请务必确保你已正确配置了 **KV Namespace**。Cron 触发器是获得最佳体验的推荐选项，但即使不配置，脚本也能在首次搜索时按需生成缓存。
