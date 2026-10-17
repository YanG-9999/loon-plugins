# loon-plugins

个人 Loon 插件仓库，目前收录：

## WorkBuddy每日签到·派猫猫

每天自动完成 WorkBuddy（腾讯云 AI 助手）的：

- **Buddy 加油站每日签到**：100 积分/天，7 天循环合计 1600 分
- **派猫猫旅行全自动**：空闲自动派出 → 旅行 1-4 小时 → 回来自动领取积分

### 文件

| 文件 | 说明 |
|---|---|
| `workbuddy-checkin.plugin` | 插件配置（Loon 3.5.1+ 新版 Script 语法） |
| `workbuddy-checkin.js` | 脚本本体（令牌捕获 + 签到 + 派猫猫状态机） |
| `test-harness.js` | 本地 mock 测试工具（node test-harness.js） |

### 安装

1. Loon → `配置` → `插件` → `+` → `从 URL 添加`，粘贴：
   `https://cdn.jsdelivr.net/gh/YanG-9999/loon-plugins@v1.0.0/workbuddy-checkin.plugin`
2. Loon → `MITM` → 开启并安装信任 CA 证书（域名已由插件自动追加）
3. iOS 上用 Safari 打开 `www.codebuddy.cn` 登录一次（或打开 WorkBuddy App），令牌自动捕获

### 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| token | 空 | 留空自动捕获；也可手动粘贴 Bearer 令牌 |
| location | 0 | 旅行地点序号，0 = 列表第一个 |
| cronExpr | `0 8,14,20 * * *` | 执行时间，每天 8/14/20 点 |
| notify | 开 | 有实际领取动作或异常时才通知 |

### 说明

- 接口均为 `Authorization: Bearer` 鉴权，双域名（codebuddy.cn / workbuddy.cn）自动切换
- 签到幂等；令牌失效（401）会自动通知重新登录
- 桌面端 token 文件已改为信封加密读不出，故采用 iOS 端抓包捕获方案
