# 0006. One JSONL storage, backed up by hand

Status: proposed (2026-10-04)

**Context.** Durable can store to memory, SQLite or JSONL. The owner backs up `WORKING_DIR` with git in their dotfiles.

**Decision.** One JSONL storage at `WORKING_DIR/durable/` for all chats, with `fsync` on. A lock file stops a second process from opening it, since Durable has no cross-process lock. The bot runs no backup job.

**Consequences.** Readable text diffs in git. Not every change is an append: Durable rewrites its side files when it reclaims them. A copy taken mid-write still opens, because Durable drops an unfinished tail.

**Rejected.** SQLite (a binary file in git). One storage per chat (more files and locks, and no cross-chat tasks).
