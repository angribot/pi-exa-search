import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  keyHint,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const EXA_SEARCH_TOOL = "web_search_exa";
const EXA_FETCH_TOOL = "web_fetch_exa";
const REQUEST_TIMEOUT_MS = 65_000;

type ExaTool = typeof EXA_SEARCH_TOOL | typeof EXA_FETCH_TOOL;

let anonymousExaQueue = Promise.resolve();
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
    } catch {
      continue;
    }
  }
  throw new Error("Exa MCP returned an invalid response");
}

function validateWebUrl(rawUrl: string): string {
  const url = URL.parse(rawUrl);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new Error("web_fetch_exa requires a valid HTTP(S) URL");
  }
  if (url.username || url.password) {
    throw new Error("web_fetch_exa does not accept URLs with embedded credentials");
  }
  return url.href;
}

function sourceHost(url: string): string {
  return URL.parse(url)?.hostname.replace(/^www\./, "") || url;
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
    const response = await fetch(EXA_MCP_URL, {
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
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

    if (message.error?.message || message.result?.isError) {
      throw new Error(message.error?.message ?? (text || "Exa MCP tool failed"));
    }
    if (!text) throw new Error("Exa MCP returned no content");

    return text;
  };

  if (apiKey) return request();

  const result = anonymousExaQueue.then(request);
  anonymousExaQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function truncateOutput(text: string): Promise<string> {
  const output = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!output.truncated) return output.content;

  const outputDir = await mkdtemp(join(tmpdir(), "pi-exa-"));
  const outputPath = join(outputDir, "output.md");
  await writeFile(outputPath, text, "utf8");
  return (
    `${output.content}\n\n[Output truncated: showing ${output.outputLines} of ${output.totalLines} lines ` +
    `(${formatSize(output.outputBytes)} of ${formatSize(output.totalBytes)}). ` +
    `Full output saved to: ${outputPath}]`
  );
}

export default function registerExaTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: EXA_SEARCH_TOOL,
    label: "Exa Search",
    description: `Search the web for any topic and get clean, ready-to-use content.

Best for: Finding current information, news, facts, people, companies, or answering questions about any topic.
Returns: Clean text content from top search results.

Query tips:
describe the ideal page, not keywords. "blog post comparing React and Vue performance" not "React vs Vue".
Use category:people / category:company to search through Linkedin profiles / companies respectively.
Treat returned highlights as sufficient when they answer the question. Avoid equivalent searches.
When full text is needed, collect all relevant URLs first and make one web_fetch_exa call. Do not fetch results one at a time.`,
    parameters: Type.Object(
      {
        query: Type.String({
          minLength: 1,
          description:
            "Natural language search query. Should be a semantically rich description of the ideal page, not just keywords. Optionally include category:<type> (company, people) to focus results — e.g. 'category:people John Doe software engineer'.",
        }),
        numResults: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 100,
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
      const text = await callExa(EXA_SEARCH_TOOL, { query, numResults: params.numResults }, signal);
      return { content: [{ type: "text", text: await truncateOutput(text) }], details: undefined };
    },
    renderCall(args, theme) {
      const query = args.query.replace(/\s+/g, " ").trim();
      const count = args.numResults === undefined ? "" : theme.fg("dim", ` (${args.numResults})`);
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

      const resultCount = (text.match(/^Title:\s+/gm) ?? []).length;
      const status = resultCount ? `${resultCount} results` : text.split("\n", 1)[0] || "Search complete";
      return new Text(
        `${theme.fg("success", status)}\n${theme.fg("dim", `${text.length.toLocaleString()} chars | ${text.split("\n").length.toLocaleString()} lines | ${keyHint("app.tools.expand", "to expand")}`)}`,
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: EXA_FETCH_TOOL,
    label: "Exa Fetch",
    description: `Read a webpage's full content as clean markdown. Use after web_search_exa when highlights are insufficient or to read any known URL.

Best for: Extracting full content from known URLs.
Do not search for a URL the user already provided. Do not fetch pages whose search highlights already answer the question.
Before calling, collect every URL needed for the current step and send them together. Do not make one call per URL.
Call again only for newly discovered URLs, failed pages, or when the previous extraction was insufficient.
Returns: Clean markdown content and metadata from the page(s).`,
    parameters: Type.Object(
      {
        urls: Type.Array(
          Type.String({ minLength: 1 }),
          {
            minItems: 1,
            description:
              "URLs to read. Collect all URLs needed for the current step and batch them in one call.",
          },
        ),
        maxCharacters: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 50_000,
            description: "Maximum characters to extract per page (default: 3000)",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, signal) {
      const text = await callExa(
        EXA_FETCH_TOOL,
        { urls: [...new Set(params.urls.map(validateWebUrl))], maxCharacters: params.maxCharacters },
        signal,
      );
      return { content: [{ type: "text", text: await truncateOutput(text) }], details: undefined };
    },
    renderResult(result, { expanded }, theme, context) {
      const text = getText(result.content);
      if (context.isError) return new Text(theme.fg("error", text || "Exa fetch failed"), 0, 0);
      if (expanded) return new Text(theme.fg("toolOutput", text), 0, 0);

      const fetchedUrls = [...text.matchAll(/^URL:\s+(\S+)/gm)].map((match) => match[1] ?? "");
      const requestedUrls = Array.isArray(context.args.urls) ? context.args.urls : [];
      const urls = fetchedUrls.length ? fetchedUrls : requestedUrls;
      const pageCount = Math.max((text.match(/^#\s+/gm) ?? []).length, urls.length, 1);
      const title =
        pageCount === 1 ? text.match(/^#\s+(.+)$/m)?.[1] ?? "Page fetched" : `${pageCount} pages fetched`;
      const sources = [...new Set(urls.map(sourceHost))];
      const hidden = Math.max(sources.length - 3, 0);
      const source = sources.slice(0, 3).join(", ") || "Exa";
      const stats = `${source}${hidden ? ` +${hidden} more` : ""} | ${text.length.toLocaleString()} chars | ${text.split("\n").length.toLocaleString()} lines`;
      return new Text(
        `${theme.fg("success", title)}\n${theme.fg("dim", `${stats} | ${keyHint("app.tools.expand", "to expand")}`)}`,
        0,
        0,
      );
    },
  });
}
