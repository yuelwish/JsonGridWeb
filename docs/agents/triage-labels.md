# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Repo note

These five labels were **created in this repo on 2026-10-09** to match this table. They sit alongside GitHub's stock labels (`bug`, `enhancement`, `documentation`, `duplicate`, `good first issue`, `help wanted`, `invalid`, `question`, `wontfix`, `accessibility`), which are left in place and unused by these skills.

`wontfix` already existed as a GitHub default label and was reused as-is.

## Repo-specific reading

This repo has **no automated tests**. `npm run verify` covers only the compact serializer, and CI (`.github/workflows/deploy.yml`) runs build + deploy with no test job. Any spec in this repo must state its verification as static assertions plus a manual checklist — see the Testing Decisions section of the spec.