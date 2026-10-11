# Minimal-context agent operation

A ready work item supplies the objective, acceptance criteria, Feature Map identifiers, affected scope, risk, dependencies, verification and unresolved decisions. The agent starts with that item and `AGENTS.md`, follows the relevant map and linked policy, then inspects code. It loads additional documentation only when a decision or constraint requires it.

The working sequence is: locate the feature; establish risk; inspect the paved road; make the smallest correct change; run static checks, tests and behavioural verification; validate the proof package; request the review required by policy. An incomplete reproduction, failed command or missing human decision is recorded as a blocker, not converted into success.

Use [task preparation](../task-preparation.md) to assemble the bounded context, exact gates and draft contracts from a non-executable local work item. A prepared packet retains unresolved knowledge and supplies no execution readiness, accepted evidence or approval.

## Persistent execution plans

Use a committed plan under `.agent/plans/` for substantial multi-step work, cross-boundary changes, migrations or work likely to outlive one context window. Trivial R0/R1 changes usually need only the self-contained work item and proportionate proof.

A plan contains the objective and acceptance criteria; repository context and relevant maps; constraints and decisions; milestones; exact verification strategy; current state; discoveries; blockers; and completion evidence. Record commands and artifact paths alongside outcomes. Keep unresolved choices explicit. Update progress after a meaningful milestone or changed assumption.

The [example plan](../../templates/execution-plan.md) shows the information contract. Separate source changes from generated evidence: plans are durable, `.arrs/evidence/` is ignored.

## Handoff

Before handoff, update the work item and plan with current state, changed files, decisions, passing and failing commands, evidence paths, outstanding work and the next safe action. State whether evidence must be regenerated. Another agent must be able to continue from the repository and work item alone; a chat transcript is optional context.

Scoped `AGENTS.md` files are useful when an area has distinct constraints. Keep their rules local and route to them from feature ownership. Avoid copying the root contract into every directory.
