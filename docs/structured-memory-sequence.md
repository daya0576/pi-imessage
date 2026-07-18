# Structured memory read/write sequence

Design goals:

- The LLM understands and classifies natural language; the storage CLI only validates and persists structured records.
- Category is metadata, not a keyword-based retrieval gate.
- Category JSONL files are the structured source of truth. Semantic indexes and summaries are derived and rebuildable.
- Legacy `MEMORY.md` files are read-only migration archives.

## Read flow

```mermaid
sequenceDiagram
    autonumber
    actor U as User / Chat
    participant P as pi-imessage
    participant R as Memory Reader
    participant S as JSONL Store
    participant I as Semantic Index
    participant L as LLM Reranker
    participant A as Main LLM

    U->>P: Incoming message
    Note over P: Load small core.md (always-on)
    P->>R: Query + sender/chat context
    R->>S: Load active records / resolve supersedes
    S-->>R: Active memory records
    R->>I: Semantic top-K recall
    I-->>R: Candidate memory IDs + scores
    opt Low-confidence or high-stakes query
        R->>L: Query + candidate records
        L-->>R: Relevance-ranked top-N
    end
    R-->>P: Compact relevant memory context
    P->>A: core.md + relevant records + current message
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
    participant C as Memory CLI
    participant S as JSONL Store
    participant I as Semantic Index

    U->>P: Incoming message
    P->>P: Append raw event to log.jsonl
    P->>A: Current message + retrieved context
    A->>A: Decide should_remember
    alt Not durable / duplicate / uncertain
        A-->>P: Skip memory write
    else Durable memory
        A->>A: Produce structured record<br/>text, category, subjects, event_time,<br/>source, importance, confidence, supersedes
        A->>C: add(structured record)
        C->>C: Schema validation + ID generation<br/>dedupe + supersedes validation
        C->>S: Append to categories/*.jsonl
        S-->>C: Stored record ID
        C-->>I: Async/incremental index refresh
        C-->>A: Stored / already exists
    end
    A-->>P: Answer
    P-->>U: iMessage reply
```

## Responsibility boundaries

| Component | Responsibility | Must not do |
| --- | --- | --- |
| Main LLM | Decide whether a fact is durable; extract atomic text, category, subjects, date, source and correction relationship | Silently overwrite history |
| Memory CLI | Validate schema, generate deterministic IDs, deduplicate and append/supersede records | Interpret natural language with fixed keyword lists |
| JSONL store | Preserve auditable structured memory history | Act as a generated cache |
| Semantic index | Retrieve candidates by meaning | Become a source of truth |
| LLM reranker | Resolve ambiguous relevance when needed | Run unconditionally if semantic scores are already decisive |

Open review decisions:

1. Use local embeddings or a hosted embedding model for the derived semantic index.
2. Invoke the LLM reranker only below a confidence threshold, or on every read.
3. Refresh the semantic index synchronously after a write, or asynchronously in a short debounce window.
