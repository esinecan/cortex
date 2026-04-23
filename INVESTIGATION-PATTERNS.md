# Investigation Pattern Notes

Rationale for the investigation pathway's design. Each pattern below comes
from a real failure mode where the investigation oscillated, misdiagnosed,
or missed a signal that was in the data the whole time. Three of the six
are already guidance in `pathways.yaml`; the remaining three are open
enhancements.

## Pattern 1 -- Audit metadata in every query

When you query a data store during an investigation, you want "who touched
this document and when" on the first query, not the fourth. Live systems
mutate while you investigate; if you don't look for it, you won't see it.

**Symptom it prevents:** a document's state changes mid-investigation
(another service writes to it) and you chase a stale-state hypothesis for
twenty minutes before the next query reveals the mutation.

**Where it lives:** open enhancement. For a database MCP server, the
pathway-level guidance is to include `updatedAt`/`updatedBy` or equivalent
metadata in every read. An enhancement would be for the server to do this
by default when a projection is specified.

## Pattern 2 -- Scope observability queries to environment

If your logs/metrics backend spans multiple deployments (sandbox, staging,
production), every query needs an env filter or results mix across
environments. Cross-env pollution is silent -- you won't know results came
from the wrong deployment until the comparative analysis contradicts itself.

**Symptom it prevents:** a prod log line looks like a sandbox bug, a
comparative analysis concludes the feature is broken in sandbox, 30
minutes wasted before someone notices the env tag.

**Where it lives:** open enhancement. Pathway-level guidance to include
env scoping on every query; tool-level enhancement for the observability
MCP to nudge or auto-scope when the current task has a known environment.

## Pattern 3 -- Find a control case before deep-diving

Before you investigate a broken instance, find a working one. A
side-by-side comparison immediately surfaces which fields differ, and
one of those fields is usually the root cause. Without a control case,
you investigate in the dark: everything you see might or might not be
relevant, and you can't tell.

**Symptom it prevents:** twenty-minute detours chasing features that look
suspicious but exist in working instances too.

**Where it lives:** encoded in the investigation pathway's `debug` guidance
("Find a CONTROL CASE -- a similar entity where behavior is correct. Compare.").

## Pattern 4 -- Classify early: DATA / CONFIG / CODE

Issues fall into three categories with different investigation paths:
- **DATA issue** -- some external system wrote bad state. Investigation is
  timeline reconstruction: who wrote what when, and why.
- **CONFIG gap** -- fields or settings are missing. Investigation is
  comparative analysis against a working instance.
- **CODE bug** -- logic error. Investigation is trace correlation across
  the code path.

If you don't classify, you oscillate between these three paths and never
commit to one. The cost is time.

**Symptom it prevents:** investigations that visibly flip hypotheses every
five minutes without converging.

**Where it lives:** encoded in the investigation pathway's `debug` guidance
("Classify early: DATA issue, CONFIG gap, or CODE bug. Each has a different path.").

## Pattern 5 -- Query docs for the NORMAL mechanism first

When you search documentation or a knowledge base during an investigation,
your first question should be "how does X work?" -- not "how do I fix X
when it breaks?" Docs describe both, and recovery mechanisms look like
default mechanisms to someone who doesn't yet know which is which.
Conflating a recovery path with the default path leads to diagnosing a
missing recovery when the actual problem is in the default flow.

**Symptom it prevents:** a 15-minute detour configuring a workaround
feature that wasn't needed because the default flow was the issue.

**Where it lives:** partially encoded in the `diagnose` pathway guidance
("Ask the NORMAL mechanism first, THEN the recovery mechanism. Docs
describe both -- conflating them causes misdiagnosis."). Not yet echoed
in the investigation pathway; candidate addition.

## Pattern 6 -- Document-mutation detection during long investigations

For investigations longer than a few minutes on a live system, there should
be a deliberate mechanism to detect that the target document has changed
under you. Pattern 1 surfaces mutations in query results; this is about
catching them proactively.

**Symptom it prevents:** "the hypothesis I had at T+0 is no longer
relevant at T+30 because the data changed, but I'm still reasoning from
T+0 assumptions."

**Where it lives:** open enhancement. Three levels of implementation:
1. Guidance-only: re-check metadata on key entities every N minutes.
2. Tool-level: a `snapshot` primitive that records a hash and flags
   changes on subsequent calls.
3. Background: a watcher that polls and alerts when fields change.

Pattern 1 is a prerequisite for any of these -- you can't detect a
mutation you can't see.

## Meta-pattern -- the investigation pathway is a bias counterweight

Every pattern above counteracts a specific investigation bias:
- Pattern 1/6 -- availability bias (you reason from what you've already queried).
- Pattern 2 -- confirmation bias via contaminated evidence.
- Pattern 3 -- absence of reference class.
- Pattern 4 -- premature commitment to a single causal story.
- Pattern 5 -- framing bias in knowledge retrieval.

The pathway doesn't make investigations faster in the average case. It
makes them more robust against failure modes where a single early wrong
turn burns the rest of the session. The break-even point is somewhere
around "investigation expected to take more than ten minutes."
