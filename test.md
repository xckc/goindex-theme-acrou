# GoIndex Worker 增强版

这是一个功能增强版的 GoIndex Cloudflare Worker 脚本，用于在 Cloudflare 边缘网络上索引和展示 Google Drive 文件。此版本在原版基础上进行了大量优化，重点提升了性能、安全性和可管理性。

## ✨ 主要特性

- **⚡️ 高性能 KV 缓存**：通过利用 Cloudflare KV 作为缓存层，大幅减少对 Google Drive API 的请求，显著加快文件列表的加载速度。
- **🕒 计划任务 (Cron) 缓存预热**：可配置 Cron 触发器，在低峰时段自动、递归地获取所有文件列表并写入缓存。这能确保用户访问时几乎总是命中缓存，获得极速体验。
- **🔐 安全优先的配置**：敏感凭证（如 `client_id`, `client_secret`, `refresh_token`）和云盘配置 (`DRIVE_ROOTS`) 均从 Cloudflare 的环境变量中安全加载，避免了硬编码在代码中的安全风险。
- **⚙️ 后台管理面板**：内置一个简单的管理面板 (`/admin`)，用于手动清理指定云盘或所有云盘的 KV 缓存，方便维护。
- **🔑 管理面板密码保护**：可选为管理面板设置密码，防止未经授权的缓存清理操作。
- **🗂️ 灵活的云盘支持**：支持多种类型的云盘挂载，包括个人盘 (My Drive)、共享云盘 (Shared Drives) 以及子文件夹。
- **🔗 快捷方式解析**：能够自动解析 Google Drive 中的快捷方式（shortcuts），直接指向目标文件或文件夹。

## 🚀 部署与配置

通过 Cloudflare Dashboard 或使用 `wrangler` CLI 工具进行部署。部署前，请务必在 Worker 的设置中配置以下环境变量和 KV 命名空间。

### 1. 绑定 KV 命名空间

1. 在 Cloudflare Dashboard 中，进入 **Workers & Pages** -> **KV**。
2. 创建一个新的 KV 命名空间，例如，可以命名为 `GD_INDEX_CACHE`。
3. 回到您的 Worker，进入 **Settings** -> **Variables**。
4. 在 **KV Namespace Bindings** 部分，点击 **Add binding**。
5. 将变量名称设置为 `GD_INDEX_CACHE`，并选择您刚刚创建的 KV 命名空间。

### 2. 配置环境变量

在 Worker 的 **Settings** -> **Variables** -> **Environment Variables** 部分，点击 **Add variable** 添加以下变量：

| 变量名          | 是否必须 | 描述                                                         | 示例                                                         |
| --------------- | -------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| `CLIENT_ID`     | **是**   | 您的 Google API Client ID。                                  | `xxxxxxxx.apps.googleusercontent.com`                        |
| `CLIENT_SECRET` | **是**   | 您的 Google API Client Secret。                              | `GOCSPX-xxxxxxxx`                                            |
| `REFRESH_TOKEN` | **是**   | 您的 Google API Refresh Token。                              | `1//xxxxxxxx`                                                |
| `DRIVE_ROOTS`   | **是**   | JSON 数组格式的云盘配置。**必须是有效的 JSON 字符串**。      | `[{"name":"My Drive","id":"root"},{"name":"ShareDrive","id":"0ABxxxxxxxxxxxx","protect_file_link":true}]` |
| `ADMIN_PASS`    | **否**   | 用于访问 `/admin` 管理面板的密码。如果 `require_admin_password_for_clear` 在代码中为 `true`，则此项为**必须**。 | `your_strong_password`                                       |

## 🕒 配置计划任务 (Cron 触发器)

为了充分利用缓存，强烈建议配置 Cron 触发器来定时预热缓存。

1. 在您的 Worker 设置中，进入 **Triggers** 选项卡。
2. 在 **Cron Triggers** 部分，点击 **Add Cron Trigger**。
3. 设置您的 Cron 表达式。

### **‼️ 重要提示：时间标准**

Cloudflare Cron 触发器使用 **UTC (协调世界时)** 时间标准，而不是您本地的时间。在设置时，请务必将您的本地时间转换为 UTC 时间。

**上海时间 (CST, UTC+8) 换算示例：**

假设您希望在**每天上海时间凌晨 3:00** 执行缓存预热任务。

- **换算公式**: `UTC 时间 = 上海时间 - 8 小时`
- **计算**: `03:00 (上海) - 8小时 = 前一天的 19:00 (UTC)`

因此，您应该设置的 Cron 表达式为：

```
0 19 * * *
```

## ⚙️ 管理面板

此脚本提供了一个简单的管理页面，用于手动清理缓存。

- **访问地址**： `https://your-worker-domain.com/admin`
- **功能**：
  - 如果配置了 `ADMIN_PASS` 环境变量，需要输入正确的密码。
  - 提供按钮，可以单独清理每个已配置云盘的缓存。
  - 提供一个总按钮，可以一次性清理所有云盘的缓存。
- **用途**：当您更新了 Google Drive 中的文件，并且希望更改立即生效时，可以使用此功能强制刷新缓存。

## 📝 `DRIVE_ROOTS` 配置详解

`DRIVE_ROOTS` 环境变量必须是一个 JSON 数组字符串。每个对象代表一个要挂载的云盘。

```
[
    {
        "name": "个人云盘",
        "id": "root",
        "user": "",
        "pass": ""
    },
    {
        "name": "共享盘A",
        "id": "0Axxxxxxxxxxxxxxxxx",
        "protect_file_link": true
    },
    {
        "name": "子文件夹B",
        "id": "1Bxxxxxxxxxxxxxxxxx"
    }
]
```

- `name`：显示在前端的云盘名称。
- `id`：
  - 对于个人云盘根目录，使用 `"root"`。
  - 对于共享云盘，使用其 ID (可以在浏览器地址栏中找到)。
  - 对于子文件夹，使用其 ID。
- `user`, `pass`：(可选) 为该云盘设置 Basic Auth 密码保护。
- `protect_file_link`：(可选, `true` 或 `false`) 如果为 `true`，文件的直接下载链接也会受到 Basic Auth 的保护。
