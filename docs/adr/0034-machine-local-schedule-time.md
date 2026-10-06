# 0034. Use the service machine's local time for schedules

Status: proposed (owner requested the complete local-time change)

**Problem.** Daily deadlines, learning dates and schedule history are hard-coded
for Asia/Shanghai, even when the service runs on a machine in another timezone.

**Example.** A daily 07:45 job on a New York machine should run at 07:45 there,
including after a daylight-saving change, not at 07:45 Shanghai time.

**Decision.**

- Use the service process's local calendar for daily deadlines and learning dates.
  By default this is the machine timezone; an explicit `TZ` environment override
  is respected and retained by installation and routine restart.
- Calculate the next daily slot by calendar date, not by adding 24 hours. Use
  JavaScript Date's local-time rules: nonexistent spring-forward times move
  forward through the gap; repeated fall-back times select the first occurrence.
- Include the service timezone in each configured job's read-only projection.
  The Web UI formats deadlines and history in that timezone, not the browser's.
- Retain saved absolute deadlines, occurrence dates, task IDs, learning history
  and send receipts. The next computed slot uses local time. A timezone change
  does not authorize regenerating cards, backfilling dates or replaying sends.
- Six-hour compaction remains an elapsed-time interval, independent of timezone
  and daylight-saving changes.

This proposal supersedes only ADR 0032's fixed Asia/Shanghai calendar policy.
All other scheduling, recovery and at-most-once delivery decisions remain intact.

**Consequences.** Moving a deployment or changing `TZ` changes future calendar
slots. An already saved deadline remains an absolute instant until processed;
restart does not silently replace its checkpoint.

**Rejected.** Changing only README text, hard-coded UTC offsets, adding 24 hours
for calendar recurrence, using the browser timezone for server schedules, and
rewriting production learning or receipt data.
