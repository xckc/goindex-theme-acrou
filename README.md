# GoIndex 全方位安全配置指南

这个版本的脚本将所有敏感信息——包括 API 凭证和网盘列表 (`roots`)——全部从代码中分离，改为使用 Cloudflare Workers 的**加密环境变量**来存储。这是官方推荐的、最安全、最灵活的部署方式。

---

## 🚀 配置步骤

您只需要在 Cloudflare 的管理后台完成几个简单的设置。

### 步骤 1：准备您的 API 凭证

请确保您已经拥有以下三个由 Google API 控制台生成的凭证：
1.  `CLIENT_ID`
2.  `CLIENT_SECRET`
3.  `REFRESH_TOKEN`

**重要提示：** 如果您遇到任何问题，请首先尝试**重新生成一套全新的凭证**，因为 `refresh_token` 可能会过期。

### 步骤 2：在 Cloudflare Worker 中设置环境变量

1.  登录到您的 Cloudflare 账户。
2.  在左侧菜单中，进入 `Workers & Pages`。
3.  选择您要配置的 Worker，进入其管理页面。
4.  点击 `Settings` (设置) -> `Variables` (变量)。
5.  在 `Environment Variables` (环境变量) 部分，点击 `Add variable` (添加变量)。

6.  **添加四个加密变量**：
    您需要重复四次“添加变量”操作，并**确保每次都勾选 `Encrypt` (加密)** 选项，以保护您的凭证安全。

    | 变量名 (Variable name) | 值 (Value) |
    | :--- | :--- |
    | `CLIENT_ID` | 粘贴您的 Client ID |
    | `CLIENT_SECRET` | 粘贴您的 Client Secret |
    | `REFRESH_TOKEN` | 粘贴您的 Refresh Token |
    | `DRIVE_ROOTS` | 粘贴您的网盘配置 (JSON 字符串格式) |

    ![环境变量设置示例](https://i.loli.net/2021/11/19/C19k3f5Y8h7cR2U.png)

    **`DRIVE_ROOTS` 格式详解 (最关键的一步):**

    您需要将代码中 `roots` 数组的内容转换为一个**没有换行、严格符合 JSON 语法的字符串**。

    例如，如果您想配置以下两个网盘：
    ```javascript
    // 这是一个 JavaScript 对象，不能直接粘贴
    roots: [
      {
        id: "AAAA",
        name: "我的团队盘",
        user: "gd",
        pass: "BB"
      },
      {
        id: "root",
        name: "我的个人盘"
      }
    ]
    ```
    您需要将其转换为以下**单行字符串**，然后填入 `DRIVE_ROOTS` 环境变量的值中：
    ```
    [{"id":"AAAA","name":"我的团队盘","user":"gd","pass":"BB"},{"id":"root","name":"我的个人盘"}]
    ```
    **检查清单：**
    * 所有键（如 "id", "name"）和字符串值都必须用 **双引号 `"`** 包围。
    * 整个内容必须在**一行**内，不能有换行。
    * 对象与对象之间用逗号 `,` 分隔。
    * 数组的最后一个对象 `}` 后面**不能**有逗号。

### 步骤 3：部署代码

1.  将 `goindex-worker-secure-final.js` 文件中的代码部署到您的 Worker。
2.  点击 `Deploy` (部署) 按钮。

**完成！** 您的 Worker 现在会从安全的环境变量中读取所有配置，代码本身干净且通用。
