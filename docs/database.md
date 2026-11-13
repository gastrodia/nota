# 数据库访问

Nota 使用 Drizzle ORM 0.45 和 `pg`，连接 Neon PostgreSQL。Drizzle 复用原有连接池，不创建第二套连接。ORM 接入本身复用既有表；本次业务对齐新增增量迁移，已有数据库同样需要运行 `pnpm db:migrate`，不要重跑或修改旧初始化文件。

## 查询与类型

- `src/server/schema.ts` 映射现有业务表，定义列类型、默认值、索引和约束；`DbJob` 从表定义推导。
- `orm()` 用于便签、待办、认证、会话历史和音频元数据等常规查询。字段和条件使用表定义，值由 ORM 参数化。
- `query()` 和 `transaction()` 保留给任务状态机、额度预占、租约、工具账本及复杂关键词检索。`INSERT … SELECT` 等语句也可通过 Drizzle 的 `sql` 模板执行，动态值仍须参数化。
- 查询必须保留账户条件；ORM 不会自动提供账户隔离或权限检查。

数据库列名和 API 字段继续使用现有的下划线命名。`timestamptz` 在服务端映射为 `Date`，通过 JSON 返回 ISO 时间；`date` 映射为日期字符串。任务事件的 `bigint` ID 在公开响应中显式转为字符串，避免 JSON 序列化失败或精度丢失。

## 事务

多步 ORM 写入使用 `ormTransaction(async (db) => { … })`，回调内始终通过传入的 `db` 操作。它绑定原有 `transaction()` 检出的同一个 PostgreSQL 连接，沿用 `BEGIN / COMMIT / ROLLBACK`、10 秒锁等待上限及连接释放逻辑。回调内调用全局 `orm()` 会绕过当前事务。

删除便签、替换原音继续在事务内锁定便签行；原音删除队列与元数据修改一起提交。任务创建、额度扣减、租约和 fence 的 SQL 事务保持现有实现。

## 表结构变更

`db/migrations/*.sql` 是数据库 DDL 的执行来源，现有迁移按文件名和 checksum 记录，继续使用 `pnpm db:migrate`。本次不引入 Drizzle Kit 的第二套迁移记录。

后续改表时新增 SQL 迁移，并同步修改 `src/server/schema.ts`。已执行的迁移不回写。修改 TypeScript 表定义本身不会更新数据库。

## 验证与性能

执行 `pnpm lint`、`pnpm typecheck`、`pnpm build` 和 `pnpm test:local`。本地测试在临时 Docker PostgreSQL 上运行原有迁移和回归，覆盖 ORM 接入后的邮箱冲突、并发限流、搜索字符转义、账户隔离、重复提交、日期与事件序列化、事务回滚及业务流程。

ORM 的直接收益是编译期字段检查和类型推导；查询性能仍取决于 SQL、索引与数据规模。本次新增业务唯一键、请求别名、队列与录音时间索引；尚未进行线上性能基准测试。

参考：[Drizzle 与 node-postgres](https://orm.drizzle.team/docs/get-started-postgresql)、[参数化 SQL 模板](https://orm.drizzle.team/docs/sql)、[独立管理 SQL 迁移](https://orm.drizzle.team/docs/migrations)。
