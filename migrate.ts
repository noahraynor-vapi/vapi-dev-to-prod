import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface MappingFile {
  assistants: Record<string, string>; // sourceId -> destId
  tools: Record<string, string>;
  structuredOutputs: Record<string, string>;
}

interface VapiResource {
  id: string;
  [key: string]: unknown;
}

interface ToolReference {
  type: string;
  toolId?: string;
  [key: string]: unknown;
}

interface HookConfig {
  type: string;
  toolId?: string;
  [key: string]: unknown;
}

interface AssistantConfig {
  id: string;
  name?: string;
  model?: {
    tools?: ToolReference[];
    [key: string]: unknown;
  };
  hooks?: HookConfig[];
  structuredDataPlan?: {
    structuredDataSchemaId?: string;
    [key: string]: unknown;
  };
  artifactPlan?: {
    structuredDataSchemaId?: string;
    structuredOutputIds?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const VAPI_BASE_URL = process.env.VAPI_BASE_URL || "https://api.vapi.ai";
const FROM_API_KEY = process.env.FROM_VAPI_API_KEY;
const TO_API_KEY = process.env.TO_VAPI_API_KEY;

// Keys to exclude when creating/updating resources
// - assistantIds: destination org will re-link via artifactPlan / assistant mapping
// - isServerUrlSecretSet: backend sets this read-only flag automatically
const CREATE_EXCLUDED_KEYS = [
  "id",
  "orgId",
  "createdAt",
  "updatedAt",
  "isDeleted",
  "assistantIds",
  "isServerUrlSecretSet",
];

const UPDATE_EXCLUDED_KEYS: Record<string, string[]> = {
  tools: ["type", ...CREATE_EXCLUDED_KEYS],
  assistants: [...CREATE_EXCLUDED_KEYS],
  structuredOutputs: ["type", "assistantIds", ...CREATE_EXCLUDED_KEYS],
};

// ─────────────────────────────────────────────────────────────────────────────
// Argument Parsing
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(): { assistantId: string; mappingFile: string } {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
VAPI Resource Migration Script

Migrates an assistant and all its dependencies (tools, structured outputs) 
from one organization to another.

Usage:
  bun run migrate.ts <assistant-id> [options]

Options:
  --mapping-file <path>   Path to the mapping JSON file (default: .migration-mapping.json)
  --help, -h              Show this help message

Environment Variables:
  FROM_VAPI_API_KEY       API key for the source organization (required)
  TO_VAPI_API_KEY         API key for the destination organization (required)
  VAPI_BASE_URL           Base URL for VAPI API (default: https://api.vapi.ai)

Example:
  FROM_VAPI_API_KEY=key1 TO_VAPI_API_KEY=key2 bun run migrate.ts abc-123-def
`);
    process.exit(0);
  }

  let assistantId = "";
  let mappingFile = ".migration-mapping.json";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mapping-file" && args[i + 1]) {
      mappingFile = args[i + 1]!;
      i++;
    } else if (args[i] && !args[i]!.startsWith("-")) {
      assistantId = args[i]!;
    }
  }

  if (!assistantId) {
    console.error("❌ Assistant ID is required");
    process.exit(1);
  }

  return { assistantId, mappingFile };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mapping File Management
// ─────────────────────────────────────────────────────────────────────────────

function loadMapping(filePath: string): MappingFile {
  if (existsSync(filePath)) {
    const content = readFileSync(filePath, "utf-8");
    return JSON.parse(content) as MappingFile;
  }
  return {
    assistants: {},
    tools: {},
    structuredOutputs: {},
  };
}

function saveMapping(filePath: string, mapping: MappingFile): void {
  writeFileSync(filePath, JSON.stringify(mapping, null, 2));
  console.log(`💾 Mapping saved to ${filePath}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// VAPI API Client
// ─────────────────────────────────────────────────────────────────────────────

async function vapiGet<T = VapiResource>(
  endpoint: string,
  apiKey: string
): Promise<T> {
  const url = `${VAPI_BASE_URL}${endpoint}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API GET ${endpoint} failed (${response.status}): ${errorText}`);
  }

  return response.json() as Promise<T>;
}

async function vapiPost<T = VapiResource>(
  endpoint: string,
  apiKey: string,
  body: Record<string, unknown>
): Promise<T> {
  const url = `${VAPI_BASE_URL}${endpoint}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API POST ${endpoint} failed (${response.status}): ${errorText}`);
  }

  return response.json() as Promise<T>;
}

async function vapiPatch<T = VapiResource>(
  endpoint: string,
  apiKey: string,
  body: Record<string, unknown>
): Promise<T> {
  const url = `${VAPI_BASE_URL}${endpoint}`;

  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API PATCH ${endpoint} failed (${response.status}): ${errorText}`);
  }

  return response.json() as Promise<T>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Payload Helpers
// ─────────────────────────────────────────────────────────────────────────────

function removeExcludedKeys(
  payload: Record<string, unknown>,
  excludedKeys: string[]
): Record<string, unknown> {
  const filtered = { ...payload };
  for (const key of excludedKeys) {
    delete filtered[key];
  }
  return filtered;
}

function prepareCreatePayload(
  resource: Record<string, unknown>
): Record<string, unknown> {
  return removeExcludedKeys(resource, CREATE_EXCLUDED_KEYS);
}

function prepareUpdatePayload(
  resource: Record<string, unknown>,
  resourceType: string
): Record<string, unknown> {
  const excludedKeys = UPDATE_EXCLUDED_KEYS[resourceType] || CREATE_EXCLUDED_KEYS;
  return removeExcludedKeys(resource, excludedKeys);
}

// ─────────────────────────────────────────────────────────────────────────────
// Resource Extraction
// ─────────────────────────────────────────────────────────────────────────────

function extractToolIds(assistant: AssistantConfig): string[] {
  const toolIds = new Set<string>();

  const addId = (maybeId?: string | null) => {
    if (typeof maybeId === "string" && maybeId.trim() !== "") {
      toolIds.add(maybeId);
    }
  };

  // Legacy assistants stored tool definitions under model.tools
  if (assistant.model?.tools) {
    for (const tool of assistant.model.tools) {
      if (tool.type === "tool") {
        addId(tool.toolId);
      }
    }
  }

  // Modern assistants list tool IDs directly
  if (Array.isArray(assistant.model?.toolIds)) {
    for (const toolId of assistant.model.toolIds) {
      addId(toolId);
    }
  }

  // Legacy hooks used a top-level toolId
  if (assistant.hooks) {
    for (const hook of assistant.hooks) {
      addId(hook.toolId);

      // Modern hooks embed tool actions, capture those IDs too
      if (Array.isArray(hook.do)) {
        for (const action of hook.do) {
          if (action.type === "tool") {
            addId(action.toolId);
          }
        }
      }
    }
  }

  return Array.from(toolIds);
}

function extractStructuredOutputIds(assistant: AssistantConfig): string[] {
  const ids = new Set<string>();

  const addId = (maybeId?: string | null) => {
    if (typeof maybeId === "string" && maybeId.trim() !== "") {
      ids.add(maybeId);
    }
  };

  addId(assistant.structuredDataPlan?.structuredDataSchemaId);
  addId(assistant.artifactPlan?.structuredDataSchemaId);

  if (Array.isArray(assistant.artifactPlan?.structuredOutputIds)) {
    for (const soId of assistant.artifactPlan.structuredOutputIds) {
      addId(soId);
    }
  }

  return Array.from(ids);
}

// ─────────────────────────────────────────────────────────────────────────────
// Migration Logic
// ─────────────────────────────────────────────────────────────────────────────

async function migrateStructuredOutput(
  sourceId: string,
  mapping: MappingFile
): Promise<string> {
  console.log(`\n📋 Migrating Structured Output: ${sourceId}`);

  // Fetch from source
  const sourceResource = await vapiGet<VapiResource>(
    `/structured-output/${sourceId}`,
    FROM_API_KEY!
  );
  console.log(`   📥 Fetched from source: ${sourceResource.name || sourceId}`);

  const existingDestId = mapping.structuredOutputs[sourceId];

  if (existingDestId) {
    // Update existing
    console.log(`   🔄 Updating existing resource: ${existingDestId}`);
    const payload = prepareUpdatePayload(sourceResource, "structuredOutputs");
    await vapiPatch(`/structured-output/${existingDestId}`, TO_API_KEY!, payload);
    console.log(`   ✅ Updated structured output`);
    return existingDestId;
  } else {
    // Create new
    console.log(`   ➕ Creating new resource`);
    const payload = prepareCreatePayload(sourceResource);
    const created = await vapiPost<VapiResource>("/structured-output", TO_API_KEY!, payload);
    mapping.structuredOutputs[sourceId] = created.id;
    console.log(`   ✅ Created structured output: ${created.id}`);
    return created.id;
  }
}

async function migrateTool(
  sourceId: string,
  mapping: MappingFile
): Promise<string> {
  console.log(`\n🔧 Migrating Tool: ${sourceId}`);

  // Fetch from source
  const sourceResource = await vapiGet<VapiResource>(
    `/tool/${sourceId}`,
    FROM_API_KEY!
  );
  console.log(`   📥 Fetched from source: ${sourceResource.name || sourceId}`);

  const existingDestId = mapping.tools[sourceId];

  if (existingDestId) {
    // Update existing
    console.log(`   🔄 Updating existing resource: ${existingDestId}`);
    const payload = prepareUpdatePayload(sourceResource, "tools");
    await vapiPatch(`/tool/${existingDestId}`, TO_API_KEY!, payload);
    console.log(`   ✅ Updated tool`);
    return existingDestId;
  } else {
    // Create new
    console.log(`   ➕ Creating new resource`);
    const payload = prepareCreatePayload(sourceResource);
    const created = await vapiPost<VapiResource>("/tool", TO_API_KEY!, payload);
    mapping.tools[sourceId] = created.id;
    console.log(`   ✅ Created tool: ${created.id}`);
    return created.id;
  }
}

function remapAssistantReferences(
  assistant: AssistantConfig,
  mapping: MappingFile
): AssistantConfig {
  const remapped = JSON.parse(JSON.stringify(assistant)) as AssistantConfig;

  // Remap model.tools (legacy format)
  if (remapped.model?.tools) {
    for (const tool of remapped.model.tools) {
      if (tool.type === "tool" && tool.toolId && mapping.tools[tool.toolId]) {
        tool.toolId = mapping.tools[tool.toolId];
      }
    }
  }

  // Remap model.toolIds (modern format)
  if (Array.isArray(remapped.model?.toolIds)) {
    remapped.model.toolIds = remapped.model.toolIds.map((toolId) => {
      return mapping.tools[toolId] ?? toolId;
    });
  }

  // Remap hooks
  if (remapped.hooks) {
    for (const hook of remapped.hooks) {
      if (hook.toolId && mapping.tools[hook.toolId]) {
        hook.toolId = mapping.tools[hook.toolId];
      }

      if (Array.isArray(hook.do)) {
        hook.do = hook.do.map((action) => {
          if (action.type === "tool" && action.toolId) {
            return {
              ...action,
              toolId: mapping.tools[action.toolId] ?? action.toolId,
            };
          }
          return action;
        });
      }
    }
  }

  // Remap structuredDataPlan
  if (
    remapped.structuredDataPlan?.structuredDataSchemaId &&
    mapping.structuredOutputs[remapped.structuredDataPlan.structuredDataSchemaId]
  ) {
    remapped.structuredDataPlan.structuredDataSchemaId =
      mapping.structuredOutputs[remapped.structuredDataPlan.structuredDataSchemaId];
  }

  // Remap artifactPlan
  if (
    remapped.artifactPlan?.structuredDataSchemaId &&
    mapping.structuredOutputs[remapped.artifactPlan.structuredDataSchemaId]
  ) {
    remapped.artifactPlan.structuredDataSchemaId =
      mapping.structuredOutputs[remapped.artifactPlan.structuredDataSchemaId];
  }

  if (Array.isArray(remapped.artifactPlan?.structuredOutputIds)) {
    // Ensure assistant references the newly migrated structured outputs
    remapped.artifactPlan.structuredOutputIds =
      remapped.artifactPlan.structuredOutputIds.map((id) => {
        return mapping.structuredOutputs[id] ?? id;
      });
  }

  return remapped;
}

async function migrateAssistant(
  sourceId: string,
  mapping: MappingFile
): Promise<string> {
  console.log(`\n🤖 Migrating Assistant: ${sourceId}`);

  // Fetch from source
  const sourceAssistant = await vapiGet<AssistantConfig>(
    `/assistant/${sourceId}`,
    FROM_API_KEY!
  );
  console.log(`   📥 Fetched from source: ${sourceAssistant.name || sourceId}`);

  // Extract dependencies
  const toolIds = extractToolIds(sourceAssistant);
  const structuredOutputIds = extractStructuredOutputIds(sourceAssistant);

  console.log(`   📦 Dependencies found:`);
  console.log(`      - Tools: ${toolIds.length}`);
  console.log(`      - Structured Outputs: ${structuredOutputIds.length}`);

  // Migrate dependencies first
  for (const soId of structuredOutputIds) {
    await migrateStructuredOutput(soId, mapping);
  }

  for (const toolId of toolIds) {
    await migrateTool(toolId, mapping);
  }

  // Remap references in assistant
  const remappedAssistant = remapAssistantReferences(sourceAssistant, mapping);

  const existingDestId = mapping.assistants[sourceId];

  if (existingDestId) {
    // Update existing
    console.log(`\n   🔄 Updating existing assistant: ${existingDestId}`);
    const payload = prepareUpdatePayload(
      remappedAssistant as unknown as Record<string, unknown>,
      "assistants"
    );
    await vapiPatch(`/assistant/${existingDestId}`, TO_API_KEY!, payload);
    console.log(`   ✅ Updated assistant`);
    return existingDestId;
  } else {
    // Create new
    console.log(`\n   ➕ Creating new assistant`);
    const payload = prepareCreatePayload(
      remappedAssistant as unknown as Record<string, unknown>
    );
    const created = await vapiPost<VapiResource>("/assistant", TO_API_KEY!, payload);
    mapping.assistants[sourceId] = created.id;
    console.log(`   ✅ Created assistant: ${created.id}`);
    return created.id;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("   VAPI Resource Migration Tool");
  console.log("═══════════════════════════════════════════════════════════════");

  // Validate environment
  if (!FROM_API_KEY) {
    console.error("❌ FROM_VAPI_API_KEY environment variable is required");
    process.exit(1);
  }

  if (!TO_API_KEY) {
    console.error("❌ TO_VAPI_API_KEY environment variable is required");
    process.exit(1);
  }

  // Parse arguments
  const { assistantId, mappingFile } = parseArgs();
  const mappingPath = join(process.cwd(), mappingFile);

  console.log(`\n📋 Configuration:`);
  console.log(`   Source Assistant: ${assistantId}`);
  console.log(`   Mapping File: ${mappingPath}`);
  console.log(`   API Base URL: ${VAPI_BASE_URL}`);

  // Load mapping
  const mapping = loadMapping(mappingPath);
  console.log(`\n📂 Current mappings loaded:`);
  console.log(`   Assistants: ${Object.keys(mapping.assistants).length}`);
  console.log(`   Tools: ${Object.keys(mapping.tools).length}`);
  console.log(`   Structured Outputs: ${Object.keys(mapping.structuredOutputs).length}`);

  try {
    // Perform migration
    const destAssistantId = await migrateAssistant(assistantId, mapping);

    // Save mapping
    saveMapping(mappingPath, mapping);

    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("   ✅ Migration Complete!");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log(`\n   Source Assistant: ${assistantId}`);
    console.log(`   Destination Assistant: ${destAssistantId}`);
    console.log(`\n   Total migrated resources:`);
    console.log(`   - Assistants: ${Object.keys(mapping.assistants).length}`);
    console.log(`   - Tools: ${Object.keys(mapping.tools).length}`);
    console.log(`   - Structured Outputs: ${Object.keys(mapping.structuredOutputs).length}`);
  } catch (error) {
    // Save mapping even on failure to preserve progress
    saveMapping(mappingPath, mapping);

    console.error("\n❌ Migration failed:", error);
    process.exit(1);
  }
}

main();

