# OrgFit decisions

## Status of this file

This is an initial decision register, not a completed Phase 00 architecture review. The blueprint is the current planning baseline. Phase 00 must inspect the repository, reconcile these decisions and document the implementation architecture.

## Existing baseline

| ID | Decision | Source/status |
|---|---|---|
| D-001 | Internal OrgFit platform; no customer-facing account/subscription system. | Explicit owner requirement. |
| D-002 | Arabic default/RTL; English secondary/LTR; replaceable theme variables. | Explicit owner requirement. |
| D-003 | Unique manually shared links, accountless respondents, save/resume and locked single final submission. | Explicit owner requirement. |
| D-004 | Separate completion identity from finalized answers; minimum five-contributor reporting threshold. | Explicit owner requirement; detailed threat model requires production review. |
| D-005 | Live participation; results released after closure and privacy checks. | Blueprint implementation baseline. |
| D-006 | One campaign per assessment round; frozen roster/version/grouping. | Blueprint implementation baseline. |
| D-007 | Department-only response segmentation initially; richer demographic attributes stay private in the directory. | Blueprint privacy baseline. |
| D-008 | Raw text/exact dates withheld from staff reports by default; no raw respondent exports. | Blueprint privacy baseline. |
| D-009 | Immutable versioned instruments/scoring/rules and published results. | Blueprint implementation baseline. |
| D-010 | No skip logic; deterministic scoring and recommendation rules. | Explicit owner requirement. |
| D-011 | Reuse this repository across phases; preserve completed work and checkpoint evidence. | Owner workflow and implementation plan. |

## Not yet selected or accepted for production

Actual framework/runtime/library versions, hosting provider/region, identity provider, queue, key-management/processor operation, approved retention durations, independent privacy review, real instrument content/translations/scoring thresholds, and production deployment authorization.

These are not reasons to restart the blueprint or block nondependent planning work. Resolve technical choices in Phase 00–01; keep owner-specific production inputs visible.

## Format for subsequent decisions

Record ID, date, status (PROPOSED/ACCEPTED/SUPERSEDED), context, options, selected approach, rationale, affected modules/contracts/migrations, privacy/history implications, and verification. Distinguish explicit owner requirements from implementation defaults. Do not silently weaken a requirement.
