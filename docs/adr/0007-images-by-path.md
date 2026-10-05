# 0007. Store images as file paths

Status: accepted (2026-10-04; owner accepted 2026-10-05)

**Context.** Durable stores images inside entries as base64. Old chats hold several GB of images; inlining them would bloat `durable/` and the dotfiles backup. Durable's `read` tool cannot read images yet.

**Decision.** Incoming images are saved under `attachments/<chat>/` (HEIC converted to JPEG), and the user entry carries the path. `extensions/read-image.ts` extends `read`: for an image path it returns the image, resized for the model.

**Consequences.** Looking at an image costs the model one extra tool call. `durable/` stays text.

**Rejected.** Inline base64 (Durable's default).
