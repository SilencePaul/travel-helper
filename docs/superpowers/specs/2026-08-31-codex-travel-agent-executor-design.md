# Codex 旅行 Agent 执行器设计

状态：已获用户批准，待实施

日期：2026-08-31

## 目标

把本机已安装并已登录的 Codex 连接到现有 Local Agent Bridge，使共享项目管理员在网页完成范围化授权后，可以显式启动一个独立、可见、持久化的 Codex 任务。Codex 在隔离环境中联网搜索旅行信息，生成 2–4 个候选及来源证据，再由 Bridge 通过现有签名协议原子写入共同决定工作区。

本设计使用本机 ChatGPT 应用自带的 Codex CLI。调查时检测到的版本为 `codex-cli 0.151.0-alpha.7.2`，并确认支持非交互 `codex exec`、联网搜索、只读沙箱、JSON 事件流和输出 Schema。

`--sandbox read-only` 本身只足以证明“不能写”，不能在实施前直接等同于“只能读取隔离目录”。因此本设计把文件读取隔离列为强制可行性门禁：实施必须先用 Codex permission profile/Seatbelt 证明模型工具只能读取隔离工作目录和必要运行资源，不能读取项目或其他用户文件。若当前 Codex 版本无法通过该门禁，功能必须保持禁用并返回稳定错误，不能降级为普通 read-only 后继续运行。

## 已确认的产品决策

- 每次研究创建一个独立、可在 Codex 中审阅的持久任务，不复用当前开发对话。
- 本机 Bridge/Codex 就绪检查与云端 AgentRun 授权分离；就绪检查不创建 AgentRun。
- 管理员确认授权范围后，必须点击“开始生成候选”；该点击才创建、领取新的 15 分钟 AgentRun，并紧接着启动 Codex。
- 每次研究只针对管理员明确选择的一个类别：`hotel`、`restaurant` 或 `attraction`；同一轮的 2–4 个候选必须全部同类。
- 每次研究还必须绑定一个由最新共享行程生成的固定行程段；多城市不能混在同一轮候选中。
- Codex 只使用设备所有者已在本机 ChatGPT/Codex 中建立的登录态；项目不提供 Codex 登录、切换账号或代他人传递凭据的入口。
- 只有共享项目管理员可以准备、创建、启动、继续、取消或撤销 Codex 旅行研究 AgentRun，并查看本机任务编号、进度和阻断详情。普通成员只看到静态权限说明和原子提交后的候选，仍可反馈及共同确认，但不看本机执行进度、阻断原因或通知。
- Codex 认证失效或外部来源要求登录、验证码、风控时，任务不直接失败：进入 `needs_owner_action`、只通知管理员，由管理员恢复 Codex 登录或选择跳过受阻来源后继续同一 Codex task/thread。
- 进入 `needs_owner_action` 时，页面持久显示待处理状态，Local Bridge 同时尝试发送一条不含旅行或账号内容的 macOS 本地通知；系统通知不可用时静默退化为页面提示。
- 启动前的单一授权确认必须展开显示本次将发送的准确安全数据投影，并明确提示任务会保存在设备所有者的本机 Codex 历史中。数据未变时恢复同一任务不重复确认；任何已展示数据变更都要求重新确认并启动新 Codex 任务。
- 研究 AgentRun 只授予 `submitProposalBatch`；阻断和等待状态由本机 Bridge 管理，不用 `appendEvidenceSnapshot` 或 `reportVerificationBlocked` 写入云端半成品。
- Codex 可以接收成员姓名，但不能接收成员 UID。
- Codex 可以联网搜索，并写入候选和来源证据。
- 每个候选至少需要两条、来自不同 HTTPS origin 的证据；研究优先寻找官方或经营方来源，但自动验收不把“官方”标记当成可证明的强条件。
- 每次任务最多运行 10 分钟，以尽可能充分搜索。
- Codex 运行在隔离目录中，不能读取项目源码或其他本机文件。
- Codex 不能确认候选、修改订单、调整正式行程或下单。
- 自动测试不调用真实 Codex；真实冒烟测试必须另行批准，因为会消耗额度并创建任务记录。

## 非目标

- 不把当前 Codex 开发对话当作旅行 Agent。
- 不允许浏览器传入自由文本 prompt、Shell 命令、模型名、沙箱参数或 Codex 配置。
- 不在 Web 或 Bridge 中提供 Codex 账号登录页、OAuth 回调、账号切换或凭据代理，也不让其他行程成员录入设备所有者的账号信息。
- 不把管理员浏览器的外部站点 Cookie、登录态、密码或验证码交给 Codex；管理员在 Safari/Chrome 中完成的外部站点登录不视为隔离 Codex 可复用的登录态。
- 不允许 Codex 直接持有 Agent 私钥、pairing code、CloudBase 登录态或云凭据。
- 不让 Codex 直接调用云端写接口；所有写入必须经过 Bridge 的既有签名、scope、sequence 和幂等协议。
- 不做预订、支付、确认回执或正式行程修改。
- 不在本阶段接入实验性的 Codex App Server 或 MCP Server。

## 总体架构

### Web 控制面

`DecisionAgentPanel` 在本机 Bridge/Codex 就绪、管理员已确认授权范围后，先要求管理员从“酒店 / 餐厅 / 景点”中选择本次研究类别，再显示具体的“开始研究…”动作。点击后，Web 使用现有安全流程创建并领取一个新 AgentRun，领取成功后立即调用固定研究启动能力。页面只能调用四个新增的固定 loopback 能力：

上述交互控件和本机安全状态投影只对当前管理员可用。普通成员页面只显示静态说明“Codex 研究由设备管理员运行，完成后候选会出现在共同决定中”，不连接 Local Bridge，不渲染任务编号、进度、阻断详情、准备、开始、继续、取消或撤销控件。这只是 UX 限制；真正权限还必须由后端执行。

管理员的确认区域展开显示：本次行程段、研究类别、成员姓名、双方已完成偏好、当前共同摘要、相关反馈、已有候选的非敏感摘要，以及“将保存在设备所有者的本机 Codex 历史中”。不展示或发送 UID、原始业务 ID、凭据、本机路径或内部 prompt。沿用一个“我确认以上授权范围”复选框，不再叠加二次弹窗。

- `POST /v1/agent-runs/execute-travel-research`：启动固定旅行研究任务。
- `GET /v1/agent-runs/research-status`：读取安全状态投影。
- `POST /v1/agent-runs/resume-travel-research`：使用固定恢复动作继续受阻任务。
- `POST /v1/agent-runs/cancel-research`：停止当前研究。

网页不能提交 prompt、命令或输出内容。启动请求只携带 `agentRunId`、严格枚举的 `targetCategory`、由共享纯函数生成的 `targetScopeId` 和 `disclosureFingerprint`；城市、日期、人数和其他条件一律由 Bridge 从已签名读取的最新行程上下文重新推导。管理员的状态响应只包含任务编号、阶段、安全错误/阻断枚举、经清洗的受阻 hostname 和时间，不包含原始 Codex 日志、内部 prompt、环境变量或旅行上下文。普通成员不读取该本机状态端点。

Web 和 Bridge 使用同一共享纯函数，对上述准确安全投影的规范 JSON 计算 SHA-256 `disclosureFingerprint`。投影包含页面实际展示的内容，以及为保证恢复时 ID 别名可重建而加入的“资源类型 + 原始 ID + revision” SHA-256 承诺值；承诺值不单独展示，也不发给 Codex。数组使用固定排序，并排除 `fetchedAt`、workspace cursor、网络时间戳、明文原始 ID 和其他未展示传输字段。内容或底层资源身份/revision 变化都宁可要求重新确认，不冒险恢复无法安全映射的旧别名。Bridge 在创建 Codex 任务前，必须用签名读取的最新上下文重算并与页面已确认值比较；不一致时撤销本次 AgentRun、不启动 Codex，并要求页面刷新投影后重新确认。

恢复请求只携带新或仍有效的 `agentRunId`、本机安全 `researchTaskId` 和固定枚举 `resumeAction`：`retry_codex_auth` 或 `skip_blocked_source`。浏览器不能提交登录信息、URL、域名、验证码、Cookie 或恢复 prompt。Bridge 在恢复前重算安全投影指纹；指纹未变才免于再次确认并继续原 task/thread。如果行程段、类别、成员姓名、偏好、摘要、反馈或已有候选摘要任一变化，原任务标记为 `superseded`，必须重新确认并创建新 Codex 任务，不向旧 thread 注入未确认的新数据。

行程段按日期有序的连续同城市日程生成；同一城市的两次非连续停留是两个不同行程段。页面可展示“香港 · 10 月 4–6 日 · 2 人”，但不直接把这些字段作为可信请求数据。Bridge 必须用最新的安全行程投影重算全部可选行程段，只接受仍在集合中的 `targetScopeId`。

页面展示以下阶段：

- `idle`：本机已就绪，等待管理员启动；此时尚未创建 AgentRun。
- `researching`：Codex 正在搜索。
- `needs_owner_action`：研究已安全暂停，等待管理员恢复 Codex 登录或跳过受阻外部来源。
- `resuming`：Bridge 正在使用同一 Codex task/thread 恢复研究。
- `superseded`：已确认数据投影发生变化，原任务不再恢复，等待管理员重新确认并启动新任务。
- `validating`：Bridge 正在校验结果。
- `writing`：Bridge 正在提交签名事务。
- `completed`：候选已写入。
- `failed`：任务失败，可重新开始。
- `cancelling` / `cancelled`：正在停止或已停止。

同一个 AgentRun 只能有一个进行中的研究。重复启动或恢复返回现有任务状态，不创建第二个 Codex 任务。受阻后旧 AgentRun 会被撤销；管理员点击继续时创建和 claim 新 AgentRun，但仍恢复同一个本机 `researchTaskId` 和 Codex task/thread。

### Local Agent Bridge

Bridge 保持现有“浏览器不触碰私钥”的边界，并增加一个固定用途的 `CodexTravelExecutor`。执行顺序如下：

1. 接收用户刚刚点击启动后创建并由 Bridge claim 的新 AgentRun；AgentRun 未知、非 active 或已过期时不启动任务。
2. 通过已签名的 `getDecisionContext` 读取本次旅行共享决策上下文和最小安全行程投影，重算并校验 `targetScopeId`。
3. 构造经过筛选的 Codex 输入，将原始偏好、反馈等 ID 替换为本次任务专用的不透明别名，并由 Bridge 根据现有候选计算下一轮 `round`。
4. 在新的隔离临时目录中启动 `codex exec`。
5. 捕获 JSON 事件流中的 Codex task/thread ID 和最终结构化结果。
6. 如果结果为可恢复阻断，不写入候选；保存最小恢复元数据、安全撤销当前 AgentRun，并进入 `needs_owner_action`。
7. 管理员继续时，Bridge 先校验新 AgentRun 和最新行程段，再对同一 task/thread 执行一次固定 `codex exec resume`；可多次遇到阻断，但总主动运行时间仍不超过 10 分钟。
8. 删除隔离工作目录；Codex 自身的持久任务历史仍保留在本机 Codex 数据目录中。
9. 对成功结果执行独立的严格校验和安全过滤。
10. 通过一个 `submitProposalBatch` 签名命令原子写入 2–4 个候选及其初始证据。

现有后端允许任意行程成员创建 AgentRun，也允许行程成员撤销同行程内的 AgentRun。当前项目没有其他需要普通成员驱动的 AgentRun 类型，因此实施直接把现有 `createAgentRun` 和 `revokeAgentRun` 收紧为管理员权限，不新增暂时用不到的 purpose 抽象。claim 必须再次确认 run creator 仍是有效管理员。普通成员的伪造或重放请求必须由后端拒绝，不能仅依赖 Web 隐藏控件。

Bridge 不向浏览器开放通用 `command()` 或任意签名接口。`execute-travel-research` 只能执行上述固定管线。

可恢复阻断只包括 `codex_auth_required`、`source_login_required`、`source_captcha` 和 `source_risk_control`。外部来源阻断只返回经清洗的 HTTPS hostname 和枚举原因；不返回带查询、用户信息或 fragment 的 URL。`skip_blocked_source` 恢复指令要求 Codex 禁止再访问该 hostname，继续寻找其他公开来源。

进入每一个新的阻断事件时，Bridge 只发送一次固定 macOS 本地通知：标题“旅行 Agent 需要你处理”，内容“请打开共同决定页面查看”。通知不包含成员姓名、城市、日期、类别、hostname、Codex 账号、任务编号或错误细节，避免在锁屏泄露。实现使用绝对路径直接 `spawn` macOS 系统通知工具，不经过 Shell，所有参数均为内置常量。命令不存在、通知被禁用或调用失败时不改变任务状态，也不反复弹窗。

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

Bridge 只检测设备所有者已有的 Codex 认证是否可用，不启动交互式登录流程。未登录时仅返回安全状态，由设备所有者在 ChatGPT/Codex 应用内自行恢复登录；项目端不展示账号、密码、令牌或登录表单。

在调用真实 Codex 前，Bridge 必须加载一个专用的最小权限配置，并通过启动探针验证：隔离目录内的合成文件可读，隔离目录外的合成文件和项目探针不可读，联网搜索能力可用，Codex 任务仍可持久化。权限配置只允许 Codex 核心读取认证并写入自身任务历史，不能把同样的读取权限授予模型生成的 Shell 工具。探针失败时返回 `CODEX_ISOLATION_UNAVAILABLE`，不启动旅行研究。

子进程继承经过白名单过滤的最小环境，只保留启动 Codex 和读取本机登录状态所需的系统变量。项目 `.env`、CloudBase、腾讯云、Bridge 私钥和配对材料不进入子进程环境。

## 输入数据边界

现有 `getDecisionContext` 只返回共同决定工作区，不包含可用于验证行程段的 Trip 数据。实施需将该签名响应扩展为最小安全投影：Trip version、按顺序的日程 ID/日期/城市、旅行者姓名和人数。投影不包含 traveler ID、member UID、订单、已选酒店、行程项 ID 或其他 Trip 字段。

Bridge 发送给 Codex 的数据仅包括：

- 本次选定的单一研究类别。
- 本次选定行程段的城市、日期和人数。
- 成员姓名。
- 双方当前已完成的偏好及其本次任务专用的不透明 revision 别名。
- 当前共同摘要。
- 候选反馈及其本次任务专用的不透明 feedback 别名。
- 已有候选的名称、类别、适用条件和公开证据摘要，用于避免重复。

Bridge 不发送：

- 成员 UID、登录令牌、会话、CloudBase 或腾讯云凭据。
- traveler ID，以及可能间接包含 UID 的原始 preference、feedback 或其他业务 ID。
- Agent 私钥、pairing code、签名、sequence、idempotency key 或 loopback 地址。
- 项目源码、Git 状态、本机路径、环境变量或内部日志。
- 未经授权的私人资料和其他行程数据。

成员输入和网页搜索内容都被标记为不可信数据，只能作为旅行需求和资料，不能修改固定任务指令。Codex prompt 由 Bridge 内置模板生成，浏览器不能传入 prompt 片段。

Bridge 为每个本机研究任务生成随机 `aliasSalt`，通过 HMAC-SHA-256(`aliasSalt`, 类型 + 原始 ID + revision) 产生稳定的任务专用不透明别名。恢复时 Bridge 重新读取已签名上下文，使用同一 `aliasSalt` 重建允许映射，因此不需要在本地持久化可能包含 UID 的原始 ID。Codex 返回后，Bridge 只能将当前允许集合中的别名映射回原始 ID；未知、旧 revision 或类型错配别名一律拒绝。

## Codex 输出契约

Codex 每次执行或恢复的最终响应必须匹配以 `status` 判别的固定 JSON Schema：

- `completed`：包含可映射到现有 `submitProposalBatch` 的完整候选数组。
- `needs_owner_action`：只包含可恢复阻断原因枚举，外部来源阻断时可附带清洗后 hostname；不得同时包含候选、URL、凭据或网页内容。

`completed` 响应必须满足：

- `candidates` 数量为 2–4。
- 每个候选类别只能是 `hotel`、`restaurant` 或 `attraction`。
- 同一响应中的所有候选必须与启动时选定的 `targetCategory` 完全一致，不允许混合类别。
- 每个候选包含实体名称、必要地址、适用日期、人数和推荐理由。
- 每个推荐只能引用输入中存在的 preference revision 别名和 feedback 别名。
- 每个候选至少包含两条证据，且它们的 HTTPS origin 必须去重后至少为两个。
- 证据包含来源类型、来源名称、HTTPS URL、查询条件、采集方式和类别对应的结构化 facts。

Bridge 在写入前执行第二层校验：

- 来源 URL 必须使用 HTTPS；其他协议一律拒绝。
- URL 不得带账号、密码或 fragment。
- Bridge 使用解析后的 scheme、小写 hostname 和有效 port 归一化 origin；同一 origin 的不同路径或查询只计一个来源。
- 日期、人数必须与当前旅行和候选适用条件一致。
- ID 引用必须是输入允许集合的子集。
- 拒绝 HTML、Cookie、Authorization、令牌模式、超长文本和过大数组。
- 拒绝 Codex 输出的 AgentRun、签名、sequence、idempotency 或任何未声明字段。
- 复用现有 Contracts/后端 Schema 做最终结构校验。

Codex 不负责生成 `round`、`capturedAt`、签名或幂等字段。Bridge 使用当前工作区计算下一轮编号，用本机可信时钟填入采集时间，再组装最终云端命令。

`submitProposalBatch` 已把候选和初始证据放在同一云端事务中，因此本管线只执行一个写命令：全部成功或全部不写，不产生半批候选。

## 任务持久化与隐私

每次运行生成一个独立 Codex task/thread，并在网页展示安全任务编号。Codex 任务历史会持久保存在这台电脑的 Codex 数据目录中，包含经过筛选的旅行上下文、成员姓名和研究结果。

该历史和 Codex 用量归当前设备所有者的本机 Codex 账号。其他行程成员不会因为加入共享行程而获得该 Codex 账号、登录界面或任务历史的访问权。

macOS 本地通知仅在设备上生成，不经过项目云端、邮件、短信或第三方推送服务。锁屏可见文案始终使用固定通用内容。

Bridge 自己不把 prompt、上下文、输出或原始事件流写入项目、临时日志或数据库。隔离工作目录在任务结束后删除。云端只保存通过既有业务契约写入的候选、证据和审计记录。

为了在 Bridge 或页面重启后继续受阻任务，Bridge 可在本机应用数据目录中以所有者只读写权限、原子替换方式保存最小恢复元数据：`researchTaskId`、Codex task/thread ID、`targetCategory`、`targetScopeId`、`disclosureFingerprint`、`aliasSalt`、阻断枚举、经清洗的 hostname、已消耗主动运行毫秒数和状态。`aliasSalt` 只用于重建本任务不透明 ID 映射，不授予任何云端或 Codex 权限。该文件不包含姓名、原始业务 ID、prompt、旅行上下文、Codex 输出、网页内容或任何凭据，任务完成、取消或被新数据取代后立即删除。

## 超时、取消与撤销

- 每个任务最多消耗 10 分钟主动运行时间，包含各次搜索、恢复、一次格式修正和写入前校验；`needs_owner_action` 的等待时间不计入。
- AgentRun 只在管理员点击“开始生成候选”后创建和 claim，Bridge 从 claim 响应保存到期时间并立即启动 Codex；实际截止时间取“启动后 10 分钟”和 AgentRun 到期时间的较早者。
- 管理员点击“停止搜索”时，Bridge 先发送正常终止信号；3 秒后仍未退出才强制终止。
- Web 观察到 AgentRun 被撤销或过期时立即调用本机取消接口。
- 如果其他客户端撤销而本机页面未在线，云端仍会在最终签名写入时拒绝请求，保证不会越权写回。
- 用户从 Agent 面板停止 Agent 时，先取消本机 Codex 任务，再执行现有云端 revoke 流程。
- 进入 `needs_owner_action` 时不保留可写 AgentRun：Bridge 停止当前子进程并撤销当前 run。管理员继续时再显式创建和 claim 新的 15 分钟 AgentRun，恢复同一 Codex task/thread。如果旧 run 撤销结果不确定，必须先对账，不能同时创建新 run。

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
- `CODEX_INSUFFICIENT_EVIDENCE`：主动运行时间用尽后，仍无法为至少两个候选各提供两个不同 HTTPS origin 的证据。
- `INVALID_RESEARCH_TARGET`：选定行程段不存在，或在启动前已因共享行程更新而失效。
- `DISCLOSURE_CONTEXT_CHANGED`：页面已确认的安全数据投影与 Bridge 从最新签名上下文重算的投影不一致；未启动 Codex，需刷新后重新确认。
- `CODEX_RESEARCH_CANCELLED`：用户、撤销或到期导致取消。
- `AGENT_RUN_INACTIVE`：AgentRun 未 claim、已撤销或过期。
- `AGENT_TRANSPORT_UNAVAILABLE`：云端读取或写入暂不可用。
- `CODEX_RESEARCH_FAILED`：其他不向浏览器暴露细节的失败。

就绪检查期间的 `CODEX_NOT_AUTHENTICATED` 是稳定错误；已启动研究期间检测到同一问题时，转换为 `needs_owner_action/codex_auth_required`，不直接终止本机研究任务。外部来源的登录、验证码或风控同样是可恢复状态，不是云端 Agent 写命令。

原始 stderr、Codex 内部事件、provider 错误和本机路径不得返回浏览器。错误或可恢复阻断发生时，共同决定的既有内容继续可用。

## 测试设计

### 单元测试

- 使用假的 Codex 可执行文件验证精确 argv，不启动真实 Codex。
- 使用合成的内外部探针文件验证权限配置：隔离目录可读，项目与其他用户路径不可读；不满足时拒绝启动。
- 验证隔离目录创建/清理、10 分钟截止时间和 3 秒强制取消。
- 验证环境变量白名单不会携带 CloudBase、腾讯云或项目秘密。
- 验证 10 分钟限制只累计子进程运行、恢复和校验时间，管理员等待时间不计入。
- 验证 Web 和 Bridge 没有 Codex 登录、账号切换或凭据提交端点；就绪检查未登录时只返回 `CODEX_NOT_AUTHENTICATED`。
- 验证普通成员不能创建、claim 或撤销 Codex 旅行研究 AgentRun，管理员在 run 领取前失去管理员身份时 claim 也必须失败。
- 验证成员姓名保留、成员 UID 和安全字段剔除。
- 验证 `targetCategory` 只接受三个固定枚举，输出数组中的 2–4 个候选全部与之一致。
- 验证连续同城市日程正确生成独立行程段，非连续的同城市停留不会被合并。
- 验证 Bridge 用最新安全行程投影重算 `targetScopeId`，行程变更导致旧 ID 失效时不启动 Codex。
- 验证 Web 和 Bridge 对准确安全投影产生相同 `disclosureFingerprint`；任一已展示字段变化都会拒绝启动或恢复旧任务。
- 验证内容未变但原始资源 ID 或 revision 变化时，身份承诺仍会改变 `disclosureFingerprint`；承诺值和原始 ID 都不发给 Codex。
- 验证指纹未变时恢复不重复确认；指纹变化时原任务进入 `superseded`、清理恢复元数据，且不向旧 thread 发送新上下文。
- 验证发送给 Codex 的 traveler、preference 和 feedback 均不含原始 ID，只有姓名和本次任务别名；未知别名无法映射回云端命令。
- 验证同一 `aliasSalt` 在 Bridge 重启前后为同一类型/ID/revision 产生同一别名，不同任务产生不同别名；无需持久化原始 ID 即可在恢复时重建允许映射。
- 验证 prompt injection 文本只能进入数据块，不能修改固定指令。
- 验证输出 Schema、HTTPS URL、日期、人数、ID 引用、长度和秘密模式。
- 验证每个候选至少两条证据且归一化后至少两个 HTTPS origin；同 origin 不同路径、大小写 hostname 和默认端口不能绕过去重。
- 验证只允许一次同 task/thread 格式修正。
- 验证只接受 `retry_codex_auth` 和 `skip_blocked_source` 两个固定恢复动作，拒绝自由文本、URL、Cookie、密码和验证码。
- 验证阻断状态只暴露枚举原因和清洗后 hostname，恢复始终复用原 Codex task/thread。
- 使用假通知器验证每个新阻断事件只发送一次固定文案，无成员、行程、hostname、账号、任务或错误数据；通知器失败不影响状态机。
- 验证最小恢复元数据以所有者权限原子保存，不含姓名、旅行上下文、prompt、输出或凭据，完成/取消后删除。

### Bridge 集成测试

- `prepare/就绪检查 → 管理员点击启动 → create → claim → execute → status → submitProposalBatch` 完整管线，并验证点击前不存在 AgentRun。
- 同 AgentRun 并发启动只产生一个 Codex 子进程。
- 取消、超时、AgentRun 撤销和过期均不产生写入。
- Codex 无法启动、未登录、额度不足和无效输出映射到稳定错误码。
- 证据不足时继续搜索至主动时间用尽，然后返回 `CODEX_INSUFFICIENT_EVIDENCE` 且不写入任何候选。
- Codex 在运行中失去认证时进入等待；管理员恢复登录后用新 AgentRun 继续原 task/thread。
- 外部来源需登录、验证码或风控时撤销当前 AgentRun 且不写入；管理员选择跳过后用新 AgentRun 继续公开来源搜索。
- 云端成功响应丢失时重放完全相同的签名 envelope，候选批次只写一次。
- Loopback 继续严格验证 Origin、Host、method、path、content-type、PNA 和请求体大小。

### 浏览器 E2E

- 连接 Bridge，点击“开始生成候选”，按阶段展示状态，最终候选出现在共同决定页面。
- 切换酒店、餐厅和景点类别时，启动文案明确展示本次目标，最终不会出现混合类别。
- 多城市行程中必须先选择具体行程段；选择后关联日程被其他客户端修改时，启动被安全拒绝并要求重选。
- 管理员在启动前展开看到本次安全数据投影的准确内容和本机 Codex 历史持久化提示；不确认时无法启动。
- 管理员确认后、Codex 启动前发生共享数据变化时，页面提示“将发送的内容已更新，请重新确认”，不生成 Codex 任务。
- 管理员可准备、启动和停止 Codex 研究并查看本机进度；普通成员只看到静态说明和原子提交后的研究结果，不会连接 Local Bridge 或看到任何 Codex 登录、本机进度、阻断详情或任务控制入口。
- 运行中 Codex 失去认证时，管理员看到“请在 ChatGPT/Codex 中恢复登录”；恢复后继续同一任务。普通成员不看到该本机阻断状态。
- 外部来源受阻时，管理员看到清洗后来源站点和“跳过该来源并继续”/“停止任务”；界面不提供账号、Cookie 或验证码输入。
- 页面在后台或关闭时进入新阻断事件，macOS 可用时显示固定本地通知；通知被禁用时，重新打开页面仍能看到持久待处理状态。
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
- 每个候选包含至少两个归一化后不同的 HTTPS origin。
- 不连接生产 CloudBase，不写真实旅行数据。

## 验收标准

1. 本机就绪检查不创建 AgentRun；成员确认授权范围并点击“开始生成候选”后，才创建和领取新 AgentRun，然后立即创建 Codex 任务。
2. 一次点击只创建一个独立、持久、可在 Codex 中审阅的任务。
3. 只有管理员能创建、claim、启动、继续、取消或撤销 Codex 旅行研究 AgentRun；普通成员仍可参与候选反馈和共同确认。
4. Codex 认证失效或外部来源需要登录、验证码、风控时，必须只通知管理员并安全暂停；恢复后继续同一 Codex task/thread，不传递外部站点登录态。
5. 进入新的待处理阻断时，页面必须持久显示状态，Bridge 尝试发送一次不含敏感内容的 macOS 本地通知；通知失败不得使任务失败或丢失待处理状态。
6. 启动前必须展开显示本次将发送的准确安全数据投影和本机 Codex 历史提示；Bridge 必须验证 `disclosureFingerprint`，不能发送管理员未确认的更新数据。
7. 每次明确选择酒店、餐厅或景点中的一个类别，最终 2–4 个候选必须全部属于该类别。
8. 每次明确选择一个连续同城市行程段，Bridge 必须用最新签名上下文验证其城市、日期和人数。
9. Codex 只能看到允许的旅行数据、成员姓名和本次任务专用 ID 别名，不能看到 traveler ID、成员 UID、原始业务 ID、项目源码或任何秘密。
10. Codex 在隔离目录、只读沙箱、联网搜索和最多 10 分钟主动运行时间下运行；等待管理员的时间不计入。
11. 有效结果包含 2–4 个候选，每个候选至少两条证据，并且来自至少两个归一化后不同的 HTTPS origin。
12. 候选和证据通过一个 `submitProposalBatch` 原子写入，网络重试不会产生重复。
13. 取消、超时、撤销、过期、无效输出或 Codex 不可用都不能产生半成品。
14. Codex 无法确认候选、修改订单、调整正式行程或下单。

## 实施边界建议

预期改动集中在：

- `apps/local-agent-bridge/`：Codex runner、输入筛选、输出 Schema、任务状态、固定 loopback 端点，以及只使用内置文案的 macOS 本地通知适配器与失败退化。
- `apps/web/src/infrastructure/localAgentBridgeClient.ts`：固定 execute/status/resume/cancel 客户端方法。
- `apps/web/src/features/decisions/DecisionAgentPanel.tsx`：开始、进度、等待管理员、恢复、取消、完成与错误体验。
- `packages/contracts/src/decision.ts` 与相关 Schema：增加最小安全行程投影、行程段计算约定和扩展后的 Agent 读响应。
- `functions/trip-api/lib/decision-agent-bridge.js`、`functions/trip-api/lib/commands.js` 与相关 envelope：扩展签名 `getDecisionContext` 的安全投影；如需把 `expiresAt` 安全返回给 Bridge，仅扩展 claim 成功响应，不改变 15 分钟时效。
- 现有 Node、Vitest、Playwright 测试和本地运行文档。

不新增第三方运行时依赖；优先使用 Node 标准库、现有 Contracts 和已安装的 Codex CLI。
