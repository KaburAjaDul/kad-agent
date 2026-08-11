# Kickstart New Machine And Repo

## Purpose

Use the orchestration harness repository as the global OpenCode configuration reference and base-project harness for all machines.

Keep shell, zsh, editor, and other dotfile ricing in a separate config ricing repo. The harness repo owns OpenCode harness policy, templates, prompts, and reproducible project behavior.

## New Machine Setup

1. Install OpenCode and confirm it is on `PATH`.

```bash
opencode --version
```

2. Install helper CLIs used by this harness.

```bash
npm install -g ocx
```

3. Install or update the OpenCode plugins used by the harness.

```bash
ocx init
ocx registry add https://registry.kdco.dev --name kdco
ocx add kdco/background-agents kdco/worktree
```

4. Install Cupcake policy tooling using the Cupcake project instructions, then verify this repo's helper can run.

```bash
./.cupcake/helpers/cupcake.sh --help
```

5. Create the global OpenCode config at `~/.config/opencode/opencode.json` from `docs/references/opencode-global-config-reference.jsonc`.

6. Put real secret values in the machine environment or another untracked local secret store, never in this repository.

```bash
export OPENAI_API_KEY="..."
export OBSIDIAN_API_KEY="..."
export OBSIDIAN_BASE_URL="https://127.0.0.1:27124"
export OBSIDIAN_VERIFY_SSL="false"
```

7. From this repository root, verify the project config loads.

```bash
opencode debug config
```

8. Run a model smoke test.

```bash
opencode run --model openai/gpt-5.5 "Reply with EXACTLY: POLICY_SMOKE_OK"
```

## New Repo Bootstrap

1. Copy `docs/references/opencode-project-template.jsonc` into the new repo as `opencode.json`, removing comments if the target parser requires strict JSON.

2. Copy the baseline harness files needed by the new repo.

```text
AGENTS.md
ARCHITECTURE.md
TESTING.md
.opencode/prompts/
.opencode/plugins/
.opencode/plugin/cupcake.js
.cupcake/
docs/design-docs/
docs/references/agent-orchestration-map.md
docs/references/opencode-global-config-reference.jsonc
docs/references/kickstart-new-machine-and-repo.md
```

3. Adjust product-specific architecture docs, but keep the config boundary rule unchanged: repo config owns reproducible harness behavior; global config owns personal preferences and credentials.

4. Keep `opencode-worktree` as the default write isolation path. Normal implementation and review write lanes should use `worktree_create` / `worktree_delete`, not native write-capable `task` subagents.

5. Keep read-only/background work honest. Native `task`, background `delegate`, and worktree lanes all create OpenCode sessions; background delegation is for read-only async work, while worktree is the preferred write-isolation workflow.

6. Run the smoke checks from the new repo root.

```bash
opencode debug config
opencode run --model openai/gpt-5.5 "Reply with EXACTLY: POLICY_SMOKE_OK"
```

## Expected Policy Baseline

- `build`: `openai/gpt-5.5`, `reasoningEffort=medium`
- `research`: `openai/gpt-5.5`, `reasoningEffort=xhigh`
- `scoper`: `openai/gpt-5.5`, `reasoningEffort=xhigh`
- `reviewer`: `openai/gpt-5.5`, `reasoningEffort=xhigh`
- `researcher`: `openai/gpt-5.5`, `reasoningEffort=low`
- `builder`: `openai/gpt-5.5`, `reasoningEffort=low`

## Secret Handling

- Use placeholders such as `${OBSIDIAN_API_KEY}` in committed templates.
- Store actual values in environment variables or untracked machine-local files.
- Do not commit `.env`, provider tokens, Obsidian API keys, sync credentials, or MCP secrets.
