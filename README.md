# Nota

一个移动端优先的 AI 语音便签应用。说一段话或输入文字，整理成摘要与待办；需要回顾时，通过 Agent 查询历史记录、查看原文来源。

## 功能

- **语音记录**：点击底部语音按钮开始录音，转写后可编辑确认，支持原始录音保存与回放。
- **AI 整理**：生成标题和摘要，根据明确指令创建待办。
- **Agent 问答**：查询历史便签、创建待办，并展示工具调用过程和回答来源。
- **个人空间**：管理历史记录与待办，支持搜索、完成状态切换和来源追溯。
- **账户与额度**：账户数据独立，每天提供 10 次 AI 处理额度，按北京时间零点更新。

## 技术栈

- **应用**：Next.js App Router、React、TypeScript
- **数据库**：Neon PostgreSQL
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

| 变量                    | 用途                                |
| ----------------------- | ----------------------------------- |
| `DATABASE_URL`          | 项目专用的 Neon PostgreSQL 连接串   |
| `DASHSCOPE_API_KEY`     | 阿里云百炼 API Key                  |
| `BLOB_READ_WRITE_TOKEN` | 私有 Vercel Blob 存储的访问 Token   |
| `APP_URL`               | 部署后的 HTTPS 地址，本地开发可留空 |

模型名称与接口地址已在 [.env.example](.env.example) 中提供默认值，接口地域需与百炼 Key 对应。

```bash
pnpm db:migrate
pnpm dev
```

打开 [localhost:3000](http://localhost:3000)。录音需要麦克风权限及 localhost 或 HTTPS 环境。本地 Next.js 服务采用录音后转写，Vercel 环境采用实时转写。

## 架构说明

Next.js 同时承载前端与 Node.js API。浏览器采集音频，服务端代理 Qwen ASR；Neon 保存账户、便签、待办和额度，私有 Blob 保存录音原件。Agent 通过 `create_todo`、`search_notes` 两个工具执行操作，再生成结构化结果和来源引用。历史检索采用账户内关键词与日期过滤。数据库事务、幂等键和任务租约用于保证额度准确、避免重试重复写入。

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
- [音频链路与存储](docs/audio-recording.md)
- [测试与验证](docs/verification.md)
- [演示流程](docs/demo-script.md)
