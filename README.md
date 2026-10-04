# dsh-plugin-drop

> **把插件包拖到 DSH 里，就装好了。** / Drop a plugin package into DSH and it is installed.
>
> 一个 DeepSeek Harness 插件：把解压后的插件文件夹、`.zip` 或 `.tgz` 拖进一个页面，
> 它会自动登记 profile 依赖、建立链接、重组 `dsh.profile.bundles` —— 与官方
> `dsh plugin add <path>` 的结果完全一致。

**Made by DSH（DeepSeek Harness）** — 本项目由 DSH 制作：宿主半身、浏览器半身、零依赖 ZIP
读取器、测试与文档，都是在一场 DSH 会话里由 DSH 智能体编写并逐项实测的。
_This project was made by **DSH (DeepSeek Harness)** — written and verified end-to-end by a DSH agent inside a DSH session._

---

## What it is / 这是什么

`dsh-plugin-drop` adds a **drag-and-drop installer page** to DSH's Web GUI. It does not
re-implement installation: it stages what you drop, then runs the same official profile
operation that `dsh plugin add` runs (the desktop adapter `lib/plugin-cli.js`, or the `dsh`
CLI as a fallback). The resulting profile state — the `link:` entry in `dependencies`, the
link in `node_modules`, and the new layer in `dsh.profile.bundles` — is byte-for-byte what
the official command produces.

- **两个入口**：GUI 侧栏「插件安装」；独立网页 `http://127.0.0.1:<port>/api/plugin-drop/`
- **拖入即装**：解压后的插件文件夹（含 `package.json`）、`.zip`（自动解包并定位包根）、`.tgz` / `.tar.gz`
- **进度条**：`读取拖入的文件`（可测阶段给百分比）→ `上传并暂存到磁盘` → `执行官方安装操作` → `完成/已停止`
- **实时日志**：官方操作（pnpm / Loader）的原始输出
- **已暂存的插件包**：直接读磁盘，每条都能「安装 / 删除」——宿主重启也不会丢，拖入成功但没装上时在这里一键补救
- **报错解释**：英文诊断会翻成一句可操作的中文说明，原始文本并排保留
- **诊断日志**：`<DSH_HOME>/plugin-drop/plugin-drop.log`，记录每次暂存、安装启动、结果与失败原因

## Install / 安装

> 装好后**重启 DSH**（或打开设置 → 插件 → 找到 `dsh-plugin-drop` 关掉再打开，让 HMR 重组）才会加载。

**方式一 · 官方插件管理器（推荐，桌面端可用）**
设置 → 插件 → 添加插件 → 填入：

```
github:sf-cai5/dsh-plugin-drop
```

**方式二 · CLI profile（`dsh web` 等非 desktop profile）**

```bash
dsh plugin --profile web add github:sf-cai5/dsh-plugin-drop
```

**方式三 · 本地目录（克隆下来，路径安装）**

```bash
git clone https://github.com/sf-cai5/dsh-plugin-drop
dsh plugin --profile web add /绝对路径/到/dsh-plugin-drop
```

> 路径安装会记成 `link:`，那个目录就是插件的常驻位置，装好后**不要删除**。

## Usage / 怎么用

1. 把插件文件夹或压缩包拖进虚线框，松手即开始安装。
2. 进度条给出阶段与可测百分比；官方操作阶段用流动条 + 已用时间（不编造百分比）。
3. 完成后按提示重启；「当前 profile 的插件」列出已装插件，可直接卸载。

文件夹太大时用「从本地路径或包名安装」直接填**绝对路径**（不经过上传），也接受包名、Git 地址与 `.tgz`。

## How it works / 实现

```
index.js            宿主半身：/api/plugin-drop 前缀路由（webServer.register）
client.js           浏览器半身：手写 ModuleLoader bundle（无构建步骤），注册 sidebar.panellist + main
page.html           独立网页（同一套 HTTP 接口）
lib/zip.js          零依赖 ZIP 读取器（store/deflate、UTF-8/GBK 文件名、CRC、路径穿越防护）
lib/stage.js        暂存、包根定位、清单校验、噪声过滤、暂存列表
lib/install.js      profile 上下文解析 + 官方操作适配器 + 任务日志
lib/log.js          诊断日志（append-only，自动轮转）
cordis.patch.yml    bundle patch：一行 insert 挂载宿主半身
docs/               问题解决说明
test/               离线测试 + 实机验收 + 桌面宿主 harness
```

- **上下文来源**：优先 `ctx.profileContext`（与官方插件管理器同源），退回 `DSH_HOME` / `DSH_PROFILE_DIR` / 宿主 argv。
- **官方适配器**：优先 `<app>/lib/plugin-cli.js`（桌面端使用内置 pnpm）；缺失时退回 `dsh plugin --profile <name>`，并为它生成一个指向内置 pnpm 的 shim。
- **浏览器半身**：只依赖 shell 提供的 `react` 与 UI primitives 两个平台种子模块。

## Security / 安全边界

这个页面能安装并运行任意代码，因此：

- **只响应本机回环请求**：非 `127.0.0.1` / `::1` 一律 403。
- **变更请求必须带 `x-plugin-drop: 1` 且为 JSON**：跨站表单无法设置该请求头，浏览器先发预检——挡掉 CSRF。
- **ZIP 解包防护**：拒绝 `../`、盘符与绝对路径条目（zip-slip），逐条校验 CRC；不支持 ZIP64 时明确报错而不是误读。
- **上传上限**：64 MiB（base64 前）；更大用绝对路径。

## Tests & verification / 测试与验证

```bash
npm test        # 离线：解包/暂存、宿主路由端到端、浏览器半身契约
npm run test:live -- http://127.0.0.1:<port> /path/to/a/plugin
node test/harness/desktop-host.mjs <scratchHome> <scratchHome>/profiles/<name> <port>
```

- `test/stage.test.mjs` —— 真实 Windows ZIP、目录拖入、恶意压缩包（穿越/CRC）、校验分支。
- `test/host.test.mjs` —— 用桩 CLI 跑完整 HTTP 流程，断言最终交给官方操作的 argv 就是 `<profile> add <绝对路径>`；含全部拒绝分支。
- `test/client.test.mjs` —— 用应用自带的 React 驱动浏览器半身：ModuleLoader 契约、两处 slot 注册、页面三态渲染。
- `test/live.test.mjs` —— 对真实运行的 DSH 拖入一个真实插件（目录 + ZIP），校验依赖/链接/插件层，最后卸载复原。
- `test/harness/desktop-host.mjs` —— 用应用自己的方式启动桌面版宿主（含必需 IPC），指向 scratch profile，跑生产组合。

已在两种真实组合上跑通：`dsh web` 启动的 profile，以及桌面组合（`lib/host.js` + `NextWebServer` + 使用内置 pnpm 的 `plugin-cli` 适配器）。

## Troubleshooting / 排障

见 **[docs/问题解决说明.md](docs/问题解决说明.md)**：症状对照表、报错解释、诊断证据位置、等价命令与回滚。

## Limitations / 限制

- 不是插件市场：不提供搜索、版本列表与自动更新；升级 = 卸载后重新安装。
- 大文件夹拖拽受上传上限约束，请改用绝对路径。
- 仅供本机使用：从其他设备访问 DSH 的 GUI 时，这个页面会拒绝工作。

## License

[MIT](LICENSE)

## Credits / 制作说明

**Made by DSH（DeepSeek Harness）** — 宿主半身、浏览器半身、ZIP 读取器、测试与文档均由 DSH
在一次会话中编写并实测；仓库由 sf-cai5 发布。
