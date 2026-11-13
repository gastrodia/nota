# 录音、转写与原件

底部语音按钮打开浮窗并请求麦克风；关闭/Escape 停止录音。权限等待取消、迟到流、卸载和重录均清理轨道、AudioContext 与 Blob URL。录音上限 60 秒；原音、采集 ID、录音时间和确认文字按账户保存到 IndexedDB，刷新后可恢复。重录授权失败不会替换上一段原音。浏览器禁用或回收本机存储时需下载原音备份。

## 两条音频链路

1. `MediaRecorder` 产出浏览器实际支持的 WebM/Opus 或 MP4，供试听及保存原件。不会将 WebM 伪装 PCM 或 WAV。
2. `AudioWorklet` 将输入重采样到 16kHz、单声道 PCM16 小端序，100ms 一块，用于 ASR。支持输入 16k/44.1k/48k 的采样相位与尾部刷新测试。

Vercel 环境走浏览器 WS → 已登录的 Next Route Handler → Qwen Realtime。服务端持有百炼 Key，先验证 Session/Origin、剩余额度与启动频率。本机录音立即开始，连接等待期间有界缓存 PCM；等待 provider `session.updated` 后传 PCM；按 item 替换 partial 和最终文本；停止时先刷新 worklet，再 `session.finish`，等 `session.finished` 后关闭，避免丢末句。VAD 模式不手动 commit。

普通 Next 本地服务不能完成 Vercel 专属升级，明确显示「录音后转写（本地环境）」：浏览器暂存 PCM，停止后 POST 给服务端，由相同 Qwen WebSocket 协议识别。它不是浏览器 Web Speech API，也不是本地模型。转写失败不阻止用户保留已录原件，确认文字可以手动修改；转写结束不会覆盖用户同时修改的持久化文字。点击“重新转写原音”时将原音解码、下混并重采样为 PCM，再走相同 POST 接口。

## 保存与删除

可先以稳定采集 UUID 建立云端草稿并私有保存原音，即使尚无转写文字；确认整理时沿用同一草稿，原件上传成功后再提交 AI 任务。上传最多 4 MiB，验证音频容器头、账户与草稿状态。Private Blob 只由服务端持 Key 读写，Neon 存 pathname 和元信息，前端拿不到可公开访问地址。

上传丢响应时先查同一草稿是否已有原件，避免无谓重复上传；整理提交以幂等键复用任务。刷新后可在历史里「继续整理此便签」。任务提交后禁止替换原件。

播放先校验便签所有者，再代理私有完整文件流，使用 private/no-store。支持单段HTTP Range、206与越界416；不支持的多段语法回退完整流。Range请求在服务端有界缓冲原件后切片，单文件最大4 MiB。删除便签会同时删除关联待办/任务，音频进入数据库删除队列；请求尽力清理，故障保留重试。可执行 `pnpm cleanup:audio`，独立 Worker 和密钥调度接口同样会清理删除队列；生产需实际配置后台运行。

## 验收边界

协议替身覆盖 partial 替换、末句、断线释放和无效 PCM；JSDOM 覆盖录音生命周期。它们不能证明实际麦克风、编码、iOS AudioContext、真实 Qwen 或部署 WS 升级成功。最终须在 HTTPS 部署、真实账户与手机上验证开始→实时文字→停止末句→试听→确认→私有回放。

参考：[Qwen 流程](https://help.aliyun.com/en/model-studio/qwen-asr-realtime-interaction-process)、[服务端事件](https://help.aliyun.com/zh/model-studio/qwen-asr-realtime-server-events)、[Vercel WebSockets](https://vercel.com/docs/functions/websockets)、[Private Blob](https://vercel.com/docs/vercel-blob/private-storage)、[getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)、[Range](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Range)。
