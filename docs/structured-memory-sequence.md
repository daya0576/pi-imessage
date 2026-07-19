# Structured memory sequence flow

整体分为三部分：一次性全量迁移、运行时动态读取、运行时主动写入。

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

## Responsibility boundaries

- Main LLM：理解自然语言、选择 namespace、决定是否记忆并生成结构化字段。
- Memory Tool：只做读取、校验、去重、append 和 supersedes，不用关键词理解自然语言。
- v2 JSONL：唯一的结构化 memory source of truth。
- Coverage Manifest：证明旧 MEMORY.md 没有被静默漏迁。
- `core.md`：只保存少量稳定、高频信息。
- Legacy MEMORY.md / v1 JSONL：迁移完成后只读归档。
- 不使用固定关键词分类、Semantic Index、embedding 或 reranker。
