/**
 * Test-only provider: a scripted model, so a real `pi` process can be driven
 * with no network.
 *
 * A fixture, not a test: `tests/subagent-wait-wake-e2e.test.ts` copies this file
 * into the temp agentDir's `extensions/` and every process in the chain loads
 * it from there.
 *
 * The script and its log come from the environment:
 *
 *   PI_FAUX_SCRIPT = JSON array of steps; { "text": "..." } or { "call": "tool", "args": {...} }
 *   PI_FAUX_LOG    = path appended one line per model request
 *
 * One registration serves every process: a spawned child inherits the env and
 * loads this extension from `<agentDir>/extensions`, so each process runs the
 * script from its own first step.
 *
 * The script is keyed by `PI_FAUX_SCRIPT_DEPTH_<n>` when present (n =
 * PI_SUBAGENT_DEPTH), falling back to PI_FAUX_SCRIPT. That lets a subject and
 * its child behave differently in one probe.
 *
 * NOTE on the override point: `fauxProvider()` puts `stream`/`streamSimple` on
 * the provider object and its `api` is a *string* id. Overriding `provider.api`
 * (round 1 did) replaces that id and leaves the original streams registered —
 * the script then never arms. Override `streamSimple` instead.
 */
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { appendFileSync } from "node:fs";

interface Step {
	text?: string;
	call?: string;
	args?: Record<string, unknown>;
}

const PROVIDER = "faux";
const MODEL = "faux-1";

export default function (pi: any) {
	const depth = process.env.PI_SUBAGENT_DEPTH ?? "0";
	const raw = process.env[`PI_FAUX_SCRIPT_DEPTH_${depth}`] ?? process.env.PI_FAUX_SCRIPT;
	if (!raw) throw new Error("faux-provider: PI_FAUX_SCRIPT is unset");
	const steps = JSON.parse(raw) as Step[];
	const logPath = process.env.PI_FAUX_LOG;

	let served = 0;
	const handle = fauxProvider({ provider: PROVIDER, models: [{ id: MODEL, reasoning: false }] });
	const originalStreamSimple = (handle.provider as any).streamSimple;
	const originalStream = (handle.provider as any).stream;

	const arm = (typeofArg: "stream" | "streamSimple") => {
		// Past the end the script repeats its last step, so the step text alone
		// cannot tell a second delivery from the first: a wake-up delivered twice
		// runs the same final step twice. `repeat` and `call` name it.
		const exhausted = served >= steps.length;
		const step = steps[Math.min(served, steps.length - 1)] ?? { text: "" };
		served++;
		if (logPath) {
			try {
				appendFileSync(logPath, `depth=${depth} call=${served} repeat=${exhausted} ${JSON.stringify(step)}\n`);
			} catch { /* best-effort */ }
		}
		const msg = step.call ? fauxAssistantMessage(fauxToolCall(step.call, step.args ?? {})) : fauxAssistantMessage(step.text ?? "");
		handle.setResponses([msg]);
		return typeofArg;
	};

	(handle.provider as any).streamSimple = (model: any, context: any, options: any) => {
		arm("streamSimple");
		return originalStreamSimple.call(handle.provider, model, context, options);
	};
	(handle.provider as any).stream = (model: any, context: any, options: any) => {
		arm("stream");
		return originalStream.call(handle.provider, model, context, options);
	};

	pi.registerProvider(handle.provider);
}
