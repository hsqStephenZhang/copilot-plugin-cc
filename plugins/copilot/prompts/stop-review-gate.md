<task>
Run a stop-gate review of the previous Claude turn.
Review only the supplied diff, captured between the start and end of this turn.
It includes edits made by file tools, shell commands, and delegated processes.
Pre-existing changes are excluded from this diff. Do not review unrelated older edits.
Challenge whether this specific work and its design choices should ship.

{{CLAUDE_RESPONSE_BLOCK}}
</task>

<turn_diff>
{{TURN_DIFF}}
</turn_diff>

<compact_output_contract>
Return a compact final answer.
Your first line must be exactly one of:
- ALLOW: <short reason>
- BLOCK: <short reason>
Do not put anything before that first line.
</compact_output_contract>

<default_follow_through_policy>
Use ALLOW if you do not see a blocking issue in the supplied diff.
Use BLOCK only for a material issue introduced by that diff.
Never make changes during this review.
</default_follow_through_policy>

<grounding_rules>
Ground every blocking claim in the repository context or tool outputs you inspected during this run.
The supplied turn diff is the authoritative scope; the previous response is context only.
Repository tools may provide context but do not expand the review scope.
</grounding_rules>

<dig_deeper_nudge>
If the previous turn did make code changes, check for second-order failures, empty-state behavior, retries, stale state, rollback risk, and design tradeoffs before you finalize.
</dig_deeper_nudge>
