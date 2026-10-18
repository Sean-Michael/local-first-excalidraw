---
name: architecture-review
description: Critique the system an architecture diagram shows, not the drawing (single points of failure, long synchronous call chains, databases shared across services, queue consumers without retries, dead-lettering or idempotency, sensitive data crossing trust boundaries, cyclic dependencies), checking each finding against the code and annotating it on the drawing as a red note with a severity, without restructuring the user's diagram. Use when asked to review, critique, assess or find risks, weaknesses, bottlenecks or failure modes in an architecture, system design or .excalidraw architecture diagram.
---

# Architecture review

This skill judges the system, not the picture. The diagram-review skill covers readability; this one asks what breaks, what doesn't scale, and what leaks. Findings go on the drawing as red notes next to the elements they're about, so the user sees them in context. The user's own elements stay exactly where and how they are.

Reference files in `references/` go deeper:

| File | Read it for |
|---|---|
| `checks.md` | Each check: what it looks like on a diagram, how to confirm it in code, default severity, and the usual fixes |
| `annotating.md` | The note format, placement, element JSON, and the summary block |

## Method

1. **Read the drawing.** `read_drawing` for ids, labels, frames, arrows and `code=` links, and keep its `rev`. `render_drawing` once to see it as the user does. Write down what the system is for and which flows matter most (usually the one that makes money or holds personal data).
2. **Ground it in code.** A diagram can be wrong or stale. For each element with a `code` link (or a matching name in the repo), check the claims the findings will rest on: timeouts, retries, transactions, acks, which tables each service touches, which headers are trusted. If there's no code, review the diagram as drawn and say so. Where the diagram and code disagree, report that as a finding of its own (the architecture-discovery skill rebuilds the model properly).
3. **Run the checks** in `checks.md`:
   - **Single points of failure:** one instance of something every critical flow needs (database, broker, cache, gateway, auth service), with nothing showing replicas, failover or a degraded mode.
   - **Synchronous call chains:** a request that waits on three or more hops, or on a third party, before it can answer; no timeouts or circuit breakers.
   - **Shared databases:** two or more services reading or writing the same store, especially the same tables or foreign keys across service lines.
   - **Messaging reliability:** consumers without bounded retries, a dead-letter queue or idempotent handling; publishers with a dual write (DB commit then publish) and no outbox.
   - **Sensitive data across trust boundaries:** credentials, tokens, card or personal data crossing into a less-trusted zone or a third party, unauthenticated internal hops, trusted identity headers.
   - **Cyclic dependencies:** A calls B calls A, synchronously or through events.
4. **Rate each finding** **high** (an outage, data loss, double charge or data leak is likely under ordinary failures), **medium** (degraded service or costly incident under foreseeable load or failure), or **low** (a smell or a scaling limit for later). Say what failure triggers it, not just the pattern name.
5. **Annotate.** `snapshot_drawing` (`name: "before architecture review"`). Then add one red note per finding next to the element it's about, with a dashed red arrow to that element, and a summary block, in one `add_elements` or `apply_changes` batch with `if_rev` (`annotating.md`). Render, and fix only your own notes if they overlap anything.
6. **Report** in the reply: findings ordered by severity, each with the element, the evidence (file and line), the failure scenario and one or two fixes. Mention what you checked and found fine, so the user knows it was looked at.

## Rules

- **Don't restructure the drawing.** Don't move, resize, restyle, relabel, reconnect or delete the user's elements, and don't redraw "the fixed architecture" over theirs. Notes and their arrows are the only additions. If a proposed fix needs a picture, offer a separate drawing (or a second frame placed beside the original) and ask first.
- **One note per finding,** anchored to the most specific element. Arrows can only bind to shapes, so a finding about a call sits beside that arrow, points at the box that makes the call, and names the call in its text. A finding that spans several elements points at the main one and names the others.
- **Evidence over pattern-matching.** "One Postgres box" is a prompt to check, not a finding. If the code or infrastructure shows a replica, a retry policy or an outbox, the finding goes away or drops in severity.
- **Every note is removable.** Give note ids a `review-` prefix so the user (or you, later) can delete them all in one call.
- Readability problems you notice go in one line at the end of the report, pointing at the diagram-review skill. Don't fix them in this pass.

## Checklist

- [ ] Snapshot taken before annotating.
- [ ] Every finding names the element, the failure that triggers it, its severity and a fix.
- [ ] Every finding was checked against code or config, or is marked as drawn-only.
- [ ] Notes are red, prefixed with the severity, bound to their element, and don't cover anything.
- [ ] No user element changed (ids, positions, labels, colours and arrows are as they were).
- [ ] The reply lists findings by severity and what was checked and found fine.
