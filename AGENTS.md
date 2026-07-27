## Agent skills

### Issue tracker

Issues and specs are tracked as GitHub issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the five canonical role names as GitHub label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Domain documentation uses a single-context layout. See `docs/agents/domain.md`.

## Project constraints

- Keep Exa MCP tool descriptions aligned with upstream; add model-facing text only when necessary because prompt tokens are a user cost.
- `CONTEXT.md` governs project-authored domain language. Provider text may retain upstream wording; TUI labels and status text need semantic accuracy but need not mirror glossary terms. An `_Avoid_` entry rejects a synonym only within that term's definition.
- Keep the current two-tool extension single-file. Prefer small local duplication over abstractions that add indirection.
