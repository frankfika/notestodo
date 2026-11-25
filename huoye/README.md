# 活页（Huoye）

活页是开源、本地优先的个人助手，默认助手叫「叶」。关于你的事写在这台电脑的 markdown 文件里，对外发消息或改核心档案前会先请你确认。软件本身免费，许可证是 **MIT**，没有付费墙。要用真实模型时，请在应用里填写你自己的密钥（BYOK）。

Huoye is an open-source, local-first personal assistant. Your memory lives in markdown files on this computer. The app is free (MIT, no paywall); model usage is billed to the key you supply.

## 它是什么，不是什么

- 跑在你自己的电脑上。开发时默认只监听 `127.0.0.1`，不会主动把写接口暴露到公网。
- 不是云端订阅产品，也不向你出售模型额度。
- 没有密钥也可以先用：简报会按本地档案整理一版，聊天会用内置的演示回复，并说明要写得更好需要你自己的密钥；健康手记和录音都可以记。
- 飞书、钉钉、微信只是官方通道的脚手架。没配好凭证时就是「未连接」，不会假装已经开通。真正收发还需要你在对应开放平台创建应用，并准备一个公网可访问的回调地址。

## 本机运行

需要 **Node 22** 和 pnpm（仓库已指定 `packageManager`，可用 corepack）：

```bash
corepack enable
pnpm install
pnpm dev
```

默认会启动：

- API：http://127.0.0.1:8787
- 网页：http://127.0.0.1:5173（开发时会把 `/api` 转到 8787）

用浏览器打开网页即可。第一次启动会在工作区里生成记忆树、助手说明和本地数据库。工作区默认在 `~/Huoye`。也可以换目录：

```bash
HUOYE_HOME=/tmp/huoye-dev pnpm dev
```

启动方式只用这几个环境变量：`HUOYE_HOME`、`HUOYE_HOST`（默认 `127.0.0.1`）、`HUOYE_PORT`（默认 8787）、`HUOYE_WEB_PORT`（默认 5173）。可参考 [`.env.example`](.env.example)。它们只决定进程听哪里、工作区在哪，**不是模型密钥的来源**。不要把 `HUOYE_HOST` 默认改成 `0.0.0.0`。

## 添加模型密钥（BYOK）

密钥只保存在工作区的 `secrets.json` 里，文件权限是 `0600`。请在应用里填写，不要把密钥写进仓库、`.env` 或 shell 环境。活页运行时也不会从环境变量或命令行工具的配置文件里读取模型密钥。

1. 打开 http://127.0.0.1:5173 ，进入「设置 → 模型」。
2. 选一个常用接口：MiniMax 国内（`https://api.minimax.cn/v1`）、MiniMax 国际（`https://api.minimax.io/v1`），或其他 OpenAI 兼容地址。
3. 填入你自己申请的密钥，以及模型 ID（例如 `MiniMax-M3.1-Flash`）。
4. 保存。没有密钥时请继续使用内置 Mock；空密钥不能设为默认。不需要的供应商可以删掉。

## 工作区里有什么

```
$HUOYE_HOME/
  config.json          # 非密钥设置
  secrets.json         # 仅本机，权限 0600，不要提交
  agent/AGENT.md       # 助手说明与硬规则
  memory/              # 可打开、可导出的 markdown 记忆
    about-you/         # 基本档案、认同、习惯、工作、设备
    diaries/
    health/            # 按天写下的健康手记
    recordings/        # 录音纪要（音频在 data/recordings）
  data/index.sqlite    # 任务、确认、用量、检索；可重建
  data/recordings/
  data/local-folders.json  # 你添加的本地文件夹路径
  logs/audit.jsonl
```

记忆的唯一真相是这些文件。删掉数据库不会丢掉你已经写进 markdown 的内容。更完整的日常说明见 [docs/using.md](docs/using.md)。

「设置 → 连接器」可以添加你指定的本地文件夹。活页不会自动扫描家目录或整块磁盘；空路径或单独的 `~` 也不会被当成整个家目录。添加后可以查看该文件夹的顶层内容，但不会顺着指向外部的符号链接往外走，也不会把文件上传到云端。聊天和每日简报目前还不会自动引用这些文件夹。

## 桌面窗口

网页和 API 跑起来之后，可以用本机窗口打开同一份应用：

```bash
pnpm dev
pnpm desktop
```

窗口标题是「活页」，默认加载 http://127.0.0.1:5173（API 仍是 8787，由网页开发服务器转发）。如果本地服务还没启动，窗口会用中文说明请先运行 `pnpm dev`，不会去打开远程网站。在桌面窗口的「设置 → 连接器」里可以用系统对话框选择文件夹；网页版则粘贴路径。

若要打开另一套本机实例（例如首次运行工作区在 5174 端口）：

```bash
HUOYE_WEB_PORT=5174 pnpm desktop
```

这只是一个最小桌面壳，不是把整个应用重写成原生程序。没有自动更新、分析统计或付费墙。密钥规则与网页版相同，仍然只写在工作区的 `secrets.json` 里。

## 开发

```bash
pnpm test
pnpm typecheck
pnpm lint
```

- `apps/web`：网页
- `apps/server`：本机 API
- `apps/desktop`：最小 Electron 壳，用本机窗口打开已经运行的网页
- `packages/*`：共用代码
- `fixtures/`：第一次运行时用的空白档案模板和助手说明

通道的回调路径和本机模拟见 [docs/channels.md](docs/channels.md)。实现合同（给开发者）见 `docs/IMPLEMENTATION-SPEC.md`。参与方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。
