# Codex 旅行 Agent 执行器设计

状态：已完成交互设计确认，待用户审阅

日期：2026-08-31

## 目标

把本机已安装并已登录的 Codex 连接到现有 Local Agent Bridge，使成员在网页完成范围化授权后，可以显式启动一个独立、可见、持久化的 Codex 任务。Codex 在隔离环境中联网搜索旅行信息，生成 2–4 个候选及来源证据，再由 Bridge 通过现有签名协议原子写入共同决定工作区。

本设计使用本机 ChatGPT 应用自带的 Codex CLI。调查时检测到的版本为 `codex-cli 0.151.0-alpha.7.2`，并确认支持非交互 `codex exec`、联网搜索、只读沙箱、JSON 事件流和输出 Schema。

`--sandbox read-only` 本身只足以证明“不能写”，不能在实施前直接等同于“只能读取隔离目录”。因此本设计把文件读取隔离列为强制可行性门禁：实施必须先用 Codex permission profile/Seatbelt 证明模型工具只能读取隔离工作目录和必要运行资源，不能读取项目或其他用户文件。若当前 Codex 版本无法通过该门禁，功能必须保持禁用并返回稳定错误，不能降级为普通 read-only 后继续运行。

## 已确认的产品决策

- 每次研究创建一个独立、可在 Codex 中审阅的持久任务，不复用当前开发对话。
- 授权连接成功后不自动运行；成员必须点击“开始生成候选”。
- Codex 可以接收成员姓名，但不能接收成员 UID。
- Codex 可以联网搜索，并写入候选和来源证据。
- 每次任务最多运行 10 分钟，以尽可能充分搜索。
- Codex 运行在隔离目录中，不能读取项目源码或其他本机文件。
- Codex 不能确认候选、修改订单、调整正式行程或下单。
- 自动测试不调用真实 Codex；真实冒烟测试必须另行批准，因为会消耗额度并创建任务记录。

## 非目标

- 不把当前 Codex 开发对话当作旅行 Agent。
- 不允许浏览器传入自由文本 prompt、Shell 命令、模型名、沙箱参数或 Codex 配置。
- 不允许 Codex 直接持有 Agent 私钥、pairing code、CloudBase 登录态或云凭据。
- 不让 Codex 直接调用云端写接口；所有写入必须经过 Bridge 的既有签名、scope、sequence 和幂等协议。
- 不做预订、支付、确认回执或正式行程修改。
- 不在本阶段接入实验性的 Codex App Server 或 MCP Server。

## 总体架构

### Web 控制面

`DecisionAgentPanel` 在 AgentRun 已领取后显示“开始生成候选”。页面只能调用三个固定 loopback 能力：

- `POST /v1/agent-runs/execute-travel-research`：启动固定旅行研究任务。
- `GET /v1/agent-runs/research-status`：读取安全状态投影。
- `POST /v1/agent-runs/cancel-research`：停止当前研究。

网页不能提交 prompt、命令或输出内容。启动请求只携带 `agentRunId`。状态响应只包含任务编号、阶段、安全错误码和时间，不包含原始 Codex 日志、内部 prompt、环境变量或旅行上下文。

页面展示以下阶段：

- `idle`：已连接，等待成员启动。
- `researching`：Codex 正在搜索。
- `validating`：Bridge 正在校验结果。
- `writing`：Bridge 正在提交签名事务。
- `completed`：候选已写入。
- `failed`：任务失败，可重新开始。
- `cancelling` / `cancelled`：正在停止或已停止。

同一个 AgentRun 只能有一个进行中的研究。重复启动返回现有任务状态，不创建第二个 Codex 任务。

### Local Agent Bridge

Bridge 保持现有“浏览器不触碰私钥”的边界，并增加一个固定用途的 `CodexTravelExecutor`。执行顺序如下：

1. 确认 Bridge 已 claim，AgentRun 未知状态不会启动任务。
2. 通过已签名的 `getDecisionContext` 读取本次旅行共享决策上下文。
3. 构造经过筛选的 Codex 输入，并由 Bridge 根据现有候选计算下一轮 `round`。
4. 在新的隔离临时目录中启动 `codex exec`。
5. 捕获 JSON 事件流中的 Codex task/thread ID 和最终结构化结果。
6. 删除隔离工作目录；Codex 自身的持久任务历史仍保留在本机 Codex 数据目录中。
7. 对结果执行独立的严格校验和安全过滤。
8. 通过一个 `submitProposalBatch` 签名命令原子写入 2–4 个候选及其初始证据。

Bridge 不向浏览器开放通用 `command()` 或任意签名接口。`execute-travel-research` 只能执行上述固定管线。

### Codex 子进程

Bridge 使用 `spawn` 直接启动绝对路径的 Codex 可执行文件，不经过 Shell。默认从受控配置或可执行文件发现结果中解析 Codex 路径；测试使用显式假的可执行文件。

首轮执行的参数语义固定为：

- 非交互 `codex exec`。
- `--search` 启用联网搜索。
- `--sandbox read-only` 禁止文件写入。
- `--ask-for-approval never`，任何需要额外权限的动作直接失败。
- `--skip-git-repo-check`，隔离目录不是项目仓库。
- `--ignore-rules`，不读取项目或用户的执行规则。
- `--ignore-user-config`，不加载用户 MCP、插件或其他可能扩大权限的配置；Codex 登录认证仍来自本机 Codex 数据目录。
- `--json` 输出可解析的事件流。
- `--output-schema` 指向随 Bridge 发布的固定 JSON Schema。

不传 `--ephemeral`，因此任务保存在 Codex 历史中。Bridge 不指定危险沙箱、不自动批准写权限，也不允许网页覆盖参数。

在调用真实 Codex 前，Bridge 必须加载一个专用的最小权限配置，并通过启动探针验证：隔离目录内的合成文件可读，隔离目录外的合成文件和项目探针不可读，联网搜索能力可用，Codex 任务仍可持久化。权限配置只允许 Codex 核心读取认证并写入自身任务历史，不能把同样的读取权限授予模型生成的 Shell 工具。探针失败时返回 `CODEX_ISOLATION_UNAVAILABLE`，不启动旅行研究。

子进程继承经过白名单过滤的最小环境，只保留启动 Codex 和读取本机登录状态所需的系统变量。项目 `.env`、CloudBase、腾讯云、Bridge 私钥和配对材料不进入子进程环境。

## 输入数据边界

Bridge 发送给 Codex 的数据仅包括：

- 旅行城市、日期和人数。
- 成员姓名。
- 双方当前已完成的偏好及其必要的偏好 revision ID。
- 当前共同摘要。
- 候选反馈及其必要的 feedback ID。
- 已有候选的名称、类别、适用条件和公开证据摘要，用于避免重复。

Bridge 不发送：

- 成员 UID、登录令牌、会话、CloudBase 或腾讯云凭据。
- Agent 私钥、pairing code、签名、sequence、idempotency key 或 loopback 地址。
- 项目源码、Git 状态、本机路径、环境变量或内部日志。
- 未经授权的私人资料和其他行程数据。

成员输入和网页搜索内容都被标记为不可信数据，只能作为旅行需求和资料，不能修改固定任务指令。Codex prompt 由 Bridge 内置模板生成，浏览器不能传入 prompt 片段。

## Codex 输出契约

Codex 最终响应必须匹配固定 JSON Schema，并能被映射到现有 `submitProposalBatch`：

- `candidates` 数量为 2–4。
- 每个候选类别只能是 `hotel`、`restaurant` 或 `attraction`。
- 每个候选包含实体名称、必要地址、适用日期、人数和推荐理由。
- 每个推荐只能引用输入中存在的 preference revision ID 和 feedback ID。
- 每个候选至少包含一条证据。
- 证据包含来源类型、来源名称、HTTPS URL、查询条件、采集方式和类别对应的结构化 facts。

Bridge 在写入前执行第二层校验：

- 来源 URL 必须使用 HTTPS；其他协议一律拒绝。
- URL 不得带账号、密码或 fragment。
- 日期、人数必须与当前旅行和候选适用条件一致。
- ID 引用必须是输入允许集合的子集。
- 拒绝 HTML、Cookie、Authorization、令牌模式、超长文本和过大数组。
- 拒绝 Codex 输出的 AgentRun、签名、sequence、idempotency 或任何未声明字段。
- 复用现有 Contracts/后端 Schema 做最终结构校验。

Codex 不负责生成 `round`、`capturedAt`、签名或幂等字段。Bridge 使用当前工作区计算下一轮编号，用本机可信时钟填入采集时间，再组装最终云端命令。

`submitProposalBatch` 已把候选和初始证据放在同一云端事务中，因此本管线只执行一个写命令：全部成功或全部不写，不产生半批候选。

## 任务持久化与隐私

每次运行生成一个独立 Codex task/thread，并在网页展示安全任务编号。Codex 任务历史会持久保存在这台电脑的 Codex 数据目录中，包含经过筛选的旅行上下文、成员姓名和研究结果。

Bridge 自己不把 prompt、上下文、输出或原始事件流写入项目、临时日志或数据库。隔离工作目录在任务结束后删除。云端只保存通过既有业务契约写入的候选、证据和审计记录。

## 超时、取消与撤销

- 每个任务总截止时间为 10 分钟，包含搜索、一次格式修正和写入前校验。
- Bridge 从 claim 响应保存 AgentRun 到期时间；实际截止时间取“启动后 10 分钟”和 AgentRun 到期时间的较早者。
- 成员点击“停止搜索”时，Bridge 先发送正常终止信号；3 秒后仍未退出才强制终止。
- Web 观察到 AgentRun 被撤销或过期时立即调用本机取消接口。
- 如果其他客户端撤销而本机页面未在线，云端仍会在最终签名写入时拒绝请求，保证不会越权写回。
- 用户从 Agent 面板停止 Agent 时，先取消本机 Codex 任务，再执行现有云端 revoke 流程。

取消发生在云端写入前时不产生候选。若取消发生在写入响应不确定期间，Web 进入对账状态；Bridge 继续复用同一签名 envelope 查询/重放结果，不能直接宣称取消成功。

## 格式修正

Codex 首轮输出不符合固定 Schema 时，Bridge 可以在剩余截止时间内对同一 task/thread 执行一次 `codex exec resume`，只提供结构化校验错误和“按原任务要求重新输出完整 JSON”的固定指令。

修正过程：

- 不创建第二个 Codex 任务。
- 不提供新的旅行数据或自由文本。
- 最多一次。
- 仍不通过则失败且不写入。

## 稳定错误模型

Bridge 对网页仅返回以下稳定错误码：

- `CODEX_NOT_AVAILABLE`：未找到或不能执行 Codex。
- `CODEX_NOT_AUTHENTICATED`：Codex 未登录。
- `CODEX_ISOLATION_UNAVAILABLE`：当前 Codex 版本或本机权限配置不能证明文件读取隔离。
- `CODEX_USAGE_UNAVAILABLE`：额度或服务暂不可用。
- `CODEX_RESEARCH_TIMEOUT`：达到截止时间。
- `CODEX_OUTPUT_INVALID`：首轮和一次修正后仍不合法。
- `CODEX_RESEARCH_CANCELLED`：用户、撤销或到期导致取消。
- `AGENT_RUN_INACTIVE`：AgentRun 未 claim、已撤销或过期。
- `AGENT_TRANSPORT_UNAVAILABLE`：云端读取或写入暂不可用。
- `CODEX_RESEARCH_FAILED`：其他不向浏览器暴露细节的失败。

原始 stderr、Codex 内部事件、provider 错误和本机路径不得返回浏览器。错误发生时，共同决定的既有内容继续可用。

## 测试设计

### 单元测试

- 使用假的 Codex 可执行文件验证精确 argv，不启动真实 Codex。
- 使用合成的内外部探针文件验证权限配置：隔离目录可读，项目与其他用户路径不可读；不满足时拒绝启动。
- 验证隔离目录创建/清理、10 分钟截止时间和 3 秒强制取消。
- 验证环境变量白名单不会携带 CloudBase、腾讯云或项目秘密。
- 验证成员姓名保留、成员 UID 和安全字段剔除。
- 验证 prompt injection 文本只能进入数据块，不能修改固定指令。
- 验证输出 Schema、HTTPS URL、日期、人数、ID 引用、长度和秘密模式。
- 验证只允许一次同 task/thread 格式修正。

### Bridge 集成测试

- `prepare → claim → execute → status → submitProposalBatch` 完整管线。
- 同 AgentRun 并发启动只产生一个 Codex 子进程。
- 取消、超时、AgentRun 撤销和过期均不产生写入。
- Codex 无法启动、未登录、额度不足和无效输出映射到稳定错误码。
- 云端成功响应丢失时重放完全相同的签名 envelope，候选批次只写一次。
- Loopback 继续严格验证 Origin、Host、method、path、content-type、PNA 和请求体大小。

### 浏览器 E2E

- 连接 Bridge，点击“开始生成候选”，按阶段展示状态，最终候选出现在共同决定页面。
- 重复点击不创建第二个任务。
- 点击“停止搜索”后进入取消状态且不出现候选。
- Codex 不可用时显示稳定错误和重试入口，既有共同决定不受影响。
- 使用语义 role/label/text 定位，不使用固定 sleep。

自动测试全部使用假的 Codex 可执行文件和测试 transport，不消耗真实额度，不访问或写入真实旅行数据。

### 真实冒烟测试

实施完成后，可在获得单独批准时使用合成行程执行一次真实 Codex 任务。冒烟测试只验证：

- 创建一个可见的独立 Codex 任务。
- Codex 在隔离目录、只读沙箱和联网搜索模式运行。
- 10 分钟内返回符合 Schema 的 2–4 个候选和 HTTPS 来源。
- 不连接生产 CloudBase，不写真实旅行数据。

## 验收标准

1. 成员授权后必须再次点击“开始生成候选”，才会创建 Codex 任务。
2. 一次点击只创建一个独立、持久、可在 Codex 中审阅的任务。
3. Codex 只能看到允许的旅行数据和成员姓名，不能看到成员 UID、项目源码或任何秘密。
4. Codex 在隔离目录、只读沙箱、联网搜索和 10 分钟截止时间下运行。
5. 有效结果包含 2–4 个候选，每个候选至少一条 HTTPS 来源证据。
6. 候选和证据通过一个 `submitProposalBatch` 原子写入，网络重试不会产生重复。
7. 取消、超时、撤销、过期、无效输出或 Codex 不可用都不能产生半成品。
8. Codex 无法确认候选、修改订单、调整正式行程或下单。

## 实施边界建议

预期改动集中在：

- `apps/local-agent-bridge/`：Codex runner、输入筛选、输出 Schema、任务状态和固定 loopback 端点。
- `apps/web/src/infrastructure/localAgentBridgeClient.ts`：固定 execute/status/cancel 客户端方法。
- `apps/web/src/features/decisions/DecisionAgentPanel.tsx`：开始、进度、取消、完成与错误体验。
- `functions/trip-api/lib/decision-agent-bridge.js` 与相关 envelope：如需把 `expiresAt` 安全返回给 Bridge，仅扩展 claim 成功响应，不改变 15 分钟时效。
- 现有 Node、Vitest、Playwright 测试和本地运行文档。

不新增第三方运行时依赖；优先使用 Node 标准库、现有 Contracts 和已安装的 Codex CLI。
