# dsh-toolbox-web

[English](README.en.md) | [简体中文](README.md)

![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)
![Node](https://img.shields.io/badge/node-%3E%3D22.13-blue)
![dsh](https://img.shields.io/badge/dsh-plugin-ready-4caf50.svg)

> dsh（DeepSeek Harness）增强工具箱插件：会话管理 / 回收站 / 子目录管理 / 全文搜索 / 预设编辑 / 配置编辑 / 归档管理。

## ✨ 功能

- **💬 会话管理**：删除（进回收站）、复制（官方 fork + 「-副本x」命名）、移动（工作区之间）、重设工作区根、标签分组（点选式编辑器：已有标签点击即选，避免手输错；标签管理：删除/重命名，重命名可合并重复标签）、查看会话内容（只读）、对话管理（截断/编辑，默认关闭需显式开启）、空会话自动标注「（空会话）工作区名」
- **⏰ 定时心跳**：定时唤醒 AI 执行巡检/汇报等任务（类似 OpenClaw 心跳模式）——两种调度：**间隔心跳**（每 N 分钟）与**定点定时**（每天几点 / 每周几 / 每月几号），各自独立提示语与目标；目标可选**主工作区根（内部巡检）或任意会话，以及 📱 微信 / QQ / 飞书 IM 渠道**（唤醒渠道 bot 执行任务并把 AI 回复推送回手机）。调度运行在 **dsh 后端进程**中——**无需保持网页打开**，dsh 服务运行即生效。渠道推送为**可选集成**：依赖自研渠道桥插件 dsh-msg-hub 提供的 `dsh-channels-push` 服务（见下文「IM 渠道推送（可选）」），未安装时自动回退主工作区心跳
- **📃 长消息折叠**：消息超过阈值行数（默认 15，可调）自动折叠显示，点击「展开全部」查看；用户消息默认开启，AI 回复默认关闭（纯渲染层增强，不修改任何数据）
- **🗂 会话视图标签收纳**：对话上方一排视图标签（记忆 / 技能 / 待办 / 设置 等，来自 conversation.view 槽位）可一键收起/展开——**默认折叠**、状态自动记住；收纳按钮位于会话头部「导出」旁；工具箱设置页顶部有独立开关（默认开；关闭 = 按钮消失、标签始终展开）
- **🗑️ 回收站**：删除的会话/子目录进回收站（默认保留 30 天，可调），可恢复 / 彻底删除 / 查看被删会话内容
- **📁 子目录管理**：工作区下建目录 / 重命名 / 删除 / 复制，会话批量归属
- **🔍 搜索**：全文搜索所有会话——**官方 SQLite 索引引擎优先**（不读会话文件、内存占用最低），官方不可用自动兜底自研逐帧解压；命中**按范围分组**（可见会话 / 归档会话 / 回收站会话 / 子代理会话，一次搜索即时切换）；**时间范围过滤**（今天/昨天/本月/上月快捷按钮）；命中文本预览 + 点击跳转定位高亮；120 秒同词缓存；**语义搜索**（可选，在线 embedding：相关度阈值 0-100 默认 80、显示条数可配、字面命中保底）。⚠️ 搜索默认全部关闭（省内存），自研/语义搜索需解压会话，使用后需重启 DSH 服务才彻底释放内存
- **⚙️ 预设编辑**：在线编辑 Agent 预设文件
- **📄 配置编辑**：在线编辑 dsh 配置文件（YAML 校验 + 原子写）
- **🗄 归档管理**：查看 / 恢复 / 删除官方归档会话
- **🧹 释放内存**：清空插件缓存并尝试触发 GC（彻底释放需重启 dsh）

## 📸 截图

**会话管理**（删除 / 复制 / 移动 / 重设 / 标签 / 查看 / 空会话标注）：

![会话管理](assets/session-manage.png)

**回收站**（删除的会话进回收站，可恢复 / 彻底删除 / 查看内容）：

![会话回收站](assets/session-trash.png)

**子目录管理**（工作区下建目录 / 重命名 / 删除 / 复制）：

![子目录](assets/subdirs.png)

**开关设置项**（分区化设置：⏰ 定时心跳 / 🔧 功能开关 / 🗑️ 回收站）：

![开关设置项 1](assets/settings-1.png)

![开关设置项 2](assets/settings-2.png)

## 环境要求

- **dsh** 运行时（插件作为 dsh 插件加载；前端依赖 dsh web 运行时注入的 `react`、`@deepseek-ai/dsh-client-ui-primitives` 等）
- **Node.js ≥ 22.13**（会话文件解压使用 `node:zlib` 的 zstd 支持）
- **平台**：代码跨平台（全 Node 内置 API，无 shell 依赖）。默认路径按 Linux 约定（`/home/dsh`、`/workspace`）；**Windows / macOS 部署请设置环境变量 `DSH_HOME` 与 `DSH_CHANNELS_CWD`** 指向实际目录（见下文「环境变量」）

## 安装

### 方式一：dsh 命令（推荐）

```bash
# GitHub 仓库分发（自动 clone + 装依赖）
dsh plugin --profile web add github:AbcdefgXW/dsh-toolbox-web

# 或已发布 npm 包
dsh plugin --profile web add dsh-toolbox-web
```

> `dsh plugin add` 会自动将本插件加入 profile 的 `dsh.profile.bundles` 并挂载插件自带的注册行（`cordis.patch.yml`），**无需也不应手动修改任何配置文件**。
>
> ⚠️ 排查注册问题时请检查 `package.json` 的 `dsh.profile.bundles` 是否包含 `dsh-toolbox-web`；**切勿**再在 profile 的 `cordis.patch.yml` 里手动 `insert` 本插件——bundles 已挂载时手动 insert 会导致 `duplicate loader entry id` 启动崩溃。

### 方式二：手动

```bash
git clone https://github.com/AbcdefgXW/dsh-toolbox-web.git
cd dsh-toolbox-web
npm install --omit=dev
```

将插件目录放入 dsh 插件加载路径（如 `$DSH_HOME/plugins/` 或 compose 挂载卷），按上述方式注册，重启 `dsh web`。

> `@deepseek-ai/*` 依赖为 dsh 运行时自带包，版本与 dsh 发布对齐；`js-yaml` 为插件自身依赖（配置编辑校验用）。

## 卸载

```bash
# 方式一：dsh 命令
dsh plugin --profile web remove dsh-toolbox-web

# 方式二：手动
# 1. 编辑 profile 的 package.json，从 dsh.profile.bundles 移除 "dsh-toolbox-web"
# 2. 删除依赖与软链：rm -rf $DSH_HOME/profiles/web/node_modules/dsh-toolbox-web
# 3. 删除插件数据（回收站/设置/索引）：rm -rf <插件目录>/state
# 4. 重启 dsh web
```

> 卸载后 `dsh-msg-hub` 未安装时，定时心跳的 IM 渠道推送自动不可用（回退主工作区心跳），其余功能不受影响。

## 崩溃恢复（vi 应急手册）

dsh 启动失败（插件树加载报错）时，95% 是以下两类，用 vi 手工恢复即可，**无需重装**：

**① `duplicate loader entry id: xxx`（最常见）**

原因：插件被注册了两次——`package.json` 的 `dsh.profile.bundles` 与 `cordis.patch.yml` 的手动 `- insert:` 重复。

```bash
vi /home/dsh/profiles/web/cordis.patch.yml
# 删除文件中形如以下的手动 insert 块（bundles 会自动挂载，不需要它）：
#   - insert:
#       - id: dsh-toolbox-web
#         name: 'dsh-toolbox-web'
# 保留 sandbox-policy / approval 等系统配置不动
```

**② `cannot resolve profile bundle "xxx"`（依赖缺失）**

```bash
vi /home/dsh/profiles/web/package.json
# 确认 dsh.profile.bundles 里的包名与 dependencies 对应、node_modules 存在：
ls -la /home/dsh/profiles/web/node_modules/ | grep dsh-
# 缺失时恢复软链：
ln -s /path/to/插件目录 /home/dsh/profiles/web/node_modules/插件名
```

**通用救急**：改动前插件会保留备份，恢复旧配置最快：

```bash
ls /home/dsh/profiles/web/cordis.patch.yml.bak-*   # patch 备份
ls /home/dsh/profiles/web/package.json.bak-*       # package.json 备份
cp 备份名 /home/dsh/profiles/web/cordis.patch.yml  # 覆盖回去
```

修改后**重启 dsh 容器/服务**生效；仍失败时查看日志：`docker logs deepseek-harness`（或 `journalctl -u dsh`）。

> ⚠️ 本插件（及 dsh-msg-hub）自带 `cordis.patch.yml` 注册行，由 `dsh plugin add` 自动挂载，**切勿**在 profile 的 `cordis.patch.yml` 手动 insert（见「安装」警示）。

## 使用

重启 `dsh web` 后，浏览器强刷（Ctrl+Shift+R）：

1. **🧰 工具箱**（左下角按钮，移动端为 🧰 图标）——7 个 Tab：
   - **💬 会话**：按工作区/标签分组列出会话；每行可删除（进回收站）、复制（`-副本x`）、移动、重设工作区根、打标签、查看内容；空会话标注「（空会话）」
   - **🗑️ 回收站**：被删会话/子目录，可恢复 / 彻底删除 / 查看被删内容
   - **🧬 子代理**：子代理会话独立管理（按父会话分组，查看/打开/删除进回收站），不再混在会话列表
   - **📁 子目录**：工作区下建/改/删/复制目录，会话批量归属
   - **🔍 搜索**：官方 SQLite 索引优先 + 分组筛选（可见/归档/回收站/子代理）+ 时间范围 + 语义搜索（可选）
   - **⚙️ 预设**：在线编辑 Agent 预设（`~/.agent-presets`）
   - **📄 配置**：在线编辑 dsh 配置文件（YAML 校验 + 原子写）
   - **🗄 归档**：查看 / 恢复 / 删除官方归档会话
2. **设置 → 工具箱**：功能开关 + 定时心跳配置
3. **⏰ 定时心跳**（可选，OpenClaw 心跳模式）：设置 → 工具箱 → 定时心跳
   - 开关 + 间隔（分钟）+ 提示语（`{time}` 替换为当前时间）+ 下次触发倒计时
   - 定点定时：每天几点 / 每周几 / 每月几号，独立提示语与目标
   - 目标：主工作区根（内部巡检）/ 任意会话 / 📱 微信·QQ·飞书（需 dsh-msg-hub，结果推送手机）
   - 调度运行在 dsh 后端进程，网页无需保持打开
4. **📃 长消息折叠**（默认开）：超过阈值的消息自动折叠，点「展开全部」查看（阈值可调）
5. **🗂 会话视图标签收纳**（默认开，位于设置页顶部独立分区）：对话上方视图标签一键收起/展开（默认折叠，状态记住）；关闭后按钮消失、标签始终展开

## 环境变量

| 变量 | 用途 | 默认 |
|---|---|---|
| `DSH_HOME` | dsh 数据目录（会话/配置/缓存） | `/home/dsh` |
| `DSH_CHANNELS_CWD` | 当前工作区根（会话 cwd 基准） | `/workspace` |

未设置时使用上述默认值；其余路径全部由插件自身目录（`import.meta.url`）推导，无硬编码。

## 数据与安全

- **运行时数据**存于插件 `state/` 目录（设置、回收站、备份、标签）——不随代码发布，`.gitignore` 已排除
- 插件会读写：`$DSH_HOME/sessions/`（会话文件，多帧 zstd）、`$DSH_HOME/storages/workspace.json`（工作区注册）、dsh 配置文件（仅配置编辑功能使用时）
- **删除 = 移入回收站**（默认 30 天保留，可恢复），非物理删除
- **对话管理（截断/编辑）**：修改会话文件后需重启 dsh 完整生效；默认关闭，需在设置中显式开启
- **IM 渠道推送提示**：定时心跳推送到 IM 渠道时，微信走模拟网页协议（ilinkai），**主动频繁发消息存在账号风控风险**——建议心跳间隔 ≥ 15 分钟、提示语内容正常化、避免短时间大量推送；QQ 官方开放平台主动消息需**申请「主动消息权限」**（未开通时推送会静默失败）；飞书为官方 API，合规无风险

## IM 渠道推送（可选）

定时心跳的「📱 微信 / QQ / 飞书」目标是**可选集成**：dsh-toolbox-web 通过 cordis 服务 `dsh-channels-push` 调用渠道插件完成「唤醒渠道 bot 执行任务 → AI 回复回传 IM」。

- **dsh-msg-hub** 为自研渠道桥插件（微信 ilinkai / QQ 开放平台 / 飞书开放平台），**不随本仓库分发**，需单独安装（[dsh-msg-hub](https://github.com/AbcdefgXW/dsh-msg-hub)）
- 未安装该服务时：渠道目标不可用（选择后会提示"渠道推送服务不可用"），主工作区根 / 指定会话的心跳不受任何影响
- 第三方渠道插件若提供同名服务亦可对接（当前无公开适配规范，属实现约定）

## 开发

- `index.js` 后端（cordis Service + typert remote，方法名 = 端点名）；`client.js` 前端（无构建管线，`window.__ModuleLoader__` 加载）
- 新增端点三处同步：后端方法 + 后端 `invocation` 注册 + 前端 `DESCRIPTORS`
- 会话文件重写必须用官方多帧格式（`lib/zstd.js compressSessionText`：header 帧恰好一行 + 每 500 行事件帧），单帧全压会导致 dsh 加载崩溃

## License

MIT — 见 [LICENSE](LICENSE)
