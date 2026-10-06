# 0036. Workspace policy and a neutral service identity

Status: proposed (owner requested this implementation)

**Problem.** A reusable message service should not hard-code an operator's system
record layout, fallback model, billing tier or personal launchd identifier.

**Example.** One workspace can explicitly retain its current fallback and priority
tier, while another fails on an unavailable default rather than choosing a model
or spending preference on the user's behalf.

**Decision.**

- Keep memory and the other shared native tools built in. ADR 0035 owns personal
  business code and its scheduling configuration.
- Move `SYSTEM.md` summary loading into an optional workspace extension; its
  path, boundary and byte budget are configuration. Move system-record update
  instructions into workspace `AGENTS.md`, not the framework prompt.
- `settings.json.modelPolicy.fallback` optionally selects a provider/model pair.
  An absent fallback fails explicitly when the selected default is unavailable.
  Use only an available model with configured authentication.
- `modelPolicy.codexServiceTier` optionally chooses `default` or `priority`.
  Absence leaves the provider payload unchanged. Reload applies policy to future
  requests; it does not interrupt existing calls.
- Generate launchd jobs with neutral identity `org.pi-imessage.service`. Do not
  silently rename a loaded controller or start another pipeline. Migrate an
  installed personal-label job only under the operations handover procedure.
- Existing configuration remains compatible. The offline migration preserves
  unknown settings and explicitly records the prior fallback/tier, rather than
  silently changing live model or cost behavior. It retains source/configuration
  rollback copies and never rewrites Durable state.

**Consequences.** The workspace owns and backs up its personal code and policy.
New installations have no implicit fallback or priority preference. A foreground
Terminal deployment needs no controller migration when no old-label job exists.
This supersedes ADR 0004's hard-coded Codex fast wrapper choice only, not its
native-extension or no-SDK-adapter decisions.
