# OrgFit project instructions

## Required reading

Before beginning a phase, read `docs/orgfit/blueprint.md`, `docs/orgfit/phase-status.md`, `docs/orgfit/decisions.md`, and the requested section in `docs/orgfit/implementation-prompts.md`. Inspect current code, database/migrations, lockfiles, tests and pending user changes before editing. The owner's current explicit instructions take precedence over these project instructions.

## Scope and continuity

- Implement only the requested phase or checkpoint and necessary compatible repairs. Do not start later phases automatically.
- Preserve existing user work and unrelated completed modules. Do not rewrite architecture or switch a working stack unnecessarily.
- Phases 00–01 produce architecture and schema design before application coding. The initial documentation commit is not evidence that those phases are complete.
- Maintain one coherent repository across sessions. Read the previous phase handoff and ensure its code is present before starting dependent work.
- Do not reset databases, discard changes, or run destructive migrations to make tests pass.
- Keep planning documents synchronized when an explicitly accepted requirement changes. Record significant technical decisions and their consequences.

## Binding product rules

- Internal OrgFit staff platform only. No SaaS subscriptions, billing, client accounts/dashboards or cross-company benchmarking.
- Respondents have no accounts; secure manually shared links allow save/resume and one immutable final submission.
- Organization-owned data, jobs, files and reports must remain scoped to one authorized organization.
- Keep identity/completion tracking separate from finalized anonymous answers. No staff raw-response browser, individual scorecard, identity-to-answer bridge or respondent-level export.
- Follow the blueprint's encrypted-draft/intake, single-use transaction, processor trust boundary, logging, retention, batch recovery and disclosure requirements. Never invent cryptography or overclaim anonymity.
- At least five valid contributors per released metric, with complementary and other disclosure controls. Completion is live; answer results publish after closure/privacy checks.
- No conditional skip logic. Questions are mandatory by default but may be optional. Published instruments/scoring/rules/results are immutable and versioned.
- Recommendations are deterministic, not AI-dependent. Historical comparisons require compatible measurements within the same organization.
- Arabic default with full RTL; English LTR. Localization and replaceable theme variables begin in the foundation. Do not invent branding or a design prompt.

## Completion evidence

Run appropriate tests and required checkpoint checks. Record tests actually executed, outcomes, changed files/migrations, defects, unresolved production inputs, and the next step in `docs/orgfit/phase-status.md`. Never mark an unrun check passed. Fix relevant regressions before proceeding. Do not claim production readiness without required privacy, security, backup, and deployment evidence.

Development authorization is not authorization to publish the repository, deploy to production, or send messages/files externally.
