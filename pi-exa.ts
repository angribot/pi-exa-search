import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { formatSize, keyHint, truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const REQUEST_TIMEOUT_MS = 65_000;

type ExaTool = "web_search_exa" | "web_fetch_exa";

let anonymousExaQueue = Promise.resolve();
const tempDirs = new Set<string>();

type McpResponse = {
  id?: number;
  result?: {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  error?: { message?: string };
};

function parseMcpResponse(body: string): McpResponse {
  const events = body.split(/\r?\n\r?\n/).map((event) =>
    event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n"),
  );

  for (const payload of [body, ...events]) {
    try {
      const message = JSON.parse(payload) as McpResponse;
      if (message.id === 1 && (message.result || message.error)) return message;
    } catch {}
  }
  throw new Error("Exa MCP returned an invalid response");
}

function lenientNumber(value: unknown, min?: number): number | undefined {
  const coerced = Number(value);
  if (!Number.isFinite(coerced)) return undefined;
  if (min !== undefined && coerced < min) return undefined;
  return coerced;
}

function validateWebUrl(rawUrl: string): string {
  const url = URL.parse(rawUrl);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:"))
    throw new Error("web_fetch_exa requires a valid HTTP(S) URL");
  if (url.username || url.password)
    throw new Error("web_fetch_exa does not accept URLs with embedded credentials");
  return url.href;
}

function getText(content: Array<{ type?: string; text?: string }>): string {
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n");
}

function callExa(
  tool: ExaTool,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const apiKey = process.env.EXA_API_KEY?.trim();
  const request = async () => {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await fetch("https://mcp.exa.ai/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...(apiKey ? { "x-api-key": apiKey } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: tool, arguments: args },
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });

    const body = await response.text();
    if (!response.ok) {
      const detail = body.replace(/\s+/g, " ").trim().slice(0, 300);
      const hint = response.status === 429 && !apiKey ? " Set EXA_API_KEY to avoid the shared rate limit." : "";
      throw new Error(
        `Exa MCP request failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}${hint}`,
      );
    }

    const message = parseMcpResponse(body);
    const text = getText(message.result?.content ?? []);

    if (message.error?.message || message.result?.isError)
      throw new Error(message.error?.message || text || "Exa MCP tool failed");
    if (!text) throw new Error("Exa MCP returned no content");

    return text;
  };

  if (apiKey) return request();

  const result = anonymousExaQueue.then(request);
  anonymousExaQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function truncateOutput(text: string): Promise<string> {
  const output = truncateHead(text);
  if (!output.truncated) return output.content;

  const outputDir = await mkdtemp(`${tmpdir()}/pi-exa-`);
  tempDirs.add(outputDir);
  const outputPath = `${outputDir}/output.md`;
  await writeFile(outputPath, text, "utf8");
  return (
    `${output.content}\n\n[Output truncated: showing ${output.outputLines} of ${output.totalLines} lines ` +
    `(${formatSize(output.outputBytes)} of ${formatSize(output.totalBytes)}). ` +
    `Full output saved to: ${outputPath}]`
  );
}

export default function registerExaTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "web_search_exa",
    label: "Exa Search",
    description: `Search the web for any topic and get clean, ready-to-use content.

Best for: Finding current information, news, facts, people, companies, or answering questions about any topic.
Returns: Clean text content from top search results.

Query tips:
describe the ideal page, not keywords. "blog post comparing React and Vue performance" not "React vs Vue".
Use category:people / category:company to search through Linkedin profiles / companies respectively.
If highlights are insufficient, follow up with web_fetch_exa on the best URLs.`,
    promptSnippet: "Find web sources for a query, returning summaries and highlights",
    prepareArguments: (args) => {
      const raw = (args ?? {}) as Record<string, unknown>;
      return { ...raw, numResults: lenientNumber(raw.numResults) } as { query: string; numResults?: number };
    },
    parameters: Type.Object(
      {
        query: Type.String({
          minLength: 1,
          description:
            "Natural language search query. Should be a semantically rich description of the ideal page, not just keywords. Optionally include category:<type> (company, people) to focus results — e.g. 'category:people John Doe software engineer'.",
        }),
        numResults: Type.Optional(
          Type.Number({
            description: "Number of search results to return (default: 10).",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, signal, onUpdate) {
      const query = params.query.trim();
      if (!query) throw new Error("web_search_exa query must not be empty");

      onUpdate?.({ content: [{ type: "text", text: "Searching Exa..." }], details: undefined });
      const text = await callExa("web_search_exa", { query, numResults: params.numResults }, signal);
      return { content: [{ type: "text", text: await truncateOutput(text) }], details: undefined };
    },
    renderCall(args, theme) {
      const query = args.query.replace(/\s+/g, " ").trim();
      const count = args.numResults ? theme.fg("dim", ` (${args.numResults})`) : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("web_search_exa ")) +
          theme.fg("accent", JSON.stringify(query)) +
          count,
        0,
        0,
      );
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Text(theme.fg("warning", "Searching Exa..."), 0, 0);

      const text = getText(result.content);
      if (context.isError) return new Text(theme.fg("error", text || "Exa search failed"), 0, 0);
      if (expanded) return new Text(theme.fg("toolOutput", text), 0, 0);

      return new Text(
        `${theme.fg("success", "Search complete")}\n${theme.fg("dim", `${text.length.toLocaleString()} chars | ${text.split("\n").length.toLocaleString()} lines | ${keyHint("app.tools.expand", "to expand")}`)}`,
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "web_fetch_exa",
    label: "Exa Fetch",
    description: `Read a webpage's full content as clean markdown. Use after web_search_exa when highlights are insufficient or to read any URL.

Best for: Extracting full content from known URLs. Batch multiple URLs in one call.
Returns: Clean text content and metadata from the page(s).`,
    promptSnippet: "Read page content for known URLs as clean markdown",
    prepareArguments: (args) => {
      const raw = (args ?? {}) as Record<string, unknown>;
      return { ...raw, maxCharacters: lenientNumber(raw.maxCharacters, 1) } as { urls: string[]; maxCharacters?: number };
    },
    parameters: Type.Object(
      {
        urls: Type.Array(
          Type.String({ minLength: 1 }),
          {
            minItems: 1,
            description: "URLs to read. Batch multiple URLs in one call.",
          },
        ),
        maxCharacters: Type.Optional(
          Type.Number({
            description: "Maximum characters to extract per page (default: 3000)",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, signal) {
      const text = await callExa(
        "web_fetch_exa",
        { urls: [...new Set(params.urls.map(validateWebUrl))], maxCharacters: params.maxCharacters },
        signal,
      );
      return { content: [{ type: "text", text: await truncateOutput(text) }], details: undefined };
    },
    renderResult(result, { expanded }, theme, context) {
      const text = getText(result.content);
      if (context.isError) return new Text(theme.fg("error", text || "Exa fetch failed"), 0, 0);
      if (expanded) return new Text(theme.fg("toolOutput", text), 0, 0);

      return new Text(
        `${theme.fg("success", "Fetch finished")}\n${theme.fg("dim", `${text.length.toLocaleString()} chars | ${text.split("\n").length.toLocaleString()} lines | ${keyHint("app.tools.expand", "to expand")}`)}`,
        0,
        0,
      );
    },
  });

  pi.on("session_shutdown", async () => {
    const dirs = [...tempDirs];
    tempDirs.clear();
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });
}
