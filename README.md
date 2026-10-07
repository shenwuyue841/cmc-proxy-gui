# cmc-proxy-gui

**Command Code GOAT 套餐**的本地反代网关与图形控制台。

本项目将 Command Code 的 Provider API 反代至本机 `127.0.0.1:5411`，使 **Claude Desktop**（自定义推理网关模式）与 **Claude Code** 能够接入 GOAT 套餐；同时提供一个本地网页控制台，用于管理模型映射、查看用量与费用、查询官方额度以及控制代理进程。

仓库已包含反代核心 `proxy.js`，下载后即可直接运行，无需另行获取其他组件。

![控制台概览](docs/console-overview.png)

---

## 背景

Command Code 的 Provider API 按模型族划分三套端点：

| 模型族 | 端点 |
|---|---|
| Claude 系 | `/v1/messages` |
| GPT 系 | `/v1/chat/completions` |
| 其余开源模型 | `/v1/chat/completions` 或 `/v1/responses` |

常见的反代管理工具（例如 CC Switch）中，一个供应商只能绑定一种协议格式，启用其中一种即无法同时服务其余端点；切换供应商之后还需重新建立会话方可生效。

本项目依据模型名称自动路由至对应端点，客户端只需配置单一地址。在此之上，`gui.js` 提供网页控制台，将配置、统计与进程管理集中到同一界面。

---

## 功能

| 页面 | 说明 |
|---|---|
| **概览** | 费用与额度消耗、请求数、输入输出 token、真实消耗 token、缓存命中率；费用柱状图（按小时 / 按天随区间切换）、按模型汇总、请求明细（含请求模型与实际转发模型）。统计区间可选**今天（0 点起）/ 最近 24 小时 / 最近 7 天 / 最近 30 天** |
| **官方额度** | 查询官方 5 小时 / 周 / 月限额与重置时间，并与本地统计进行同口径对比 |
| **模型映射** | 四个主力档位以下拉框编辑，保存时自动同步 `[1M]` 变体 |
| **代理控制** | 启动与停止、实例归属判定、结构化日志开关、实时输出 |
| **费用试算** | 依据官方牌价即时估算，含分项拆分 |
| **原始配置** | 直接编辑 `config.json` |
| **设置** | 上游地址、API Key、出网代理与端口，无需手动编辑 JSON 文件 |

### 模型映射

四个主力档位（Opus / Fable / Sonnet / Haiku）各自对应一个客户端模型标识，可分别映射至任意上游模型；保存时自动同步 `[1M]` 上下文变体。

![模型映射](docs/console-mapping.png)

### 官方额度的同口径对比

控制台通过以下四个只读接口获取官方数据，查询本身不消耗额度：

| 接口 | 返回内容 |
|---|---|
| `/alpha/whoami` | 账号信息 |
| `/alpha/billing/credits` | 余额，以及 5 小时与周滚动窗口的 `used` / `cap` / `resetAt` |
| `/alpha/billing/subscriptions` | 套餐标识、订阅状态、计费周期起止 |
| `/alpha/usage/summary` | 周期内的费用、请求数与 token 统计 |

上述接口不接受时间区间参数，因此控制台根据 `resetAt` 反推窗口起点（5 小时窗口为 `resetAt − 5h`，周窗口为 `resetAt − 7d`），再将本地 JSONL 日志按同一区间聚合，得到口径一致的两个数值。

实测 5 小时窗口：官方 `0.410252`，本地 `0.410201`，偏差约 `0.02%`，可确认本地依据牌价计算的 `credit` 与官方计费口径一致。覆盖不足的窗口会标注「区间不全，不可比」，避免以不同口径的数值作对比。

---

## 快速开始

### 环境要求

- Node.js ≥ 18（依赖内置 `fetch` 与 `ReadableStream`）
- Windows 可直接使用启动脚本；macOS / Linux 可使用命令行方式启动，界面本身跨平台

### 第一步：启动

```
Windows         双击 start-gui.bat
macOS / Linux   node gui.js --auto-start --open
```

浏览器会自动打开 `http://127.0.0.1:5419`。控制台与代理运行在同一进程组内，关闭该窗口即同时停止两者。

首次启动时若目录里没有 `config.json`，控制台会从 `config.example.json` 自动生成一份（`apiKey` 为空），
**不需要手工复制文件**。

> 仅需反代、不需要控制台时：`node gui.js --proxy-only` —— 它同样会先按 `gui.config.json`
> 配好出网代理，再启动 `proxy.js`，不会占用控制台端口。

### 第二步：在控制台里完成配置

打开左侧「**设置**」页，三项配置都在同一页面完成，无需编辑任何文件：

| 顺序 | 位置 | 操作 | 如何确认成功 |
|---|---|---|---|
| ① | 上游连接 → **API Key** | 填入 Command Code 的密钥（`user_` 开头） | 点「测试连接」→ 显示 *Key 有效 · 上游返回 N 个模型* |
| ② | 官方额度 → **出网代理** | 直连不通时填本地代理，v2rayN 默认为 `http://127.0.0.1:10809` | 点「测试」→ 显示 *官方接口通 · 账号 xxx* |
| ③ | 模型牌价 → **立即生成** | 点一下按钮，无需命令行 | 状态由「缺失」变为「已就绪」 |

![设置页](docs/console-settings.png)

- **① 为必需项**；② 与 ③ 可选 —— ② 只影响「官方额度」页，③ 只影响费用统计与「费用试算」
- ③ 拉取的是公开价格页面，**不需要 API Key**，也不需要 `goat-prices.json` 事先存在
- 修改端口或出网代理后需重启控制台。原因是 Node 在进程启动时即确定是否启用环境变量代理，
  启动后再设置无效（控制台会自动携带新代理重启一次自身）

> 更习惯命令行的话，也可以直接编辑 `config.json` 填入 `apiKey`、并在目录下执行 `node goat-prices.js`，
> 效果与上表完全一致。文件层面的说明见下方「配置文件」。

### 第三步：接入客户端

Claude Desktop 的配置见「[接入 Claude Desktop](#接入-claude-desktop)」一节；
Claude Code 与 Codex 使用同一个网关地址 `http://127.0.0.1:5411`，配置方式参见上游项目文档。

---

## 目录结构

```
cmc-proxy-gui/
├── proxy.js               # 反代核心：协议转换、模型路由、失败轮换、缓存优化
├── config.example.json    # 配置模板，复制为 config.json 后填写
├── goat-prices.js         # 拉取模型牌价，生成 goat-prices.json
├── gui.js                 # 控制台后端
├── gui.html               # 控制台前端（单文件，无外部依赖）
├── gui.config.json        # 控制台自身配置，首次运行自动生成
├── start-gui.bat          # Windows：启动控制台与代理（推荐入口）
├── build.js               # 导出 release 目录
├── schemas.md             # 数据结构与样例参考
├── goat-prices.schema.md  # 牌价文件字段定义
├── LICENSE                # MIT
└── docs/                  # 截图
```

---

## 配置文件

日常使用不需要接触文件 —— 全部配置都在控制台的「设置」页完成（见上文「快速开始」）。
以下是文件层面的说明，便于手工部署或二次开发。

**控制台自身的配置**：`gui.config.json`，首次运行自动生成，共 4 项。

```json
{
  "port": 5419,           // 控制台监听端口
  "proxy": "",            // 出网代理，例：http://127.0.0.1:10809；留空 = 直连
  "officialApi": true,    // 是否启用「官方额度」查询
  "title": "cmc 控制台"    // 侧边栏标题
}
```

`proxy` 之所以必须由进程启动时确定：Node 在进程引导阶段就决定是否启用环境变量代理
（`NODE_USE_ENV_PROXY` / `HTTPS_PROXY`），启动之后再设置无效。因此控制台若发现配置中的代理
尚未进入环境变量，会**携带该代理重新执行自身一次**，从而保证从任何入口启动都能正确出网。

**上游配置**：`config.json`，由反代核心 `proxy.js` 读取，含 `port`、`host`、`upstream`、
`apiKey`、`modelMap`、`defaultModels` 等。控制台的「原始配置」页就是它的编辑器；
`apiKey` 在该页面始终以掩码 `user_****末4位` 显示，明文不会下发到浏览器。

**模型牌价**：`goat-prices.json`，由 `goat-prices.js` 生成，是费用统计与「费用试算」的价格来源。
可在控制台里一键生成，或手动执行：

```bash
node goat-prices.js
```

> 该脚本在控制台之外运行，不会自动继承控制台的代理设置。若本机需经代理访问外网，
> 执行前设置 `HTTP_PROXY` 与 `HTTPS_PROXY`，并加上 `NODE_USE_ENV_PROXY=1`。

---

## 接入 Claude Desktop

Claude Desktop 的第三方推理网关模式支持自定义网关地址。打开 **Settings → Connection**：

![Claude Desktop Connection 设置](docs/claude-desktop-connection.png)

| 字段 | 取值 |
|---|---|
| Credential kind | `Static API key` |
| Gateway base URL | `http://127.0.0.1:5411`，**结尾不要带 `/v1`**，端点由请求路径决定 |
| Gateway API key | 任意非空值，代理不校验客户端密钥 |
| Gateway auth scheme | `bearer` |

点击 **Test connection**，通过后返回主界面并**新建会话**（已有会话不会重新读取配置）。

### 修改模型显示名称

未配置 Model list 时，Claude Desktop 会读取网关的模型列表，并以 Claude 档位的形式展示上游模型标识，界面所示名称与后端实际模型并不一致。可在 Connection 下方手工添加 Model list 条目加以区分：

| Model ID | Display name | Tier alias |
|---|---|---|
| `claude-opus-5` | `GPT-6 Luna` | `opus` |
| `claude-fable-5` | `Claude Sonnet 5.5` | `fable` |
| `claude-sonnet-5` | `DeepSeek V4.1 Flash` | `sonnet` |
| `claude-haiku-4-5` | `MiniMax M3` | `haiku` |

- **Model ID 需与配置一致**：该标识由代理按 `modelMap` 转发至实际模型，显示名称可自由填写
- **Tier alias** 决定 Claude Desktop 内部将该模型视作哪个档位，影响子任务与快速档的路由
- `Offer 1M-context variant` 按需开启；`Max effort` 仅适用于支持该参数的模型

> 上表所列 Model ID 对应默认映射中的四个档位。若在「模型映射」页调整过映射，此处标识需同步。

Claude Code 与 Codex 使用同一网关地址，配置方式参见上游项目的对应章节。

---

## 安全说明

- 服务仅监听 `127.0.0.1`，不对外网开放
- **明文 API Key 不会下发至浏览器**：`/api/config` 返回的 `apiKey` 始终为掩码形式 `user_****末4位`，回写时识别掩码并保留磁盘原值。因此「原始配置」页显示的是掩码，保存操作不会破坏密钥
- 默认仅允许停止控制台自身启动的代理进程；停止外部实例需显式使用「强制停止」并二次确认
- 写入 `config.json` 前自动备份至 `backups/`

部署或二次开发时，请确认以下条目已加入忽略列表：

```gitignore
config.json          # 含 API Key
gui.config.json
backups/             # 自动备份为 config.json 的完整副本，同样含 API Key
*.jsonl              # 结构化请求日志，含请求内容
proxy.log
```

`backups/` 最易遗漏：仅忽略 `config.json` 并不足够，备份文件中包含完整密钥副本。

---

## 致谢

本项目的反代核心 `proxy.js`，以及其中的协议转换、模型决策、失败轮换与前缀缓存优化等设计，来自开源项目 [cwf818/cmc-proxy](https://github.com/cwf818/cmc-proxy)。感谢原作者的工作。

本仓库在此基础上补充了图形控制台、官方额度查询与用量同口径对比等功能。

## License

[MIT](LICENSE)
