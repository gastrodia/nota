# Nota

[在线预览](https://nota.jiajiwei.top)

一个移动端优先的 AI 语音便签应用。说一段话或输入文字，整理成摘要与待办；需要回顾时，通过 Agent 查询历史记录、查看原文来源。

## 功能

- **语音记录**：点击底部语音按钮开始录音，原音按账户保存在本机，刷新后可恢复并重新转写；支持无文字先保存云端原音和私有回放。
- **AI 整理**：生成标题和摘要，根据明确指令创建待办。
- **Agent 问答**：查询历史便签、创建待办，遇到模糊时间或冲突证据先追问，并展示工具过程和回答来源。
- **个人空间**：管理历史记录与待办，支持搜索、完成状态切换和来源追溯。
- **账户与额度**：账户数据独立，每天提供 10 次 AI 处理额度，按北京时间零点更新。

## 技术栈

- **应用**：Next.js App Router、React、TypeScript
- **数据库**：Neon PostgreSQL、Drizzle ORM（复用 `pg` 连接池）
- **模型**：Qwen3.8-Flash、Qwen3-ASR-Flash-Realtime
- **音频存储与部署**：Vercel Blob（Private）、Vercel

## 快速开始

环境要求：Node.js 22、pnpm 11。

```bash
git clone https://github.com/gastrodia/nota.git
cd nota
pnpm install
cp .env.example .env.local
```

在 `.env.local` 中填写以下配置：

| 变量                    | 用途                                 |
| ----------------------- | ------------------------------------ |
| `DATABASE_URL`          | 项目专用的 Neon PostgreSQL 连接串    |
| `DASHSCOPE_API_KEY`     | 阿里云百炼文本模型 API Key           |
| `DASHSCOPE_ASR_API_KEY` | 可选，语音使用不同工作空间时单独配置 |
| `BLOB_READ_WRITE_TOKEN` | 私有 Vercel Blob 存储的访问 Token    |
| `APP_URL`               | 部署后的 HTTPS 地址，本地开发可留空  |

模型名称与接口地址已在 [.env.example](.env.example) 中提供默认值，接口地域需与对应 Key 一致。语音 WebSocket 路径为 `/api-ws/v1/realtime`；若语音与文本使用不同工作空间，可单独设置 `DASHSCOPE_ASR_API_KEY`。Blob 也支持私有存储的 Vercel OIDC 鉴权。

本地与 Vercel 环境变量独立维护；修改 Vercel 配置后需要重新部署。当前线上香港文本与新加坡实时语音已通过联调，验证范围见[验证记录](docs/verification.md)。

```bash
pnpm db:migrate
pnpm dev
```

打开 [localhost:3000](http://localhost:3000)。录音需要麦克风权限及 localhost 或 HTTPS 环境。本地 Next.js 服务采用录音后转写，Vercel 环境采用实时转写。

## 架构说明

Next.js 承载网页与 Node.js API；IndexedDB 保留本机原音，私有 Blob 保存云端原件，Neon 保存业务数据和任务。Agent 自主创建待办、检索历史或追问，按真实工具结果回答。历史检索使用录音时间、实体关键词和有限同义词，暂不引入向量库。事务预占额度，录音业务键和工具账本防重复；响应后执行与独立 Worker 恢复任务。首版只保存待办，不提供主动提醒。

常规数据访问使用 Drizzle 的类型化查询；任务锁、额度扣减和工具检索等复杂逻辑保留参数化 SQL。表结构类型定义在 `src/server/schema.ts`，数据库变更继续通过 `db/migrations/*.sql` 和 `pnpm db:migrate` 管理，详细约定见[数据库访问](docs/database.md)。

## 后台执行

正常请求提交后会在服务端响应结束后开始处理。要保证用户离开页面、函数中断后仍自动恢复，生产需另外运行独立进程：

```bash
pnpm worker
# 单次排空一批（最多两个并行任务）
pnpm worker:once
```

Worker 每五秒扫描数据库，恢复待执行/过期租约任务；可重试错误按 15–300 秒退避，最多五次。权限或参数配置错误停止自动重试。它使用相同数据库和模型配置，建议由进程管理器保持运行。

Vercel 环境可以由外部调度器周期调用 `GET /api/internal/worker`，请求头为 `Authorization: Bearer <CRON_SECRET>`。在调度器和服务端配置同一个随机密钥；单次最多执行两个任务并清理音频删除队列。本仓库不默认启用任何付费调度，部署时必须实际配置调度器或持久 Worker；仅设置密钥不会启动调度。

## 效果评估

```bash
# 真实模型 + 独立本地 nota_test 数据库，使用合成数据
TEST_DATABASE_URL=postgresql://nota_test:nota_local_test_only@127.0.0.1:55437/nota_test pnpm eval:live --label candidate --output work/candidate.json
pnpm eval:compare work/baseline.json work/candidate.json
```

评估保存数据集、提示词/代码指纹、模型请求和回答及耗时，对比关键事实、实际待办和来源支持。报告包含合成原文，请按评估资料管理；不会记录请求认证头。固定样本通过不代表开放场景准确率。可用参数包括 `--label`、`--output` 和 `--baseline`。

## 本地检查

```bash
pnpm lint
pnpm typecheck
pnpm build
pnpm test:local
```

`test:local` 需要 Docker，会创建独立 PostgreSQL、执行迁移和测试，结束后删除测试容器。模型协议与业务流程的测试、真实模型评估方式及当前验证范围见 [验证记录](docs/verification.md)。

## 部署

1. 将仓库导入 Vercel，连接 Neon 数据库和 **Private** Blob 存储。
2. 配置上述环境变量，对目标数据库运行 `pnpm db:migrate`。
3. 部署后将 `APP_URL` 设置为站点 HTTPS 地址，验证登录、语音转写和原音回放。

## 文档

- [设计与实现](docs/design-decisions.md)
- [数据库访问](docs/database.md)
- [Part A 对齐与实现边界](docs/part-a-alignment.md)
- [音频链路与存储](docs/audio-recording.md)
- [测试与验证](docs/verification.md)
- [演示流程](docs/demo-script.md)
