# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-10-04

### Added
- 拖放安装器页面（GUI 侧栏「插件安装」+ 独立网页 `/api/plugin-drop/`）。
- 支持拖入解压后的插件文件夹、`.zip`、`.tgz`/`.tar.gz`。
- 官方安装操作适配：桌面端 `lib/plugin-cli.js`（内置 pnpm）+ `dsh` CLI 回退（含 pnpm shim）。
- 进度条：读取阶段按字节给百分比，上传/官方操作阶段用流动条 + 计时。
- 「已暂存的插件包」列表：直接读磁盘，凭据失效后可按路径一键安装/删除。
- 报错解释：英文诊断翻成可操作的中文说明，保留原始文本。
- 诊断日志 `<DSH_HOME>/plugin-drop/plugin-drop.log`。
- ZIP 解包安全防护（zip-slip、CRC、ZIP64 拒绝）。
- 完整测试：离线三套 + 实机验收 + 桌面宿主 harness。

### Changed
- 上下文解析优先使用宿主发布的 `profileContext`，再退回环境变量与 argv。

### Fixed
- 暂存凭据（内存 token）随宿主重启失效导致“拖入成功但装不上”的问题。
- 日志原本只写宿主不可达的 logger，现在落到可读文件。

## [Unreleased]
- 暂无。
