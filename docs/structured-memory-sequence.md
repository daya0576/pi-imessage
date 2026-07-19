# Structured memory read/write sequence

第一版采用全量加载，不做关键词路由、Semantic Index 或 LLM rerank。

当前约 490 条有效记录，紧凑文本约 5.8 万字符（约 2–3 万 tokens）。只在 session 创建时加载一次，不在每轮消息中重复注入。

## Read flow

```mermaid
sequenceDiagram
    autonumber
    participant P as pi-imessage
    participant S as categories/*.jsonl
    participant A as Main LLM Session
    actor U as User / Chat

    Note over P,A: Session 创建
    P->>S: 读取全部当前有效记录
    S-->>P: 紧凑 memory context
    P->>A: 创建 Session<br/>system prompt = core.md + 全部 active memory

    Note over U,A: 后续每条消息不再重复注入 memory
    U->>P: Incoming message
    P->>A: Current message
    Note over A: LLM 直接从完整 memory context 判断相关性
    A-->>P: Answer
    P-->>U: iMessage reply
```

## Write flow

```mermaid
sequenceDiagram
    autonumber
    actor U as User / Chat
    participant P as pi-imessage
    participant A as Main LLM Session
    participant C as Memory CLI
    participant S as categories/*.jsonl

    U->>P: Incoming message
    P->>P: Append raw event to log.jsonl
    P->>A: Current message
    A->>A: 判断是否值得长期记忆

    alt 不值得记 / 重复 / 不确定
        A-->>P: 直接回答，不写 memory
    else 值得记忆
        A->>A: 生成结构化记录<br/>text, category, subjects, event_time,<br/>source, importance, confidence, supersedes
        A->>C: add(structured record)
        C->>C: Schema 校验、去重、校验 supersedes
        C->>S: Append JSONL
        S-->>C: Stored record ID
        C-->>A: Stored / already exists
        Note over A: 当前 Session 已通过 tool call 知道新记录
        A-->>P: Answer
    end

    P-->>U: iMessage reply
    Note over P,S: 新 Session 会重新加载最新全集
```

## 边界

- Main LLM：理解自然语言，决定是否记忆，并生成 Category、Subjects 等结构化字段。
- Memory CLI：只做确定性的校验、去重和持久化，不用关键词理解自然语言。
- JSONL：结构化记忆的 source of truth。
- `core.md`：只放少量稳定且高频的信息。
- `MEMORY.md`：只读迁移归档。
- 不使用固定关键词分类、Semantic Index、embedding 或额外 reranker。
