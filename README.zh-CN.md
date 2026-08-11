<div align="center">

# FIRM Control Room

### 让多个 Claude Code 研究会话持续推进，同时保留真正的科学控制权。

[English](README.md) · [快速开始](#五分钟启动) · [GPU 接入](#可选gpu-队列)

</div>

---

多开几个终端很容易。困难的是判断多个研究 Agent 到底是在工作、运行工具、等待真实实验、悄悄停下，还是已经钻进了一个低价值局部问题。

FIRM 把 Claude 历史、终端状态、进程树、项目产物、持久消息确认、可选 GPU 队列和无状态 Codex 审计组合成一个本地控制台。它可以在用户授权的目标下持续推进项目，但不会把研究路线交给一个审稿型模型裁决。

## 它解决什么

| 原来的问题 | FIRM 的处理 |
|---|---|
| 看到提示符，却不知道 Claude 停了还是工具仍在收尾 | 显式区分 `MODEL_WORKING`、`TOOL_RUNNING`、`WAITING_FOR_GPU`、`WAITING_REVIEW` |
| “继续”可能重复粘贴、没有按回车或没有进入 Claude 历史 | SQLite outbox、唯一消息标记和历史 ACK |
| 长会话逐渐把原始研究问题换成局部叙事 | 只读证据快照与隔离的 Codex 边界审计 |
| Codex 审查反过来发明实验、提高门槛和带偏主 PI | Codex 只能识别边界漂移，不能决定方法、主张、停止或 GPU 操作 |
| GPU 申请时依赖、数据和评测代码还没准备好 | 可选 readiness gate、生命周期队列和阶段感知遥测 |
| 等待实验结果被误判成项目停摆 | 必须用权威队列核验同项目、同 run ID 的活跃实验 |

## 五分钟启动

### 环境要求

- macOS；外部 iTerm 会话控制目前是 macOS 专属能力
- Node.js 26+
- 已安装并登录 Claude Code
- 需要独立巡检时安装并登录 Codex CLI；否则可关闭该功能

### 1. 安装

```bash
git clone https://github.com/Zarien-Li/firm-control-room.git
cd firm-control-room
npm ci
```

### 2. 建立第一个项目

```bash
mkdir -p "$HOME/research"
cp -R examples/research-project "$HOME/research/project-alpha"
cp config/projects.example.json config/projects.json
```

在模板文件中替换研究对象、价值指标、Seed 和当前状态。若目录或名称不同，再修改 `config/projects.json`。

```text
~/research/project-alpha/
├── CLAUDE.md
├── CLAUDE-RESEARCH.md
├── PROGRAM_ORIGIN.md
├── PROJECT_IDENTITY.json
├── SEED.md
├── PIPELINE_STATE.md
└── prompt.txt
```

### 3. 自检并启动

```bash
npm run doctor
npm start
```

打开 [http://127.0.0.1:8787](http://127.0.0.1:8787)。可以由控制台启动托管 Claude，也可以继续在已配置项目目录中使用 iTerm，FIRM 会自动发现其主进程。

不使用 Codex 审计时：

```bash
FIRM_CODEX_AUDIT_ENABLED=false npm start
```

## 自动化边界

- broker 持有 Claude PTY，网页或 Web 服务重启不会杀死托管会话；
- Goal Loop 必须由用户逐项目开启，并设置目标和每日次数上限；
- 外部消息必须在 Claude JSONL 中出现唯一 delivery marker 才算送达；
- 普通输入点稳定出现后可立即触发一次无状态 Codex 边界审查；
- Codex 只能检查 identity、scope、evidence、compute 和 operation drift；
- 权限确认、破坏性操作和无法证明的终端状态不会被自动回答；
- FIRM 不允许网页执行任意 shell，不替 PI 选择方法或论文类型。

## 合法等待 GPU

一个项目只有同时满足以下条件才进入 `WAITING_FOR_GPU`：

1. Claude 最新 assistant 事件输出精确标记 `[FIRM WAITING_FOR_GPU run_id=<run_id>]`；
2. 权威队列中同一项目、同一 run ID 确实为 `pending` 或 `running`。

此时 Goal Loop 和停顿审查都会暂停。任务进入 `done`、`failed` 或 `cancelled` 后，FIRM 会把结果事件送回项目并恢复正常推进。失败任务、历史任务、其他项目任务和仅计划但未提交的任务都不能伪装成合法等待。

## 可选GPU 队列

公开版默认关闭远端 GPU 集成。接入自己的 SSH 队列时：

```bash
export FIRM_GPU_QUEUE_ENABLED=true
export FIRM_GPU_SCHEDULER_AUTO_START=true
export FIRM_GPU_QUEUE_HOST=user@gpu-control-host
export FIRM_GPU_QUEUE_SSH_PORT=22
export FIRM_GPU_QUEUE_ROOT=/absolute/remote/path/to/gpu_queue
npm start
```

队列状态协议为：

```text
pending/.submitted → running/.started → done|failed|cancelled/.ready
```

启用前需要把 `config/` 中的 Scheduler 模板适配到自己的集群。FIRM 只通过固定 SSH 采集器读取状态；GPU worker 的启动与终止仍然只属于你的 Scheduler。

## 验证

```bash
npm run check
npm test
npm run smoke
npm run acceptance:restart
```

测试覆盖 Web/broker 重启、延迟 ACK、发送中断、终端噪声、快速工作周期、采集器降级、GPU monitor 丢失、合法 GPU 等待和消息防重。

## 安全提醒

- 默认只监听 `127.0.0.1`，没有多用户认证，不要直接暴露到公网；
- 项目文件只读且有固定白名单，运行数据写入 `var/`；
- `var/`、`work/`、真实项目配置、日志和环境文件不会进入 Git；
- Codex 以只读短进程运行，项目与 session 文本全部作为不可信证据；
- GPU 利用率只是诊断信号，不能单独授权停卡或缩卡。

完整设计、配置项和架构图见 [English README](README.md)。

## 许可证

[MIT](LICENSE)
