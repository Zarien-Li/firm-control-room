<div align="center">

# FIRM Control Room

### 让多个 Claude Code 研究会话持续推进，同时保留真正的科学控制权。

[English](README.md) · [快速开始](#五分钟启动) · [GPU 接入](#可选gpu-队列)

</div>

---

多开几个终端很容易。困难的是判断多个研究 Agent 到底是在工作、运行工具、等待真实实验、悄悄停下，还是已经钻进了一个低价值局部问题。

FIRM 把 Claude 历史、终端状态、进程树、项目产物、持久消息确认、结构化长任务和事件驱动的 Continuity PI 组合成一个本地控制台。项目 Claude/GLM 仍是主研究者；Codex 只在真实空闲停点负责接棒，不承担五小时组合审查，也不得发明替代方法或改写论文路线。系统只把凭证、付费、法律或伦理承诺、不可逆删除、正式投稿和公开发布保留为外部授权。

## 它解决什么

| 原来的问题 | FIRM 的处理 |
|---|---|
| 看到提示符，却不知道 Claude 停了还是工具仍在收尾 | 显式区分 `MODEL_WORKING`、`TOOL_RUNNING`、`WAITING_FOR_JOB`、`READY_FOR_INPUT` |
| “继续”可能重复粘贴、没有按回车或没有进入 Claude 历史 | SQLite outbox、唯一消息标记和历史 ACK |
| 普通研究选择被伪装成“等待用户”，项目长期停在输入框 | Codex 读取项目权威状态，只决定继续、等待、完成或真正需要外部权利 |
| Codex 暂时超时后，停点被悄悄遗忘 | 决策事件持久化并退避重试，不把模型故障伪装成项目完成 |
| GPU 申请时依赖、数据和评测代码还没准备好 | 可选 readiness gate、生命周期队列和阶段感知遥测 |
| 等待实验结果被误判成项目停摆 | 必须用权威队列核验同项目、同 run ID 的活跃实验 |

## 五分钟启动

### 环境要求

- macOS；外部 iTerm 会话控制目前是 macOS 专属能力
- Node.js 26+
- 已安装并登录 Claude Code
- 需要自动接续真实停点时安装并登录 Codex CLI；否则可关闭该功能

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

不使用 Continuity PI 时：

```bash
FIRM_CONTINUITY_ENABLED=false npm start
```

## 自动化边界

- broker 持有 Claude PTY，网页或 Web 服务重启不会杀死托管会话；
- macOS 服务使用两个独立 LaunchAgent：broker 与 Web/API 分别由 launchd 监督，不再嵌套第二层重启循环；broker socket 位于稳定状态目录；
- 原始控制快照和 GPU 队列快照采用有界保留，避免长时间运行后 SQLite 无限膨胀；Job Registry 生命周期与项目进度仍完整保留；
- 高频 Goal Loop 默认关闭；研究目标只保存在项目的 `CLAUDE.md` 与权威 live state，不反复注入会话；
- 每个新的、稳定且没有活动工具或匹配 Job Registry 作业的输入停点，只触发一次短生命周期 Codex；
- FIRM 只把有界的 `CLAUDE.md`、`PROGRAM_ORIGIN.md`、`SEED.md`、`PIPELINE_STATE.md` 与当前会话/Registry 事实交给 Codex；Codex 在空临时目录运行，不能浏览研究仓库，并且只裁决是否接续，不发明方法、实验、解释或论文身份；
- 机器层负责会话事实、持久事件、退避重试、并发限制和可靠投递；模型故障不会被伪装成项目完成；
- 外部消息必须在 Claude JSONL 中出现唯一 delivery marker 才算送达；
- 普通输入点稳定出现后触发一次无状态 Codex 连续性决策；五小时科学审查仍是完全独立的任务；
- Codex 与项目 Claude/GLM 都按研究者身份工作，但 Continuity PI 不能借接棒之名插入审稿、停止或防御性实验；
- 只有账号凭证、付费、法律或伦理承诺、不可逆删除、正式投稿和公开发布等外部权利不会被自动代决；
- FIRM 不允许网页执行任意 shell；长任务必须进入 Job Registry，健康运行与等待保持静默。

## 合法等待长任务

一个项目只有同时满足以下条件才进入 `WAITING_FOR_JOB`：

1. Claude 最新 assistant 事件输出唯一受支持的精确标记 `[FIRM WAITING_FOR_JOB run_id=<run_id>]`；
2. FIRM Job Registry 中同一项目、同一 run ID 确实为 `pending` 或 `running`。

只有这两条证据交叉成立，FIRM 才抑制普通续跑。任务进入 `done`、`failed` 或 `cancelled` 后，旧标记立即失效；缺失、跨项目或仅计划中的 run ID 也不成立。同项目存在另一个 active job 只是附加信息，绝不能被推断为当前 session 的依赖。GPU、本地 CPU、远程 CPU 和 SSH 长任务共用这一个协议，不再兼容旧的 `WAITING_FOR_GPU` 双轨标记。

## 可选GPU 队列

公开版默认关闭远端 GPU 集成。接入自己的 SSH 队列时：

```bash
export FIRM_GPU_QUEUE_ENABLED=true
export FIRM_GPU_SCHEDULER_AUTO_START=true
export FIRM_GPU_QUEUE_HOST=user@gpu-control-host
export FIRM_GPU_QUEUE_SSH_PORT=22
export FIRM_GPU_QUEUE_ROOT=/absolute/remote/path/to/gpu_queue
export FIRM_GPU_QUEUE_DOCKER_CONTAINER=research-container
npm start
```

`scripts/submit-gpu-request.sh` 会从环境或 `.env.local` 读取这些值。还可以用
`FIRM_GPU_QUEUE_ALLOWED_PROJECTS` 和 `FIRM_GPU_QUEUE_PROJECT_ROOT` 限制允许提交的项目。

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
