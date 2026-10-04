# 0011. Reconcile unsent answers after intervening input

Status: accepted (2026-10-04; owner chose reconciliation and explicitly included different senders)

**Context.** Native steer places all selected messages after a tool round when configured with `steeringMode: "all"`. At a final-answer boundary, however, Durable first records the answer and settles that run's inputs; selected new messages start another run. The earlier answer remains eligible for delivery even when a newer message corrects its assumptions. An `onYield` continuation does not change this: it is ignored when the boundary selects user input. See [the state ownership decision](0001-durable-owns-state.md) and [at-most-once replies](0003-replies-at-most-once.md).

**Example.** The model is finishing a two-day itinerary when the user says “three days instead.” Sending both itineraries is confusing. Conversely, blindly dropping the first answer when the new message asks an unrelated question can lose useful work.

**Decision.** Reconcile delivery, not execution:

- If newer ordinary input was durably accepted before an answer's transport claim, hold that unattempted answer for reconciliation. Do not abort or replay the completed tools.
- Give the next generation truthful information about which assistant answers were actually sent and which remain drafts. It must apply corrections, retain valid completed work and answer unrelated questions separately in its final response.
- Include messages from different senders in that decision. Keep each sender's identity and request distinct; a later sender does not automatically retract or correct another person's request. Reconcile shared tasks where appropriate and ask for clarification when their requirements conflict.
- Supersede held drafts only when a replacement final answer is durably ready. Preserve all original entries and explicit delivery disposition for inspection.
- If reconciliation fails or is cancelled, retain the held drafts for inspection; do not automatically release possibly obsolete answers. Operator-facing state must explain why a reply is held. No silent deletion.
- A reply already claimed as `sending` cannot reliably be retracted. Later input affects future replies. Existing `sent`/`unknown` receipts remain authoritative and are never automatically retried.

This is not permission to change Durable's inbox, introduce a host model loop, add a debounce window, replay a turn or classify topics with a second model call. Slash-command cancellation requires its own command-boundary handling.

**Consequences.** A late unrelated message can delay an otherwise valid answer; the next response must preserve that answer rather than assume it was delivered. Continuous input can extend this delay. Reconciliation failure can leave visible undelivered drafts requiring intervention. The owner accepted these product trade-offs.

**Alternatives.** Always send every completed answer (preserves delivery timing but exposes obsolete answers). Drop all but the latest answer (can silently lose unrelated answers). Guess corrections from keywords (unreliable). Change or wrap Durable's internal finalization logic (violates state ownership).

**Approval.** The owner selected waiting for the next turn and replying together, explicitly including different senders in the decision. This approval covers reconciliation of unattempted replies, not retraction or replay of claimed sends.
