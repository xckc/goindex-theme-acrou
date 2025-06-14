# 描述
goindex-worker-secure-final.js可以用，使用的主题还是原主题的。

cleanServerCache.js想加个按钮手动清空KV缓存，貌似要改主题才能支持，暂未成功。

# GoIndex-CF-Worker 终极优化版

这是一个经过深度优化的 Google Drive 目录索引程序的 Cloudflare Worker 版本。它基于原始 GoIndex 项目，并整合了多项性能和功能增强，旨在提供更快、更稳定、更易于维护的体验。

## ✨ 主要特性

- **🚀 高性能体验**:
  - **懒加载机制 (Lazy-Loading)**: 只有在用户首次访问某个 Drive 时，才会进行初始化。这极大地加快了 Worker 的冷启动速度，特别是当您配置了多个 Drive 时。
  - **全方位 KV 缓存**:
    - 缓存文件和文件夹列表。
    - 缓存文件和文件夹的元数据 (`file`, `findItemById`)。
    - 缓存路径到 ID 的解析结果 (`_findDirId`)。
    - 缓存 ID 到完整路径的解析结果 (`findPathById`)。
    - 通过最大化地利用缓存，显著降低了 Google Drive API 的使用量，避免了因超出配额导致的 403 错误，并提升了后续访问速度。

- **🔐 安全与配置**:
  - **环境变量优先**: 所有敏感信息（`client_id`, `client_secret`, `refresh_token`）和 Drive 配置（`DRIVE_ROOTS`）都通过 Cloudflare 的环境变量进行安全加载，避免了硬编码在代码中的安全风险。
  - **配置自动验证**: 程序启动时会自动检查 `DRIVE_ROOTS` 配置的完整性，确保每个条目都包含 `id` 和 `name`，防止因配置错误导致运行时异常。

- **💪 功能增强**:
  - **集中式 Token 管理**: 所有 Drive 实例共享同一个 Access Token，并使用 KV 缓存进行全局管理，有效避免了在多个实例间重复刷新 Token 的问题。
  - **完善的快捷方式 (Shortcut) 支持**: 能够正确解析并跟随 Google Drive 中的快捷方式，无论是文件还是文件夹。
  - **支持多种 Drive 类型**: 完美支持个人盘 (My Drive)、共享云端硬盘 (Shared Drives) 以及子文件夹挂载。

- **🛠️ 现代化代码结构**:
  - **代码重构**: 对核心请求处理逻辑进行了重构，拆分成了多个职责清晰的模块化函数，使代码更易于理解和二次开发。
  - **详细的中文注释**: 代码库中的关键部分都附有详尽的中文注释，方便开发者理解和维护。

## 部署

1.  **准备 Google Drive API 凭证**:
    - 获取 `client_id`, `client_secret` 和 `refresh_token`。
2.  **配置 Cloudflare Worker**:
    - 创建一个新的 Worker。
    - 将优化后的代码粘贴到 Worker 编辑器中。
    - 在 Worker 的设置中，配置以下环境变量：
      - `CLIENT_ID`: 你的 `client_id`
      - `CLIENT_SECRET`: 你的 `client_secret`
      - `REFRESH_TOKEN`: 你的 `refresh_token`
      - `DRIVE_ROOTS`: 一个 JSON 数组，用于配置要挂载的 Drive。格式如下：
        ```json
        [
          {"id": "root", "name": "个人盘", "pass": ""},
          {"id": "0xxxxxxxxxxxxxx", "name": "共享盘", "pass": "123"},
          {"id": "1yyyyyyyyyyyyyy", "name": "子文件夹", "pass": ""}
        ]
        ```
3.  **绑定 KV Namespace**:
    - 创建一个 KV Namespace (例如，命名为 `GD_INDEX_CACHE`)。
    - 在 Worker 设置中，将这个 KV Namespace 绑定到全局变量 `GD_INDEX_CACHE`。
4.  **保存并部署**！
