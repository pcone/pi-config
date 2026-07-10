// Adds a `fetch_url` tool the LLM can call.
// Uses curl via pi.exec instead of Node's fetch.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
	"(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const MAX_BODY_CHARS = 200_000;

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "fetch_url",
		label: "Fetch URL",
		description:
			"Fetch a URL with curl. Returns response headers, body, and exit code. " +
			"Use for retrieving web pages, JSON APIs, GitHub content, Hacker News, etc. " +
			"For JSON APIs, set headers for auth (e.g. ['Authorization: Bearer <token>']).",
		parameters: Type.Object({
			url: Type.String({ description: "URL (http/https)." }),
			method: Type.Optional(
				Type.String({ description: "HTTP method (default GET)." })
			),
			headers: Type.Optional(
				Type.Array(Type.String(), {
					description: 'Extra request headers, each as "Name: Value".',
				})
			),
			data: Type.Optional(
				Type.String({ description: "Request body (POST/PUT)." })
			),
			timeout: Type.Optional(
				Type.Number({ description: "Timeout in seconds (default 30)." })
			),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args: string[] = [
				"-sSL",
				"-i",
				"--max-time",
				String(params.timeout ?? 30),
				"-A",
				USER_AGENT,
			];
			if (params.method) args.push("-X", params.method);
			for (const h of params.headers ?? []) args.push("-H", h);
			if (params.data) args.push("--data-raw", params.data);
			args.push(params.url);

			const result = await pi.exec("curl", args, {
				cwd: ctx.cwd,
				signal,
			});

			const body = (result.stdout ?? "").toString();
			const truncated =
				body.length > MAX_BODY_CHARS
					? body.slice(0, MAX_BODY_CHARS) +
						`\n...[truncated at ${MAX_BODY_CHARS} chars]`
					: body;

			const text = [
				`curl exit: ${result.code}`,
				result.stderr?.trim() ? `curl stderr:\n${result.stderr.trim()}` : null,
				"---",
				truncated,
			]
				.filter((x): x is string => x !== null)
				.join("\n");

			return {
				content: [{ type: "text", text }],
				details: { exitCode: result.code, stderr: result.stderr ?? "" },
			};
		},
	});
}
