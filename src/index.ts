#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = "https://givegigs.com";
const CATALOG_URL = `${BASE_URL}/api/ai/tools`;
const MANIFEST_URL = `${BASE_URL}/api/ai/mcp`;
const REQUEST_TIMEOUT_MS = 30_000;
const MANIFEST_TIMEOUT_MS = 6_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const CATALOG_TTL_MS = 5 * 60_000;
const ALLOWED_METHODS = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const HEAVY_SKILL_PATH = fileURLToPath(new URL("../docs/skill-heavy.md", import.meta.url));
const API_KEY = process.env.GIVEGIGS_API_KEY?.trim();

type CatalogTool = { name?: string; skill?: string; endpoints?: string[]; notes?: string };
type Catalog = { authentication?: unknown; tools?: CatalogTool[]; [key: string]: unknown };
type QueryValue = string | number | boolean | string[] | number[] | boolean[];
type McpOperation = {
  id: string;
  method: string;
  path: string;
  group: string;
  skill: string;
  description: string;
  scope: string;
  confirmationRequired: boolean;
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  openWorld: boolean;
};
type McpManifest = { endpointCount: number; operationCount: number; operations: McpOperation[]; [key: string]: unknown };

let catalogCache: { value: Catalog; expiresAt: number } | undefined;
let manifestCache: { value: McpManifest; expiresAt: number } | undefined;
const dynamicTools = new Map<string, RegisteredTool>();
const registeredDynamicResources = new Set<string>();
const registeredDynamicPrompts = new Set<string>();

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<{ response: Response; value: unknown }> {
  const response = await fetch(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: "application/json", ...init.headers },
  });
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("GiveGigs response exceeded the 1 MB safety limit.");
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      size += chunk.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("GiveGigs response exceeded the 1 MB safety limit.");
      }
      chunks.push(chunk);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  let value: unknown;
  try {
    value = text ? JSON.parse(text) : null;
  } catch {
    value = { message: text.slice(0, 20_000), contentType: response.headers.get("content-type") };
  }
  return { response, value };
}

async function getCatalog(force = false): Promise<Catalog> {
  if (!force && catalogCache && catalogCache.expiresAt > Date.now()) return catalogCache.value;
  const { response, value } = await fetchJson(CATALOG_URL);
  if (!response.ok) throw new Error(`GiveGigs tool catalog returned HTTP ${response.status}.`);
  if (!value || typeof value !== "object" || !Array.isArray((value as Catalog).tools)) {
    throw new Error("GiveGigs returned an unexpected tool catalog format.");
  }
  catalogCache = { value: value as Catalog, expiresAt: Date.now() + CATALOG_TTL_MS };
  return catalogCache.value;
}

async function getBundledManifest(): Promise<McpManifest> {
  const filename = fileURLToPath(new URL("../docs/mcp-manifest.json", import.meta.url));
  const value = JSON.parse(await readFile(filename, "utf8")) as McpManifest;
  if (!Array.isArray(value.operations)) throw new Error("Bundled GiveGigs manifest is invalid.");
  return value;
}

async function getMcpManifest(force = false): Promise<McpManifest> {
  if (!force && manifestCache && manifestCache.expiresAt > Date.now()) return manifestCache.value;
  try {
    const { response, value } = await fetchJson(MANIFEST_URL, {}, MANIFEST_TIMEOUT_MS);
    const manifest = value as McpManifest;
    if (!response.ok || !manifest || !Array.isArray(manifest.operations)) throw new Error(`Manifest returned HTTP ${response.status} or an invalid schema.`);
    manifestCache = { value: manifest, expiresAt: Date.now() + CATALOG_TTL_MS };
    return manifest;
  } catch (error) {
    if (manifestCache) return manifestCache.value;
    const bundled = await getBundledManifest();
    manifestCache = { value: bundled, expiresAt: Date.now() + 60_000 };
    console.error("Using bundled GiveGigs endpoint manifest:", error instanceof Error ? error.message : String(error));
    return bundled;
  }
}

function normalizePath(pathInput: string): string {
  if (!pathInput.startsWith("/") || pathInput.startsWith("//") || pathInput.includes("\\")) {
    throw new Error("path must be an absolute GiveGigs API path beginning with one slash.");
  }
  if (pathInput.includes("?") || pathInput.includes("#") || pathInput.includes("%")) {
    throw new Error("Put query values in the query argument; path cannot contain a query, fragment, or percent-encoded segment.");
  }
  const segments = pathInput.slice(1).split("/");
  if (segments.some((part) => !part || part === "." || part === ".." || !/^[A-Za-z0-9._~-]+$/.test(part))) {
    throw new Error("path contains an invalid or empty segment.");
  }
  if (!pathInput.startsWith("/api/")) throw new Error("Only GiveGigs /api/ endpoints can be called.");
  return pathInput;
}

function routeMatches(template: string, requestedPath: string): boolean {
  const cleanTemplate = template.split("?")[0] ?? template;
  const templateParts = cleanTemplate.split("/").filter(Boolean);
  const requestParts = requestedPath.split("/").filter(Boolean);
  if (templateParts.length !== requestParts.length) return false;
  return templateParts.every((part, index) => {
    if (part.startsWith("{") && part.endsWith("}")) return Boolean(requestParts[index]);
    return part === requestParts[index];
  });
}

async function assertCataloguedPath(pathname: string): Promise<void> {
  const catalog = await getCatalog();
  const matches = catalog.tools?.some((entry) => entry.endpoints?.some((endpoint) => routeMatches(endpoint, pathname)));
  if (!matches) {
    throw new Error("That path is not in the live GiveGigs AI tool catalog. Discover the catalog or load the relevant guide first.");
  }
}

async function assertSupportedOperation(method: string, pathname: string): Promise<void> {
  const manifest = await getMcpManifest();
  if (!manifest.operations.some((operation) => operation.method === method && routeMatches(operation.path, pathname))) {
    throw new Error(`${method} ${pathname} is not an operation in the GiveGigs MCP manifest.`);
  }
}

function rejectCredentialQuery(query: Record<string, QueryValue> | undefined): void {
  for (const key of Object.keys(query ?? {})) {
    if (/(?:api.?key|token|secret|password|credential|authorization)/i.test(key)) {
      throw new Error("Credentials and secrets are not allowed in query parameters.");
    }
  }
}

function responseContent(title: string, payload: unknown, isError = false) {
  return {
    isError,
    content: [{ type: "text" as const, text: `${title}\n${jsonText(payload)}` }],
    structuredContent: { title, data: payload },
  };
}

async function executeApiRequest(method: string, rawPath: string, query: Record<string, QueryValue> | undefined, body: unknown) {
  if (!ALLOWED_METHODS.has(method)) throw new Error("That HTTP method is not supported by the GiveGigs MCP server.");
  const pathname = normalizePath(rawPath);
  rejectCredentialQuery(query);
  await assertCataloguedPath(pathname);
  await assertSupportedOperation(method, pathname);
  if (READ_METHODS.has(method) && body !== undefined) throw new Error(`${method} requests cannot include a JSON body.`);
  if (!READ_METHODS.has(method) && !API_KEY) {
    throw new Error("This request needs a GiveGigs API key. Set GIVEGIGS_API_KEY in the MCP host environment; do not send it in chat or as an argument.");
  }
  const url = new URL(pathname, BASE_URL);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, String(item)));
    else url.searchParams.set(key, String(value));
  }
  if (url.origin !== BASE_URL) throw new Error("Request target must remain on givegigs.com.");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;
  let requestBody: string | undefined;
  if (body !== undefined) {
    requestBody = JSON.stringify(body);
    if (Buffer.byteLength(requestBody, "utf8") > MAX_RESPONSE_BYTES) throw new Error("JSON request body exceeded the 1 MB safety limit.");
    headers["Content-Type"] = "application/json";
  }
  const { response, value } = await fetchJson(url.toString(), { method, headers, body: requestBody });
  return responseContent(`GiveGigs ${method} ${pathname} — HTTP ${response.status}`, value, !response.ok);
}

function getPathParameters(template: string): string[] {
  return [...template.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]).filter((value): value is string => Boolean(value));
}

function resolveOperationPath(operation: McpOperation, args: Record<string, unknown>, params: string[]): string {
  let pathname = operation.path;
  for (const name of params) {
    const value = args[name];
    if (typeof value !== "string" || !/^[A-Za-z0-9._~-]{1,200}$/.test(value)) {
      throw new Error(`Path parameter ${name} must be 1–200 URL-safe characters.`);
    }
    pathname = pathname.replace(`{${name}}`, encodeURIComponent(value));
  }
  return normalizePath(pathname);
}

function safeToolName(name: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(name)) throw new Error(`Invalid tool name in GiveGigs manifest: ${name}`);
  return name;
}

function registerEndpointTools(manifest: McpManifest): void {
  for (const tool of dynamicTools.values()) tool.remove();
  dynamicTools.clear();
  const nextIds = new Set<string>();
  for (const operation of manifest.operations) {
    if (!operation.id || !operation.path || !operation.skill || !operation.method) continue;
    if (!ALLOWED_METHODS.has(operation.method)) continue;
    if (["/api/admin", "/api/mod", "/api/moderator", "/api/internal", "/api/cron"].some((prefix) => operation.path === prefix || operation.path.startsWith(`${prefix}/`))) continue;
    const name = safeToolName(operation.id);
    nextIds.add(name);
    const pathParams = getPathParameters(operation.path);
    const inputSchema: Record<string, z.ZodTypeAny> = Object.fromEntries(
      pathParams.map((parameter) => [parameter, z.string().min(1).max(200).describe(`URL-safe value for {${parameter}} in ${operation.path}.`)]),
    );
    inputSchema.query = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))])).optional().describe("Query values allowed by the endpoint guide; secrets and credentials are rejected.");
    if (!READ_METHODS.has(operation.method)) {
      inputSchema.body = z.unknown().optional().describe(`JSON request body specified by ${operation.skill}. A write requires explicit human review and approval.`);
    }
    const title = `${operation.method} ${operation.path}`;
    const write = !READ_METHODS.has(operation.method);
    const registered = server.registerTool(
      name,
      {
        title,
        description: `${operation.description}${write ? " Review the exact path, query, and body with the user and obtain explicit approval before calling; this may publish, contact someone, spend mM, or change owned data." : " Uses the caller's read scope and the documented endpoint contract."}`,
        inputSchema,
        annotations: {
          readOnlyHint: !write,
          destructiveHint: operation.destructive,
          idempotentHint: operation.idempotent,
          openWorldHint: operation.openWorld,
        },
      },
      async (args) => {
        try {
          const path = resolveOperationPath(operation, args as Record<string, unknown>, pathParams);
          return await executeApiRequest(operation.method, path, args.query as Record<string, QueryValue> | undefined, args.body);
        } catch (error) {
          return responseContent(`${title} failed`, { error: error instanceof Error ? error.message : String(error) }, true);
        }
      },
    );
    dynamicTools.set(name, registered);
  }
  for (const [name, tool] of dynamicTools) {
    if (!nextIds.has(name)) {
      tool.remove();
      dynamicTools.delete(name);
    }
  }
  if (server.isConnected()) server.sendToolListChanged();
}

function registerGuideResources(manifest: McpManifest): void {
  const skills = new Set(manifest.operations.map((operation) => operation.skill).filter((skill) => /^\/skill-[a-z0-9-]+\.md$/.test(skill)));
  for (const skill of skills) {
    const slug = skill.replace(/^\/skill-/, "").replace(/\.md$/, "");
    const resourceName = `givegigs-skill-${slug}`;
    if (registeredDynamicResources.has(resourceName)) continue;
    server.registerResource(resourceName, `givegigs://skill/${slug}`, {
      title: `GiveGigs ${slug} skill`,
      description: `Focused current GiveGigs guide ${skill}; use it for API parameters, quotas, privacy and workflow limits.`,
      mimeType: "text/markdown",
    }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: await readFocusedSkill(slug) }] }));
    registeredDynamicResources.add(resourceName);
  }
}

function registerDomainPrompts(manifest: McpManifest): void {
  const groups = new Map<string, { group: string; skill: string }>();
  for (const operation of manifest.operations) groups.set(operation.group, { group: operation.group, skill: operation.skill });
  for (const [group, details] of groups) {
    const slug = group.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 52);
    const name = `givegigs-${slug}-workflow`;
    if (registeredDynamicPrompts.has(name)) continue;
    server.registerPrompt(name, {
      title: `${details.group} workflow`,
      description: `Plan or perform a user-requested GiveGigs ${details.group} workflow using its focused guide and approved API operations.`,
      argsSchema: {
        goal: z.string().min(1).describe("The outcome the user wants"),
        constraints: z.string().optional().describe("Relevant budget, timing, privacy, ownership, location, and other constraints"),
      },
    }, ({ goal, constraints }) => ({
      description: `${details.group} workflow`,
      messages: [{ role: "user", content: { type: "text", text: `Read ${details.skill} and discover the live GiveGigs catalog. Help with this ${details.group} goal: ${goal}.${constraints ? ` Constraints: ${constraints}.` : ""} Use only catalogued operations, ground claims in tool results, respect quota and ownership rules, and show the exact operation for human review before any write.` } }],
    }));
    registeredDynamicPrompts.add(name);
  }
}

async function readHeavySkill(): Promise<string> {
  const guide = await readFile(HEAVY_SKILL_PATH, "utf8");
  return `# MCP integration status\n\nThis repository provides the public GiveGigs MCP server. The historical "MCP Integration (Under Development)" and "Use REST API only" statements inside the preserved API appendix describe the older experimental integration and are superseded for clients connected to this server. For available operations, use this server's live catalog and the current focused guides.\n\n---\n\n${guide}`;
}

async function readFocusedSkill(slug: string): Promise<string> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error("Provide a guide slug such as workers, tasks, or micromoney.");
  if (slug === "mcp") return readFile(fileURLToPath(new URL("../docs/mcp-guide.md", import.meta.url)), "utf8");
  const filename = slug === "heavy" ? "skill-heavy.md" : `skill-${slug}.md`;
  if (filename === "skill-heavy.md") return readHeavySkill();
  const response = await fetch(`${BASE_URL}/${filename}`, {
    headers: { Accept: "text/markdown, text/plain;q=0.9" },
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Focused guide ${filename} returned HTTP ${response.status}.`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("Guide exceeded the 1 MB safety limit.");
  return text;
}

const server = new McpServer({ name: "givegigs", version: "1.0.0" });

server.registerTool(
  "givegigs_discover",
  {
    title: "Discover GiveGigs capabilities",
    description: "Fetch the live public GiveGigs AI tool catalog. It lists current domains, documented endpoint paths, skill guides, scopes, and capability notes. Use this before proposing or calling an endpoint.",
    inputSchema: { refresh: z.boolean().optional().describe("Fetch a fresh catalog instead of using the five-minute cache.") },
  },
  async ({ refresh }) => {
    try {
      const [catalog, manifest] = await Promise.all([getCatalog(refresh), getMcpManifest(refresh)]);
      if (refresh) {
        registerEndpointTools(manifest);
        registerGuideResources(manifest);
        registerDomainPrompts(manifest);
      }
      return responseContent("Live GiveGigs API catalog and MCP operation manifest", {
        ...catalog,
        mcpManifest: { path: "/api/ai/mcp", endpointCount: manifest.endpointCount, operationCount: manifest.operationCount },
      });
    } catch (error) {
      return responseContent("Catalog discovery failed", { error: error instanceof Error ? error.message : String(error) }, true);
    }
  },
);

server.registerTool(
  "givegigs_read_skill",
  {
    title: "Read a GiveGigs skill guide",
    description: "Read the bundled complete skill-heavy.md reference or a focused public guide (for example workers, tasks, chat, invoices, projects, calculators, flippers, CRM, wiki, or valley-agent). Load the relevant guide before non-trivial actions.",
    inputSchema: { guide: z.string().describe("Guide slug: heavy for the bundled complete guide, or a focused guide slug such as workers or tasks.") },
  },
  async ({ guide }) => {
    try {
      return { content: [{ type: "text", text: await readFocusedSkill(guide) }] };
    } catch (error) {
      return responseContent("Guide could not be loaded", { error: error instanceof Error ? error.message : String(error) }, true);
    }
  },
);

server.registerTool(
  "givegigs_api_request",
  {
    title: "Call a catalogued GiveGigs API endpoint",
    description: "Make one JSON REST request to a path listed by givegigs_discover. Public GETs work without a key. Authenticated calls use GIVEGIGS_API_KEY from the MCP process environment, sent only in Authorization: Bearer; keys are never accepted in tool arguments or URLs. Use only the caller's documented scopes and endpoint contracts. For any write, show the exact method, path, query, and body to the user and obtain their explicit approval before invoking this tool. This server cannot replace the host's user-approval controls. API calls can contact people, publish, or change account data. Never retry a failed write until its outcome is understood.",
    inputSchema: {
      method: z.enum(["GET", "HEAD", "OPTIONS", "POST", "PATCH", "PUT", "DELETE"]).describe("HTTP method documented for the selected API operation."),
      path: z.string().describe("Catalogued GiveGigs API path, e.g. /api/ai/workers or /api/ai/tasks/task-id. Do not include query strings."),
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))])).optional().describe("URL query parameters. Never include credentials, tokens, or secrets."),
      body: z.unknown().optional().describe("JSON request body as specified by the live catalog and focused guide."),
    },
  },
  async ({ method, path: rawPath, query, body }) => {
    try {
      return await executeApiRequest(method, rawPath, query as Record<string, QueryValue> | undefined, body);
    } catch (error) {
      return responseContent("GiveGigs API request failed", { error: error instanceof Error ? error.message : String(error) }, true);
    }
  },
);

server.registerTool(
  "givegigs_compute_capacity",
  {
    title: "Check GiveGigs compute capacity and quota",
    description: "Read whether a trusted GiveGigs compute worker is reachable, supported task types, runtime and mM tariff ceilings, and the current caller's quota warning. This does not submit work.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    try { return await executeApiRequest("GET", "/api/ai/compute", undefined, undefined); }
    catch (error) { return responseContent("Compute capacity check failed", { error: error instanceof Error ? error.message : String(error) }, true); }
  },
);

server.registerTool(
  "givegigs_submit_compute_job",
  {
    title: "Submit a legal compute job through GiveGigs",
    description: "Submit a bounded task to the GiveGigs-managed compute worker. First check capacity and quota, read skill-compute, classify the task as lawful, show the exact task, JSON input, max runtime and maximum mM reservation to the user, and obtain explicit approval. The required legalUseAcknowledged value must reflect the user's explicit confirmation. Harmful use, secrets and URLs are rejected; the provider key and endpoint are never exposed. This call may consume mM and create an external compute job.",
    inputSchema: {
      idempotencyKey: z.string().uuid().describe("Unique UUID for this submission. Reuse only to safely retrieve the result of this same request."),
      legalUseAcknowledged: z.literal(true).describe("Set true only after the user explicitly confirms this task will be used lawfully."),
      taskType: z.enum(["analysis", "simulation", "transcription", "image-processing", "model-inference", "batch-processing"]),
      task: z.string().min(8).max(2000).describe("Plain-language compute task; no shell/code, secret material, URLs, or prohibited harmful use."),
      input: z.record(z.string(), z.unknown()).optional().describe("JSON input, at most 32 KB. Do not include credentials, private identifiers, or URLs."),
      maxRuntimeSeconds: z.number().int().min(1).max(1800).optional().describe("Maximum runtime; the server applies its lower configured ceiling and calculates mM cost."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (args) => {
    try { return await executeApiRequest("POST", "/api/ai/compute", undefined, { ...args, input: args.input ?? {}, maxRuntimeSeconds: args.maxRuntimeSeconds ?? 300 }); }
    catch (error) { return responseContent("Compute submission failed", { error: error instanceof Error ? error.message : String(error) }, true); }
  },
);

server.registerTool(
  "givegigs_list_compute_jobs",
  {
    title: "List your GiveGigs compute jobs",
    description: "List only the authenticated owner's recent private compute jobs. This is a read operation.",
    inputSchema: { limit: z.number().int().min(1).max(50).optional(), cursor: z.string().optional() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ limit, cursor }) => {
    try { return await executeApiRequest("GET", "/api/ai/compute/jobs", { ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}) }, undefined); }
    catch (error) { return responseContent("Compute job list failed", { error: error instanceof Error ? error.message : String(error) }, true); }
  },
);

server.registerTool(
  "givegigs_compute_job_status",
  {
    title: "Check your GiveGigs compute job",
    description: "Refresh status for one of the authenticated owner's private compute jobs. Poll with backoff; this does not resubmit the job.",
    inputSchema: { jobId: z.string().min(1).max(64) },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ jobId }) => {
    try { return await executeApiRequest("GET", `/api/ai/compute/jobs/${jobId}`, undefined, undefined); }
    catch (error) { return responseContent("Compute job status failed", { error: error instanceof Error ? error.message : String(error) }, true); }
  },
);

server.registerTool(
  "givegigs_cancel_compute_job",
  {
    title: "Cancel your GiveGigs compute job",
    description: "Cancel a queued or running job that belongs to the authenticated owner. Show the exact job ID and obtain explicit user approval before calling. Final mM charges depend on provider execution time.",
    inputSchema: { jobId: z.string().min(1).max(64) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ jobId }) => {
    try { return await executeApiRequest("DELETE", `/api/ai/compute/jobs/${jobId}`, undefined, undefined); }
    catch (error) { return responseContent("Compute cancellation failed", { error: error instanceof Error ? error.message : String(error) }, true); }
  },
);

server.registerResource(
  "complete-agent-guide",
  "givegigs://skill-heavy",
  { title: "Complete GiveGigs agent guide", description: "Bundled complete reference from GiveGigs v7/public/skill-heavy.md. Includes all focused domain skills and the preserved API guide.", mimeType: "text/markdown" },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: await readHeavySkill() }] }),
);

server.registerResource(
  "live-tool-catalog",
  "givegigs://catalog",
  { title: "Live GiveGigs REST tool catalog", description: "Current public machine-readable catalog for supported GiveGigs API endpoint groups.", mimeType: "application/json" },
  async (uri) => {
    const [catalog, manifest] = await Promise.all([getCatalog(true), getMcpManifest(true)]);
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: jsonText({ catalog, manifest }) }] };
  },
);

server.registerResource(
  "mcp-integration-guide",
  "givegigs://mcp",
  { title: "GiveGigs MCP integration guide", description: "Current MCP setup, supported operations, authentication, and approval guidance. Supersedes the historical under-development note in the preserved API appendix.", mimeType: "text/markdown" },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: await readFocusedSkill("mcp") }] }),
);

server.registerPrompt(
  "find-and-hire",
  { title: "Find and hire a GiveGigs worker", description: "Guide a user from worker discovery to a reviewed, direct-contact hiring workflow.", argsSchema: { goal: z.string().describe("Work to be done"), constraints: z.string().optional().describe("Skills, location, rate, timing, availability, or other preferences") } },
  ({ goal, constraints }) => ({ description: "Find a suitable GiveGigs worker", messages: [{ role: "user", content: { type: "text", text: `Read the workers guide and live tool catalog. Search broadly enough to avoid hiding suitable workers. Find and rank candidates for: ${goal}.${constraints ? ` Constraints: ${constraints}.` : ""} Ground every claim in returned profile details, preserve the listed rate type, and provide profile links. Do not contact anyone unless the user reviews and approves the exact message and recipient.` } }] }),
);

server.registerPrompt(
  "post-a-task",
  { title: "Prepare a GiveGigs task", description: "Collect requirements and prepare a task post for human review.", argsSchema: { work: z.string().describe("Task deliverables and scope"), type: z.enum(["CHARITY", "OFF_SITE_PAY"]).describe("Volunteer charity task or direct-pay task"), details: z.string().optional().describe("Location, timing, budget, payment method, contact information, and constraints") } },
  ({ work, type, details }) => ({ description: "Prepare a task post", messages: [{ role: "user", content: { type: "text", text: `Read the tasks guide and live catalog. Prepare (but do not submit) a ${type} task for: ${work}.${details ? ` Details: ${details}.` : ""} Confirm missing required details, especially payment/contact terms for OFF_SITE_PAY and coordinates/country for LOCAL work. Show the exact request body and get explicit user approval before making a write call. Report the task link only after a successful API response.` } }] }),
);

server.registerPrompt(
  "compute-offload",
  {
    title: "Prepare a safe GiveGigs compute job",
    description: "Check remote capacity, estimate the server-reported mM reservation, screen legal use, and prepare a user-reviewed compute submission.",
    argsSchema: {
      task: z.string().min(8).describe("Compute work to perform"),
      taskType: z.enum(["analysis", "simulation", "transcription", "image-processing", "model-inference", "batch-processing"]),
      runtimeSeconds: z.number().int().min(1).max(1800).optional().describe("Requested maximum runtime"),
    },
  },
  ({ task, taskType, runtimeSeconds }) => ({
    description: "Prepare a lawful, quota-aware compute job",
    messages: [{ role: "user", content: { type: "text", text: `Read skill-compute and call givegigs_compute_capacity. Prepare ${taskType} work: ${task}.${runtimeSeconds ? ` Requested runtime ceiling: ${runtimeSeconds} seconds.` : ""} Check legal use, reject credentials/private data/URLs, and show the exact task, input, server-calculated maximum mM reservation, and user approval requirement. Do not call givegigs_submit_compute_job until the user explicitly approves this exact work and confirms lawful use. On submission, use a new idempotency UUID. Poll the returned job ID with backoff; never resubmit uncertain work. If quota is low, point to https://givegigs.com/mm without claiming checkout is available.` } }],
  }),
);

server.registerPrompt(
  "givegigs-capability-review",
  { title: "Check whether GiveGigs supports a workflow", description: "Ground capability claims in the current catalog and complete guide.", argsSchema: { request: z.string().describe("Feature or task to check") } },
  ({ request }) => ({ description: "Review GiveGigs capability", messages: [{ role: "user", content: { type: "text", text: `Check this request against givegigs_discover and the relevant focused guide: ${request}. Separate callable API operations from browser-local or unavailable features. State scope requirements, any AI quota cost disclosed by the guide, and relevant confirmation or privacy constraints. Do not infer an endpoint that is not catalogued.` } }] }),
);

async function main() {
  const bundled = await getBundledManifest();
  manifestCache = { value: bundled, expiresAt: Date.now() + 60_000 };
  registerEndpointTools(bundled);
  registerGuideResources(bundled);
  registerDomainPrompts(bundled);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // MCP stdio reserves stdout for JSON-RPC. Diagnostics belong on stderr only.
  console.error(`GiveGigs MCP server connected with ${bundled.operationCount} endpoint tools.`);
  void getMcpManifest(true).then((live) => {
    registerEndpointTools(live);
    registerGuideResources(live);
    registerDomainPrompts(live);
    console.error(`Refreshed GiveGigs MCP manifest: ${live.endpointCount} endpoints, ${live.operationCount} operations.`);
  }).catch((error: unknown) => {
    console.error("Live manifest refresh failed; bundled endpoint tools remain available:", error);
  });
}

main().catch((error: unknown) => {
  console.error("GiveGigs MCP failed to start:", error);
  process.exitCode = 1;
});
