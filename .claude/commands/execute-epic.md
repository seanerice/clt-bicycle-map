---
description: Execute a full epic from docs/planning/stories.md, top to bottom, as a stack of reviewed PRs
---

Execute epic **$ARGUMENTS** end to end, following the process below. `docs/planning/stories.md` already contains the plan — do not re-plan, do not use EnterPlanMode, do not ask the user to approve a plan. If the stories are ambiguous enough that real design judgment is needed, say so and ask; otherwise just execute.

## 0. Read, then group — don't execute story-by-story

Read the target epic's stories in full (`docs/planning/epics.md` for the epic's goal/scope, `docs/planning/stories.md` for its numbered stories). Each story is a checklist unit for acceptance criteria — it is **not** automatically a PR unit. Group stories into PR-sized slices using these rules, and state the grouping briefly before starting (one short list, not a question — proceed after stating it unless something is genuinely ambiguous):

- **Bundle doc-only/decision stories together.** Stories whose entire deliverable is "record a decision in the docs" (no application code) belong in one PR, even if a couple of them require real investigation first (fetching data, running a query, measuring something) to back the decision with evidence.
- **Never split a single working feature across multiple PRs by file.** If story A adds a parser nothing calls yet, story B adds a repository nothing calls yet, story C adds a service nothing calls yet, and story D finally wires them into a working endpoint — that's one PR, not four. The test: would a reviewer of the first PR in that sequence be looking at dead code with no way to exercise it end-to-end? If yes, it's split wrong. Combine until each PR is something you can actually run and hit with a real request/command.
- **Bundle small, independent, non-interacting additions.** Cross-cutting stories that each touch the same small set of files but don't depend on each other (e.g. CORS + health check + logging, all small additions to the same `Program.cs`) can be one PR rather than three.
- **Bundle stories that share test infrastructure.** If two test stories need the same fixtures/setup, write that setup once and put both test files in one PR — splitting them means either duplicating the setup or building shared infra in the first PR purely for the second to use.
- Each resulting PR should be independently buildable and, where the epic has running code by that point, independently runnable/verifiable — not just "compiles."

## 1. For each PR group, in dependency order

Work through the groups in the order the epic's stories depend on each other (stories.md usually states this explicitly per story). For each group:

### a. Branch, stacked

```
git checkout -b <branch-name>
```
branched off the **previous group's branch** (stacked), or off the epic's base branch for the first group in the epic. Use this repo's existing naming convention: `story/<id-or-range>-<short-slug>` (check `git branch -a --list 'story/*'` or recent merged PRs for examples).

### b. Implement — fresh subagent

Spawn a new subagent (not reused from a prior group) with a **fully self-contained prompt**. It has no memory of this conversation, so include:

- **An explicit instruction to skip plan mode**: subagents proactively invoke their own planning/approval flow for anything multi-step, exactly like the top-level agent does. Open the prompt with something like: *"Execute directly — do not enter plan mode or ask for approval, this task is already fully specified below and pre-authorized. If you find yourself wanting to write a plan file or use an EnterPlanMode-style tool, skip that and just do the work."* Without this line, the agent will stop and wait for an approval that can't reach it.
- The exact branch name it's already on and what it's stacked on.
- Pointers to the specific stories.md story numbers and doc sections to read in full (don't paste the whole story text if a file+section pointer is enough — but DO paste anything you already worked out that the agent would otherwise have to re-derive, e.g. resolved decisions from an earlier PR in the stack, exact config key names, exact SQL, exact reasoning for a non-obvious choice).
- **Existing conventions to follow, named explicitly** — if a sibling project/file already establishes a pattern (a connection-string-resolution approach, a DI registration style, a test fixture pattern), point at the exact file and tell the agent to match it rather than invent its own. Re-deriving a convention that already exists elsewhere in the repo is wasted effort and a consistency risk.
- **A "verify your own work" section with real commands**, not just "make sure it builds." Builds lie; running the thing doesn't. Include actual `curl`/`docker`/`dotnet test`/etc. invocations and what output to expect. Real bugs get caught here, before the verify agent ever runs.
- **An explicit "what NOT to do" scope boundary** — name the specific files/concerns that belong to a later PR group, so the agent doesn't quietly absorb the next group's work or wander into unrelated files.
- **Instruction to commit only** (one commit, descriptive message) — no push, no PR. The orchestrator handles that after verification.
- Ask it to report back concretely: what it created, real command output (not paraphrased), and `git show --stat HEAD`.

### c. Verify — different fresh subagent

Spawn a **second, separate** new subagent (never the implement agent) to review the commit adversarially. Tell it explicitly: *"You did NOT write this commit — review it fresh and skeptically."* Its prompt should include:

- The same "skip plan mode, execute directly" line as the implement agent.
- The commit/branch to review, and the story numbers + acceptance criteria to check it against, one by one.
- **Instruction to re-run everything itself** — build, tests, and any live checks the implement agent claimed passed. Never take the implement agent's report as ground truth; independently reproduce it. If the implement agent reported fixing some upstream bug or working around a limitation, verify that claim directly too (reproduce the failure it describes, confirm the fix actually addresses it) rather than accepting the explanation at face value.
- **A minor-vs-real split**: small things (typos, a missed config value, an inconsistent doc cross-reference) get fixed directly, in place, with a note of what changed. Anything that changes behavior, reveals an unmet acceptance criterion, or requires judgment gets reported, not silently patched — send it back to step (d) instead.
- Instruction not to commit its own fixes — leave them staged/unstaged and report what's uncommitted; the orchestrator commits.

### d. Fix, if the verify agent found real issues

Send the specific findings back to the **implement agent from step (b)** (it already has full context of what it built) rather than spawning a new one — resume it with the exact issues and what's needed to address each. Once it reports the fix is committed, resume the **verify agent from step (c)** for a scoped re-check of just those points (not a full re-review). Repeat until clean.

### e. Commit any verify-made minor fixes, push, open the PR

If the verify agent left minor fixes uncommitted, review and commit them yourself. Then:
```
git push -u origin <branch-name>
gh pr create --base <previous-branch-or-epic-base> --head <branch-name> --title "..." --body "..."
```
Base is always the previous group's branch (stacking) — only the first PR in the epic bases on the epic's actual base branch.

**PR description rules:**
- Title and body written for a reader who doesn't know the internal jargon of this codebase — explain what changed and why in plain terms, the way you'd explain it to someone who uses the product but doesn't read the code.
- Structure: what this does, why it's needed now / why split this way, anything notable (a real bug caught and fixed during implementation or verification is worth calling out specifically — it's evidence the review step did something, not just ceremony).
- Note what it's stacked on (link/reference the previous PR).
- End with the standard `🤖 Generated with [Claude Code](https://claude.com/claude-code)` footer.

### f. Move to the next group

Branch the next group off the branch you just pushed, and repeat from (a).

## Notes from doing this the first time (Epic 2)

- The single biggest quality lever was the verify agent actually re-running things live (docker, curl, rebuilding containers from scratch) instead of reading code and trusting the implement agent's report. Several real bugs (a Docker build-context leak, an `appsettings.json` collision, a missing `curl` breaking a healthcheck, a config value baked into an image instead of env-driven) were only caught this way.
- When a verify agent flags something it can't actually resolve (e.g. an acceptance criterion asks for a check that requires tooling the repo doesn't have yet, like a browser/screenshot check with no Playwright set up), don't fake it and don't silently drop the requirement — have the fix pass add an honest, explicit note about what evidence the decision rests on and what wasn't checked, with a pointer to when the missing tooling is expected to land.
- Keep the orchestrator (you) responsible for all git branch/push/PR operations and for reading/relaying between agents — don't have implement or verify agents push or open PRs themselves.
