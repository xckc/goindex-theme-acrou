# GoIndex-CF-Worker-Optimized

这是一个基于 `goindex` 项目的 Cloudflare Worker 版本，经过了深度优化，旨在提供更强的**安全性**、更高的**性能**和更好的**稳定性**。

它将您的 Google Drive 变身为一个易于浏览和分享的网盘目录网站，并完全运行在 Cloudflare 的免费服务上。

![网页截图](https://i.loli.net/2021/11/19/lVwxKP2q3OFpYQI.png)

---

## ✨ 核心优化特性

-   **🔒 更安全的凭证管理**：不再将 `client_id`、`client_secret`、`refresh_token` 以及 **`roots` 网盘配置** 硬编码在代码中。所有敏感信息都存储在 Cloudflare 的 **加密环境变量 (Secrets)** 中，杜绝了代码泄露导致的安全风险。

-   **⚡️ 更快的加载速度**：通过重构初始化逻辑，所有网盘驱动器仅在 Worker 实例启动时初始化一次。后续的用户请求直接使用已就绪的实例，大大减少了处理延迟。

-   **🗂️ 强大的 KV 缓存**：全面利用 Cloudflare KV 存储来缓存文件列表、文件元数据、搜索结果和路径解析。这显著降低了对 Google Drive API 的请求频率，避免了速率限制，并极大地提升了浏览速度。

-   **🦾 更稳健的逻辑**：优化了对 Google Drive 快捷方式 (Shortcuts) 的处理，能正确解析其目标并进行索引。同时增强了错误处理机制，让问题排查更轻松。

-   **🔎 优化的搜索功能**：为不同类型的驱动器（个人盘、团队盘、子文件夹）提供了更高效的搜索策略。

---

## 🚀 部署指南

部署过程非常简单，仅需三个步骤。

### 步骤 1：获取 Google Drive API 凭证

您需要准备三个关键凭证：
1.  `CLIENT_ID`
2.  `CLIENT_SECRET`
3.  `REFRESH_TOKEN`

如果您不清楚如何获取，可以参考网络上的相关教程，例如 [这篇教程](https://www.hostloc.com/thread-579999-1-1.html) 或搜索“Google Drive API refresh_token 获取”。

### 步骤 2：配置 Cloudflare Worker

1.  登录到您的 Cloudflare 账户。
2.  在左侧菜单中，进入 `Workers & Pages`。
3.  点击 `Create application` > `Create Worker`，然后为您的 Worker 命名（例如 `my-drive-indexer`）并部署。

4.  **绑定 KV 命名空间 (必须)**
    -   返回 Worker 概览页面，点击 `Settings` > `KV`。
    -   点击 `Create a namespace`，输入一个名称，例如 `GD_INDEX_CACHE`。
    -   返回 Worker 的 `Settings` 选项卡，在 `KV Namespace Bindings` 下点击 `Add binding`。
    -   将 `Variable name` 设置为 `GD_INDEX_CACHE`，并选择您刚刚创建的 KV 命名空间。

5.  **设置加密环境变量 (最重要的一步)**
    -   在 Worker 的 `Settings` > `Variables` 选项卡下，找到 `Environment Variables` 部分。
    -   点击 `Add variable`，**并确保勾选 `Encrypt`**，将其变为安全的 Secret。
    -   依次添加以下变量：
        -   **`CLIENT_ID`**: 填入您的 Client ID。
        -   **`CLIENT_SECRET`**: 填入您的 Client Secret。
        -   **`REFRESH_TOKEN`**: 填入您的 Refresh Token。
        -   **`DRIVE_ROOTS`**: (推荐) 用于安全存储您的网盘配置。将您的 `roots` 数组转换为 JSON 字符串后填入。

    ![环境变量设置示例](https://i.loli.net/2021/11/19/C19k3f5Y8h7cR2U.png)

    **`DRIVE_ROOTS` 格式示例:**

    您需要将代码中 `roots` 数组的内容转换为一个**没有换行的 JSON 字符串**。例如，以下配置：
    ```javascript
    roots: [{
        id: "YOUR_TEAMDRIVE_ID",
        name: "TeamDrive",
        user: "user1",
        pass: "pass123"
      }, {
        id: "root",
        name: "PrivateDrive"
      }]
    ```
    应转换为以下**单行字符串**后，再填入 `DRIVE_ROOTS` 环境变量的值中：
    ```
    [{"id":"YOUR_TEAMDRIVE_ID","name":"TeamDrive","user":"user1","pass":"pass123"},{"id":"root","name":"PrivateDrive"}]
    ```
    **注意：** 如果设置了此环境变量，它将**覆盖**代码中预留的 `roots` 备用配置。

### 步骤 3：部署代码

1.  回到 Worker 的 `Code` 界面（点击 `Edit code`）。
2.  **将 `goindex-worker-optimized.js` 文件中的全部代码** 复制并粘贴到 Cloudflare 的在线编辑器中，完全覆盖原有代码。
3.  （可选）如果您不想使用环境变量来配置 `roots`，也可以直接修改代码中的 `authConfig.roots` 备用配置。
4.  点击 `Deploy` 保存并部署。

**恭喜！** 您的 Google Drive 索引网站现在已经成功部署。

---

## ⚙️ 详细配置说明

### `authConfig`

| 参数 | 说明 | 示例 |
| --- | --- | --- |
| `siteName` | 网站左上角显示的名称。 | `"My Drive"` |
| `theme` | 使用的主题，通常保持 `"acrou"`。 | `"acrou"` |
| `enable_kv_cache` | 是否启用 KV 缓存。**强烈建议保持 `true`**。 | `true` |
| `kv_cache_ttl` | KV 缓存的有效期（秒）。 | `3600` (1小时) |
| `roots` | 要挂载的驱动器/文件夹列表（数组）。**建议通过 `DRIVE_ROOTS` 环境变量配置。** | ` ` |
| `default_gd` | 默认显示的 `roots` 数组索引。 | `0` (显示第一个) |
| `files_list_page_size` | 文件夹列表每页显示的项目数。 | `200` |
| `search_result_list_page_size` | 搜索结果每页显示的项目数。 | `50` |
| `enable_password_file_verify` | 是否启用目录下的 `.password` 文件保护。 | `false` |

### `themeOptions`

此部分用于配置前端主题的外观和功能，通常无需修改。

| 参数 | 说明 |
| --- | --- |
| `cdn` | 主题静态文件的 CDN 地址。 |
| `version` | 主题的版本号。 |
| `languages` | 默认界面语言 (`en`, `zh-chs`, `zh-cht`)。 |
| `render` | 控制是否渲染 `HEAD.md` 和 `README.md` 文件。 |
| `video` / `audio` | 内置播放器的相关配置。 |

---
## 致谢

此项目基于原始 `goindex` 项目及其社区贡献者的辛勤工作。本次优化旨在使其在 Cloudflare Workers 环境下更安全、更高效地运行。
