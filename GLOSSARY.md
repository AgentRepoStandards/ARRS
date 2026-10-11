# ARRS

ARRS describes the repository contract that supports bounded engineering delegation.

## Language

**Feature Map**:
A maintained description of a user or system capability, its ownership, invariants and acceptance behaviour.
_Avoid_: feature inventory, implementation checklist

**Proof Contract**:
The evidence requirements a change must satisfy before it is ready for review.
_Avoid_: green CI, verification claim

**Proof package**:
The recorded results and evidence used to assess whether a change satisfies its Proof Contract.
_Avoid_: attestation, certificate

**Risk class**:
The impact category of a change that determines its permitted autonomy, verification and review.
_Avoid_: agent trust level

**Maturity level**:
The highest cumulative ARRS capability demonstrated by a repository during an audit.
_Avoid_: security score, autonomy permission

**Paved road**:
The existing supported way of implementing and verifying a class of repository changes.
_Avoid_: preferred abstraction

**Gardener**:
A workflow that improves the repository's engineering substrate using evidence of drift and repeated failure.
_Avoid_: cleanup bot, automatic rewrite

**Ready for agent**:
A work state in which scope, context, acceptance, dependencies and risk permit an agent to start independently.
_Avoid_: assigned, unblocked
