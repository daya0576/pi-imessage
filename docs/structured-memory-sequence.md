# Structured memory read/write sequence

第一版采用 Category 级动态加载：不在 Session 启动时加载全部记忆，也不做关键词路由或单条记录的语义检索。

Category 由正在聊天的 Main LLM 根据上下文选择；Memory Tool 只按选择结果读取对应 JSONL。

## Read flow

```mermaid
sequenceDiagram
    autonumber
    actor U as User / Chat
    participant P as pi-imessage
    participant A as Main LLM
    participant M as Memory Tool
    participant S as categories/*.jsonl

    Note over P,A: Session 初始只包含小型 core.md
    U->>P: Incoming message
    P->>A: Current message
    A->>A: 判断需要哪些 Category<br/>可多选，也可以不选

    opt 需要历史记忆
        A->>M: load_categories([health, person, ...])
        M->>S: 读取所选 Category 的全部有效记录
        S-->>M: Active records
        M-->>A: 完整 Category memory context
    end

    Note over A: LLM 自己从 Category 全集里判断相关事实
    A-->>P: Answer
    P-->>U: iMessage reply
```

## Write flow

```mermaid
sequenceDiagram
    autonumber
    actor U as User / Chat
    participant P as pi-imessage
    participant A as Main LLM
    participant M as Memory Tool
    participant S as categories/*.jsonl

    U->>P: Incoming message
    P->>P: Append raw event to log.jsonl
    P->>A: Current message
    A->>A: 判断是否值得长期记忆

    alt 不值得记 / 重复 / 不确定
        A-->>P: 直接回答，不写 memory
    else 值得记忆
        A->>A: 生成结构化记录<br/>text, category, subjects, event_time,<br/>source, importance, confidence, supersedes
        A->>M: save_memory(structured record)
        M->>M: Schema 校验、去重、校验 supersedes
        M->>S: Append JSONL
        S-->>M: Stored record ID
        M-->>A: Stored / already exists
        A-->>P: Answer
    end

    P-->>U: iMessage reply
```

## 关键点

- Main LLM 通过 typed tool 自己选择一个或多个 Category，不需要额外的 classifier LLM。
- Memory Tool 的 Category 参数使用固定 enum，但分类判断来自 LLM，不来自关键词表。
- `load_categories` 返回所选 Category 下的全部有效记录，不做单条记录筛选。
- 同一 Session 已加载过的 Category 不重复注入；文件有更新时只补充 delta，避免 context 线性膨胀。
- JSONL 是 source of truth；`core.md` 只放少量稳定、高频信息；旧 `MEMORY.md` 只读。
- 不使用固定关键词分类、Semantic Index、embedding 或 reranker。
