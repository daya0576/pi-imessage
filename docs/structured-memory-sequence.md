# Structured memory sequence flow

整体分为四部分：一次性全量迁移、运行时动态读取、运行时主动写入、每日夜间 Reflection。

## 1. One-time full migration

```mermaid
sequenceDiagram
    autonumber
    participant O as Legacy MEMORY.md
    participant V as Existing v1 JSONL
    participant P as Markdown Block Parser
    participant L as Migration LLM
    participant C as Validator
    participant N as Staging v2 JSONL
    participant M as Coverage Manifest
    participant R as Runtime

    O->>P: 读取全部 section、bullet 和多行内容
    P-->>L: Source blocks<br/>path + line range + source hash
    V->>L: 补充仅存在于 v1 的 native records

    loop Batch classification and extraction
        L->>L: 拆分原子事实<br/>namespace + kind + subjects + event_time
        L->>C: Structured records + block decisions
        C->>C: Schema、ID、来源、引用和重复校验
        C->>N: 写入通过校验的 records
        C->>M: block -> memory IDs 或 skipped_reason
    end

    C->>M: 检查每个 source block 都有处理结果
    M-->>C: Coverage = 100%
    C->>N: 验证 supersedes、active view 和文件完整性
    C->>R: Atomic cutover to v2

    Note over O,V: 原文件和 v1 保留为只读归档，不直接删除
```

迁移原则：

- “全量”指每个原文 block 都被处理并可追踪，不代表每一行都必须生成一条记忆。
- 无法确认事实日期时使用 `event_time: null`，不伪造日期。
- `namespace` 是运行时加载单元，例如 `health/paipai`、`work/cc`、`project/pi-imessage`。
- `kind` 描述记录类型，例如 `fact`、`event`、`preference`、`procedure`。

## 2. Runtime read

```mermaid
sequenceDiagram
    autonumber
    actor U as User / Chat
    participant P as pi-imessage
    participant A as Main LLM
    participant M as Memory Tool
    participant S as v2 JSONL

    Note over P,A: Session 初始只包含小型 core.md
    U->>P: Incoming message
    P->>A: Current message
    A->>A: 根据对话选择相关 namespace<br/>可多选，也可以不选

    opt 需要历史记忆
        A->>M: load_memory(namespaces)
        M->>S: 读取所选 namespace 的全部 active records
        S-->>M: Current records
        M-->>A: 完整 namespace context
    end

    Note over A: Main LLM 自己判断哪些记录与当前问题相关
    A-->>P: Answer
    P-->>U: iMessage reply
```

## 3. Runtime write

```mermaid
sequenceDiagram
    autonumber
    actor U as User / Chat
    participant P as pi-imessage
    participant A as Main LLM
    participant M as Memory Tool
    participant S as v2 JSONL

    U->>P: Incoming message
    P->>P: Append raw event to log.jsonl
    P->>A: Current message
    A->>A: 判断是否值得长期记忆

    alt 不值得记、重复或不确定
        A-->>P: 直接回答
    else 值得记忆
        A->>A: 生成结构化记录<br/>text, namespace, kind, subjects,<br/>event_time, source, importance, confidence
        opt 纠正旧事实
            A->>M: search_memory(old fact)
            M-->>A: Old memory ID
            A->>A: 设置 supersedes_id
        end
        A->>M: save_memory(structured record)
        M->>M: Schema、去重和 supersedes 校验
        M->>S: Append JSONL
        S-->>M: Stored record ID
        M-->>A: Stored / already exists
        A-->>P: Answer
    end

    P-->>U: iMessage reply
```

## 4. Nightly reflection

```mermaid
sequenceDiagram
    autonumber
    participant C as Nightly Cron
    participant K as Reflection Checkpoint
    participant G as Chat log.jsonl
    participant R as Reflection LLM
    participant M as Memory Tool
    participant S as v2 JSONL

    C->>K: 读取上次成功处理的位置
    K-->>C: Last processed message IDs / timestamps
    C->>G: 读取各 Chat 尚未处理的消息
    G-->>R: 按对话窗口分批提供原始消息

    R->>R: Reflection<br/>遗漏的长期事实、偏好、纠错和关系变化
    R->>M: load_memory(relevant namespaces)
    M->>S: 读取对应 active records
    S-->>M: Existing memory
    M-->>R: 用于去重和识别纠错

    loop 每条值得保留的候选记忆
        R->>M: save_memory(structured record)
        M->>M: Schema、去重和 supersedes 校验
        M->>S: Append JSONL
        S-->>M: Stored / already exists
        M-->>R: Result
    end

    alt 本批全部成功
        R->>K: 提交新的 checkpoint
        R-->>C: Reflection summary
    else 处理中断
        R-->>C: 报告失败，不推进 checkpoint
    end
```

Reflection 原则：

- 运行时写入负责及时记录，夜间 Reflection 负责补漏、去重和识别跨消息形成的事实。
- 使用 checkpoint，而不是每天盲扫固定 48 小时；失败时不推进，下一次可安全重试。
- Reflection 与聊天时写入共用同一个 `save_memory` 路径，不直接修改 JSONL，也不写旧 `MEMORY.md`。
- 不把每天聊天摘要整体存成记忆，只保存长期有用的原子事实。

## Responsibility boundaries

- Main LLM：理解自然语言、选择 namespace、决定是否记忆并生成结构化字段。
- Reflection LLM：夜间扫描未处理对话，补漏、去重并识别跨消息形成的记忆。
- Memory Tool：只做读取、校验、去重、append 和 supersedes，不用关键词理解自然语言。
- v2 JSONL：唯一的结构化 memory source of truth。
- Coverage Manifest：证明旧 MEMORY.md 没有被静默漏迁。
- Reflection Checkpoint：保证夜间任务可重试且不会静默跳过消息。
- `core.md`：只保存少量稳定、高频信息。
- Legacy MEMORY.md / v1 JSONL：迁移完成后只读归档。
- 不使用固定关键词分类、Semantic Index、embedding 或 reranker。
