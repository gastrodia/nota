# Nota · AI 语音便签

移动端语音便签与 Agent 助手。底部固定 **Agent / 语音 / 我的**，我的只含历史、待办两个 Tab。桌面保持手机宽度。

## 当前实现

- 邮箱密码登录与注册、可撤销的 HttpOnly 会话、按用户隔离的数据。
- 浏览器录音、可编辑转写、确认后生成摘要。原始音频存入私有 Vercel Blob，授权后代理播放；Neon 保存元数据与文本。
- Qwen Agent 自主调用 `create_todo`、`search_notes`；界面展示真实调用参数、结果与历史来源，支持同一会话最近六轮上下文。
- 历史查询、便签详情、待办完成状态、便签及关联数据删除。
- 每账户每日 10 次 AI 任务：数据库原子扣次、幂等提交、失败退还与任务恢复。详细规则见下文。

**代码已接入，真实服务尚待验收**：本地隔离 PostgreSQL、模拟模型/ASR 协议测试已通过；Neon、真实 Qwen、私有 Blob、Vercel WebSocket 与真机录音仍需配置后的端到端验证。访客示例和联调测试均明确标识，不作为模型效果证明。尚未外网部署、录制最终演示视频。

## 运行

需要 Node.js 22、pnpm 11。

```bash
pnpm install
cp .env.example .env.local
# 填写 DATABASE_URL、DASHSCOPE_API_KEY、BLOB_READ_WRITE_TOKEN
pnpm db:migrate
pnpm dev
```

打开本机 localhost 地址。普通 `next dev/start` 使用 **录音后转写**：结束时将 PCM 发往服务端，服务端仍调用同一个 Qwen Realtime 模型；不会伪装为实时字幕。Vercel 环境使用实时 WebSocket。麦克风需要 localhost 或 HTTPS，手机不能直接用普通局域网 HTTP 测试录音。

迁移只连接 `DATABASE_URL`，通过事务、迁移锁与校验和重复执行；请指向项目专用数据库。不会建种子账户、重置已有数据或自动修改其他数据库。

## 架构与取舍（300 字以内）

Next.js 承载移动端与 Node.js API，部署 Vercel；Neon 保存账户、便签、待办、任务与额度。浏览器采集 PCM，经鉴权后由服务端代理 Qwen 实时转写；可播放原件独立存入私有 Blob。文本 Agent 循环调用创建待办、查询历史工具，再输出结构化结果与来源。历史先用账户内关键词和日期检索，不引入向量库。数据库事务保证每日额度与工具写入幂等；任务状态、租约和调用结果持久化，断线后可恢复。首次发布前仍需真实云服务与真机验收。

## 额度与恢复

- 一次确认整理或一次 Agent 提问算一个任务，上海时区每日 10 次；ASR、试听、检索列表与勾选待办不另扣 AI 次数。ASR 另限每小时 30 次启动、每次 60 秒。
- 提交时事务预占；成功消耗。失败且没有已提交的写工具则退还；已创建待办等真实副作用时保留扣次，界面可见工具结果。
- 同一账户、同一幂等键的网络重试复用任务；不同内容复用键返回冲突。失败重试沿用原任务与原额度日期，最多五次执行尝试。
- 工具动作和返回结果在同一事务记账；任务通过租约与 fence 阻止旧执行器写入。页面刷新/断网后可继续查看原任务，已完成写入不重复执行。
- 无常驻 worker：页面负责触发/恢复 API 任务。退出页面后运行中的请求可能继续，若平台中断则需要再次打开并恢复；不是后台定时任务系统。

## 音频生命周期

每段最多 60 秒、上传最多 4 MiB。只有用户确认时才保存原件，未确认的录音只在页面内存中，刷新会丢失，可先下载。上传成功但整理失败时可从历史恢复云端草稿。提交后原件不可替换；私有文件名不返回浏览器。

删除便签会删除关联待办和任务，并将音频加入持久化删除队列。接口尝试清理；服务异常时留队重试，可运行 `pnpm cleanup:audio`。此版本没有定时清理 cron；失败删除不会承诺立刻物理擦除。授权播放支持单段 Range 请求；最多4 MiB的原件在服务端有界缓冲后返回所需片段。详细协议见 `docs/audio-recording.md`。

## 检查与效果评估

```bash
pnpm typecheck
pnpm lint
pnpm build
pnpm format:check
# Docker 自动创建独立 PostgreSQL、迁移、跑全部 31 项检查，再销毁容器
pnpm test:local
```

已有专用本地 `nota_test` 数据库时，可配置 `TEST_DATABASE_URL` 后运行 `pnpm test`。测试禁止连接远程库，不使用用户的 Neon。31 项检查涵盖录音资源释放、PCM 重采样与末句、权限隔离、原件删除重试，以及 30 并发只接受 10 个任务和重复提交只扣一次。模型和 Blob 使用协议/存储替身，**不代表真实模型效果或云存储已验收**。证据和未验收项见 `docs/verification.md`。

真实 Key 配好后可运行 `pnpm eval:live`：以本地测试库和合成账户评估8个真实模型场景，报告保存到 `work/`，会产生API调用。目前尚未运行，没有效果分数。

`pnpm preview:test` 可在 3109 端口启动标有「联调测试」的界面：真实本地 PostgreSQL、固定模型响应，禁用云 ASR/Blob。它只用于界面与业务流程验证，需先构建并准备本地测试库，不用于交付效果演示。

## 部署与交付

1. 在 Vercel 导入仓库，启用支持 WebSocket 的 Fluid compute 环境，连接项目专用 Neon 和 **Private** Blob。
2. 在目标环境配置上述三个密钥；按百炼 Key 的地域/工作空间设置端点。部署前运行数据库迁移。
3. 部署后配置 `APP_URL` 为该 HTTPS 地址；核验登录 Cookie、WS 升级、末句、私有音频播放及每日第 11 次拒绝。WebSocket 官方本地接入要求 Vercel CLI 54.14.2+；普通 Next 本地模式已有录后转写降级。
4. 注册独立评审账户，交付方式另定；此版本无邮件验证/找回密码，不将其当作成熟账户系统。
5. 按 `docs/demo-script.md` 录制不超过 3 分钟的真实链路视频，再提交链接、源码与额度证明。

## 素材与参考

`public/art/` 为内置 image_gen 生成的透明像素素材，提示词见 `docs/mobile-icons.md`、`docs/assets.md`。图片只参考奶油色、描边与像素视觉，不引入手帐或宠物业务。

服务协议依据：[Qwen Chat](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)、[Qwen ASR Realtime](https://help.aliyun.com/en/model-studio/qwen-asr-realtime-interaction-process)、[Vercel WebSockets](https://vercel.com/docs/functions/websockets)、[Private Blob](https://vercel.com/docs/vercel-blob/private-storage)。真实密钥仅保存在 `.env.local` 或部署环境变量中。
