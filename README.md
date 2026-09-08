# OrgFit

Internal organizational assessment and consulting platform for OrgFit personnel.

This repository currently contains the complete planning baseline and implementation prompts. Application implementation has **not started**.

## Start here

1. Read [the master blueprint](docs/orgfit/blueprint.md).
2. Open [the Astra 6 prompt pack](docs/orgfit/implementation-prompts.md).
3. Begin with the Project Brief and Phase 00. Phases 00–01 are architecture/schema design before application coding.
4. Follow [phase status](docs/orgfit/phase-status.md). Run every checkpoint before its dependent phase.

## Working across sessions

Use this same repository for the whole project. Phases 00–01 can share a session; use a fresh session for each later phase and preferably each checkpoint. In every new session, provide the Project Brief plus the exact phase/checkpoint prompt and have the agent read `AGENTS.md`, the blueprint, decisions, and phase status first. A new session continues the existing code; it does not restart the project.

Run phases sequentially. If a tool creates an isolated checkout, ensure the previous phase's changes are brought into the next phase's checkout before continuing. Do not run dependent phases against an old snapshot of the repository.

## Documents

| File | Purpose |
|---|---|
| [AGENTS.md](AGENTS.md) | Persistent project instructions for implementation agents. |
| [Blueprint](docs/orgfit/blueprint.md) | Requirements, architecture, schema, privacy, lifecycle, scoring, reports, and acceptance criteria. |
| [Implementation prompts](docs/orgfit/implementation-prompts.md) | 16 phases, seven checkpoints, recovery and scope-change prompts. |
| [Phase status](docs/orgfit/phase-status.md) | Progress, actual test evidence, blockers and next action. |
| [Decisions](docs/orgfit/decisions.md) | Baseline decisions and subsequent architecture decisions. |

## Product boundaries

OrgFit is internal only: no subscriptions, billing, company accounts, client dashboards, or cross-company benchmarks. Respondents have no accounts. Identity/completion tracking stays separate from finalized anonymous answers. Arabic is the default with RTL; English is secondary. Branding/design direction is supplied separately by the owner.

The blueprint defines the precise privacy trust model and production review gates. Do not equate a five-response threshold with a universal anonymity guarantee.

## Repository status

Local Git repository on `main`. No remote hosting or public publication is configured. No runtime stack, application dependencies, or deployment has been created yet; these are phase work.
