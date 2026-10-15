# omp-deepseek-peak

> 为 [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) 显示 **DeepSeek 账户余额**与**峰谷时段**的扩展。
> An `omp` extension showing your DeepSeek balance, peak/off-peak pricing window, and a countdown to the next switch.

**非官方项目**，与 DeepSeek、oh-my-pi 均无隶属关系。

---

## 为什么需要它

`omp` 内置了很强的额度体系（`omp usage`、`/usage`、状态栏 `usage` 段、`usageAwareFallback` 保护），但它**没有 DeepSeek 的余额能力**——`@oh-my-pi/pi-ai` 内置的 usage provider 覆盖了 Kimi、z.ai、Cursor、Copilot 等，唯独没有 DeepSeek。

更关键的是**峰谷时段**：DeepSeek 的空闲时段价格是高峰的**一半**，而现有工具没有任何一个会告诉你"现在处于哪个时段、还有多久切换"。这个信息直接决定你的实际花费。

本扩展补上这两块。

## 效果

状态栏常驻（每秒更新倒计时，不产生额外请求）：

```
DS ¥377.89 │ 空闲½ │ 4h12m→高峰
DS ¥377.89 │ 高峰 │ 1h23m→空闲
```

在 `omp` 里输入 `/ds` 打开面板：

```
┌────────────────────────────────────────────────────────────┐
│ DeepSeek 余额 · 峰谷时段                                    │
│                                                            │
│ 账户余额                                                    │
│ ¥377.89  总可用余额                                         │
│ 赠金 ¥0.00 · 充值 ¥377.89 · 赠金优先扣减                     │
│ 更新于 12秒前 · 环境变量 DEEPSEEK_API_KEY                    │
│                                                            │
│ 当前时段                                                    │
│ ▌ 空闲·半价                                                 │
│ 工作日但不在高峰窗口内                                       │
│ 距切换到高峰还有 4小时12分（09:00）                          │
│                                                            │
│ 今日                                                        │
│ 2026-10-15 周四 · 高峰 7.0h / 空闲 17.0h                    │
│ 00:00 ░░░░░░░░░████░░░░░░████░░░░░░░░░░ 24:00              │
│                    ▲ 现在                                   │
│ █ 高峰（全价）   ░ 空闲（半价）                              │
│                                                            │
│ 高峰时段规则                                                │
│ 北京时间 周一至周五（非法定节假日）                          │
│ 09:00-12:00 与 14:00-18:00 为高峰                           │
│ 其余时段含周末与法定节假日全天为空闲，价格减半                │
│                                                            │
│ r 刷新余额   Esc/Enter 关闭                                 │
└────────────────────────────────────────────────────────────┘
```

## 安装

```sh
omp plugin install github:Ol925/omp-deepseek-peak
```

然后重启 `omp`。在 `omp` 里输入 `/ds` 验证。

整个安装只占 **约 0.2 MB**（实测 25 个文件），**不需要 `npm install`**——扩展运行时零第三方依赖。
也可以写完整地址 `omp plugin install https://github.com/Ol925/omp-deepseek-peak`。

> 注意前缀是 `github:` 而不是 `git:`。`omp plugin install` 底层走 `bun install` 的依赖说明符解析，
> `git:github.com/...` 会被当成主机名叫 `git` 去解析而失败（那是 pi 的约定，不是 omp 的）。

<details>
<summary>其他安装方式</summary>

**本地目录（开发用，改完即生效，无需重新复制）**

```sh
omp plugin link /path/to/omp-deepseek-peak
```

**手动复制**

```sh
# macOS / Linux
mkdir -p ~/.omp/agent/extensions/deepseek-peak
cp index.ts peak.ts balance.ts holidays.ts update-check.ts \
   ~/.omp/agent/extensions/deepseek-peak/
```

```powershell
# Windows
$target = "$env:USERPROFILE\.omp\agent\extensions\deepseek-peak"
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item index.ts,peak.ts,balance.ts,holidays.ts,update-check.ts $target -Force
```

> 注意：不要把整个仓库 `git clone` 进 `~/.omp/agent/extensions/`。
> `tools/` 和 `tests/` 里也放着 `.mts` 文件（已刻意避开扩展扫描的 `.ts`/`.js` 名单），
> 但用上面两种正规方式安装不会有这个问题。
</details>

## 用法

| 命令 | 说明 |
| --- | --- |
| `/ds` | 打开峰谷面板 |
| `/ds refresh` | 强制刷新余额后打开 |
| `/ds json` | 输出纯文本摘要（非 TUI 模式会自动走这条） |

余额刷新时机：会话启动时、每轮对话结束后（5 分钟节流）、以及手动 `/ds refresh`。
状态栏倒计时每秒重算，纯本地计算，**不产生网络请求**。

## 峰谷规则

来自 [DeepSeek 官方价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)：

> 空闲时段价格为高峰时段价格的一半。北京时间周一至周五（不含中国法定节假日）
> 9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段，包括周末及中国法定节假日
> 全天均为空闲时段。

几个容易被搞错的点：

- **全部按北京时间（UTC+8）计算**，与你本机时区无关。网上大量旧资料写的是 UTC 16:30–00:30 那套**已作废**的方案。
- **工作日午休 12:00–14:00 是空闲的**，所以工作日的高峰只有 7 小时，不是 8 小时。
- **调休上班的周末**：官方措辞是「周末…均为空闲时段」，按字面理解调休周末仍算空闲，这是本扩展的默认行为。如果你认为调休上班日应该按高峰算，设 `OMP_DEEPSEEK_MAKEUP_AS_PEAK=1`。

## 配置

全部通过环境变量，都有默认值，不配也能用。

| 变量 | 作用 |
| --- | --- |
| `OMP_DEEPSEEK_API_KEY` | 直接指定密钥，优先级最高 |
| `DEEPSEEK_API_KEY` | 标准密钥变量 |
| `OMP_DEEPSEEK_AGENT_DIR` | 覆盖 omp 的 agent 目录（默认 `~/.omp/agent`） |
| `OMP_DEEPSEEK_EXTRA_HOLIDAYS` | 追加休息日，逗号分隔，如 `2027-01-01,2027-01-02` |
| `OMP_DEEPSEEK_MAKEUP_WORKDAYS` | 追加调休上班日，格式同上 |
| `OMP_DEEPSEEK_MAKEUP_AS_PEAK` | `1` 时把调休上班的周末按高峰处理 |
| `OMP_DEEPSEEK_HIDE_STATUS` | `1` 时隐藏状态栏段 |
| `OMP_DEEPSEEK_NO_UPDATE_CHECK` | `1` 时完全关闭更新检查（不发任何请求） |

**密钥解析顺序**：`OMP_DEEPSEEK_API_KEY` → `DEEPSEEK_API_KEY` → `<agentDir>/auth.json` →
`<agentDir>/agent.db` 的 `auth_credentials` 表（`provider = 'deepseek'`，即 `omp` 里 `/login` 保存凭据的位置）。

找不到密钥时，面板会明确告诉你查了哪些位置，而不是静默失败。

## 隐私与安全

这个扩展要接触你的 API 密钥，所以把它的行为完整列出来：

**网络请求（仅两处）**

| 目标 | 内容 | 何时 |
| --- | --- | --- |
| `https://api.deepseek.com/user/balance` | 你的 API key（HTTPS） | 会话启动、每轮对话后（5 分钟节流）、手动刷新 |
| `https://registry.npmjs.org/chinese-days/latest` | **仅版本号查询，不含任何凭据或标识** | 每个 omp 进程至多一次，24 小时节流 |

**不做的**：不上传任何数据、无遥测、无统计、不写任何文件、不起子进程、不执行任何来自网络的代码。
更新检查的响应只被当作**数据**解析（读一个 `version` 字符串），不存在代码执行路径。
用 `OMP_DEEPSEEK_NO_UPDATE_CHECK=1` 可以连第二个请求一起关掉。

**读取的本地文件**：`<agentDir>/auth.json`（若存在）、`<agentDir>/agent.db`（**只读**打开）。
密钥只发往 DeepSeek 官方端点，不会经过任何第三方。

## 维护节假日数据

内置日历来自 [vsme/chinese-days](https://github.com/vsme/chinese-days)，其数据转写自国务院办公厅每年的
节假日安排通知（已与[国办发明电〔2025〕7 号](https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm)逐条核对 2026 年）。

**每年 11 月前后**国务院公布次年安排、上游包跟进后，扩展会在面板和一次性通知里提示你更新。
更新是**手动确认**的，不会自动改你的文件：

```sh
npm install chinese-days@latest
npm run gen-holidays
npm run deploy
```

日历未覆盖某年时，面板会显示明确警告，而不是静默把节假日当成高峰。

## 开发

**环境要求**：`omp`（扩展运行在它内置的 Bun 上）+ Node 22.6 以上。测试是 `.mts` 直接由 `node`
执行，依赖 Node 原生的 TypeScript 支持；本仓库在 Node 24 上验证。

```sh
npm install
npm run preflight   # 发布前检查：清单、files 白名单、gitignore、占位符
npm run typecheck   # 类型检查（strict，不产出任何文件）
npm test            # 峰谷 43 项 + 更新检查 18 项自检
npm run gen-holidays
npm run deploy      # 部署到 ~/.omp/agent/extensions/deepseek-peak
npm run verify      # 只比对两边是否同步，不同步则非零退出
```

### 文件说明

**运行时（真正被 omp 加载，共 5 个）**

| 文件 | 作用 |
| --- | --- |
| `index.ts` | 入口：注册 `/ds` 命令、状态栏、生命周期钩子 |
| `peak.ts` | 峰谷计算纯逻辑（北京时间、节假日判定、切换点、时间轴分段） |
| `balance.ts` | 余额接口与密钥解析 |
| `holidays.ts` | 节假日数据，**由 `tools/gen-holidays.mjs` 生成，但必须提交**（用户通过 Git 安装，不会跑生成器） |
| `update-check.ts` | 上游版本号检查 |

**仅开发用**：`tools/`、`tests/`、`types/`、`tsconfig.json`、`node_modules/`。

**扩展运行时零第三方依赖**——上面 5 个文件只用到 Node 内置模块和 omp 宿主自己提供的
`@oh-my-pi/pi-tui`，因此安装后不需要 `npm install`，也没有依赖可以过期或被投毒。

## 限制

- DeepSeek **没有**提供 token 用量或消费历史接口，因此本扩展只呈现余额本身，
  不做「峰谷用量占比」统计——那需要解析本地会话日志。
- 消耗速率不展示：余额是账户级的，无法归因到单个会话。
- 走 Node/Bun 内置 `fetch`，不读取 `HTTPS_PROXY`。
- 更新检查失败会静默忽略，不影响任何功能。

## 许可

[MIT](./LICENSE)
