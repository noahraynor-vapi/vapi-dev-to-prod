## VAPI Resource Migration Script

This repository contains a single Bun/TypeScript script (`migrate.ts`) that copies assistants, their tools, and their structured outputs from one Vapi organization to another. The common workflow is *develop in one org, then sync those resources into your production org*.

---

### Prerequisites

1. **Bun runtime** – install once (macOS: `brew install oven-sh/bun/bun`; Ubuntu/Debian: `curl -fsSL https://bun.sh/install | bash`; Windows: `powershell -c "irm bun.sh/install.ps1 | iex"`). Any platform works as long as `bun --version` succeeds.
2. **API keys**
   - `FROM_VAPI_API_KEY` – source organization (typically development).
   - `TO_VAPI_API_KEY` – destination organization (typically production).

---

### How the Script Works

1. Fetch the assistant from the source org (`/assistant/:id`).
2. Extract dependent resource IDs:
   - Tools (both `model.toolIds` and hook actions).
   - Structured outputs (`artifactPlan.structuredOutputIds` plus legacy schema IDs).
3. For each dependency, fetch it from the source org and **create or update** it in the destination org.
4. Remap all references in the assistant payload to the destination IDs.
5. Create or update the assistant in the destination org with the remapped payload.

Everything runs in a single process – no server to start.

---

### The Mapping File (`.migration-mapping.json`)

Every run records ID translations in a JSON file (default: `.migration-mapping.json`):

```json
{
  "assistants": {
    "source-assistant-id": "dest-assistant-id"
  },
  "tools": {
    "source-tool-id": "dest-tool-id"
  },
  "structuredOutputs": {
    "source-structured-output-id": "dest-structured-output-id"
  }
}
```

- **Purpose:** acts as the script’s “memory” so subsequent runs update existing resources instead of creating duplicates.
- **Not a live state file:** deleting a tool/assistant/structured output in either org does **not** remove it from the mapping file. That’s intentional; the mapping ensures future runs still know which destination ID corresponds to a given source ID. If you remove the mapping entry, the next run will recreate that resource from scratch.

---

### Usage

- **macOS / Linux (including Ubuntu)**
  ```bash
  FROM_VAPI_API_KEY=dev_key TO_VAPI_API_KEY=prod_key bun run migrate.ts <assistant-id>
  ```

- **Windows (PowerShell)**
  ```powershell
  $Env:FROM_VAPI_API_KEY="dev_key"; $Env:TO_VAPI_API_KEY="prod_key"; bun run migrate.ts <assistant-id>
  ```

- `<assistant-id>` must be the ID from the source (development) org.
- The script outputs progress for each dependency: create vs update, API errors, etc.
- On success, the mapping file is updated with any new ID translations.
- On failure, the mapping file is still saved so you don’t lose the work that completed.

---

### Suggested Development → Production Workflow

1. **Build/test in the development org** using the Vapi dashboard.
2. **Run the migration script** with the development assistant ID and production API key.
3. **Review in production** (tools page, assistant viewer) to confirm the new IDs and metadata appear.
4. **Iterate:** whenever you change the assistant, its tools, or its structured outputs in development, rerun the script. Existing resources are patched; new ones are added.
5. **Clean slate (if needed):** Delete the destination resources manually *before* migrating if you truly want fresh IDs, or delete the mapping file to force recreation.

This gives you a reliable “one-way sync” from development to production without manual copy/paste.

---

### Updating vs. Adding Resources

- **Add**: Create a brand-new tool or structured output in development, then rerun the script. It will create the resource in production and append the mapping.
- **Update**: Modify an existing resource in development (tools, hooks, structured outputs, assistant config). On the next run, the script recognizes the mapping and issues `PATCH` requests so production matches development.
- **Removal**: If you remove a tool or structured output reference from the assistant in development, rerunning the script removes that reference in production as well. The actual tool/resource remains in production for other assistants unless you delete it manually.

---

### Troubleshooting Tips

- **Missing API key errors** – ensure `FROM_VAPI_API_KEY` and `TO_VAPI_API_KEY` are exported in the shell where you run the script.
- **Multiple environments simultaneously** – use different browser profiles or incognito windows for dev vs prod to avoid org switching side effects.

---


