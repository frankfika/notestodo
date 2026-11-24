# 参与活页

感谢你愿意一起完善这个开源个人助手。

## 开发

```bash
corepack enable
pnpm install
pnpm dev
```

默认会在 `127.0.0.1:8787` 启动 API，在 `127.0.0.1:5173` 启动网页。可用 `HUOYE_HOME=/tmp/huoye-dev pnpm dev` 使用临时工作区。

提交前请在本地跑绿：

```bash
pnpm test
pnpm typecheck
pnpm lint
```

## 约定

- 保持 MIT 许可干净：不要引入 AGPL、Elastic License 2.0 或许可证不明的核心依赖。
- 不要把模型密钥、通道密钥或 `secrets.json` 写进仓库、文档或示例环境文件。运行时只从工作区 `secrets.json`（权限 0600）读取密钥，不要改成从 `process.env` 取值。
- 不要把 Today 的商标、图标、字体、截图或营销原句带进仓库。
- 不要做付费墙，也不要把导出、删除数据或核心功能锁在订阅后面。
- 尚未与 Today 正式 App 对照过的行为，请在注释里写「推断，待日后对照」，不要写成已经对齐。
- 本机高危能力（shell、电脑控制、家目录）不得零提示授权。
- 默认语言是简体中文，语气短句、口语、克制。

## 包划分

见 `docs/IMPLEMENTATION-SPEC.md` 第 3 节。新的数据模型请先改 `@huoye/schema`。
