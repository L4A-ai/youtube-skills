# youtube-skills

Agent Skills repo for YouTube. Each directory under `skills/` must remain independently
installable because `npx skills add owner/repo@skill` copies only that skill.

## Layout

```text
skills/youtube-shorts-publish/
├── SKILL.md
├── agents/openai.yaml
├── package.json
├── scripts/                 self-contained zero-dependency Node CLI and tests
└── references/              dated platform/API evidence and setup guidance
skills.sh.json
```

The first release intentionally keeps its runtime inside the only skill. Do not add a root package
or make the skill import files outside its own directory. If a second skill later shares enough
runtime to justify a package and fan-out step, add an explicit sync check like `reddit-skills`.

## Rules

- `plan` and `publish` without `--yes` are strict local dry runs: no OAuth reads, token refresh,
  network access, config directories, or audit writes.
- A real write requires per-invocation `--yes` plus the reviewed `--expected-plan-id`; default
  privacy is `private`; subscriber notifications default to false.
- Each plan ID is one-shot by default. Snapshot reviewed bytes and atomically persist the attempt
  before mutation; never auto-retry an ambiguous operation or add `--new-attempt` without explicit
  user authorization after a Studio check.
- All writes are scoped to the user's own single channel. No multi-account orchestration, proxy
  rotation, quota evasion, or enforcement bypasses.
- Never infer Made for Kids or realistic synthetic-media declarations. Both are explicit inputs.
- Never claim API-confirmed Shorts classification. The API can prove upload, processing, metadata,
  and visibility, not Shorts Feed placement.
- Verify a write by the returned video ID. Do not search by title, auto-delete, or re-upload after an
  ambiguous or still-processing result.
- Platform claims belong in `references/`, with the verification date and official source. Mark
  absence-of-field conclusions as inference.
- Never commit OAuth client JSON, authorization codes, tokens, upload session URLs, operator media,
  or audit/state files.
- stdout stays structured JSON; human progress goes to stderr; secrets belong in neither.

## Validation

Run the root-only report and proof contract checks from the repository root:

```bash
ruby .github/scripts/check-zero-publish-report.rb
ruby .github/scripts/check-zero-publish-proof.rb
```

Then run from the skill directory:

```bash
npm run check
npm test
```

Then run the system skill validator from the repo root when available. CI also installs the skill
through the real skills CLI and exercises the installed copy.

## Publishing

This skill repository is public, like `L4A-ai/reddit-skills`, because skills.sh resolves and
installs it directly from GitHub. Pushing `main` releases the skill. There is no separate submission
API: the skills.sh listing appears from anonymous `npx skills add L4A-ai/youtube-skills` telemetry.

`CLAUDE.md` and `AGENTS.md` here are byte-identical twins. Edit both or neither.
