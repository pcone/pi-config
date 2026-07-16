/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

// ── Reviewer metadata ──────────────────────────────────────────────────────
// `reviewerKind` (string | undefined): single-token declaration that this agent
// is a post-implementation reviewer. Recognised values: "implementation"
// (review-code, owns correctness), "tests" (review-tests, owns coverage).
// Any other value is parsed but the runtime emits a warning and treats the
// agent as having no reviewerKind. Set explicitly in frontmatter as
// `reviewer_kind: implementation` or `reviewer_kind: tests`.
//
// `reviewParentRequirements` (string[] | undefined): parsed from comma-separated
// frontmatter `requires_parent_reviewers: review-code,review-tests`. When a
// parent (e.g. implement-flash / implement-pro) declares this list, the harness
// emits a soft prompt to the parent at stop time if any required reviewerKind
// has not yet been spawned from this parent. See the "Reviewer invocation
// guard" section in `decisions/subagents/004-parallel-review-gate.md`.
//
// Frontmatter keys are snake_case (`reviewer_kind`, `requires_parent_reviewers`)
// to keep YAML legible. The TypeScript fields on `AgentConfig` are camelCase
// (`reviewerKind`, `reviewParentRequirements`) to match the existing
// `allowedSubagents` / `excludeTools` convention. We accept both snake_case
// and camelCase YAML keys for forward compatibility.
const RECOGNISED_REVIEWER_KINDS = new Set(["implementation", "tests"]);

export type ReviewerKind = "implementation" | "tests";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
	allowedSubagents?: string[];
	excludeTools?: string[];
	/** Single-token reviewer classification; undefined for non-reviewer agents. */
	reviewerKind?: ReviewerKind;
	/**
	 * Reviewer kinds this agent requires its parent to have spawned before
	 * the parent can stop. Empty/absent means "no gate applies" — used for
	 * scout-code, review-code, review-plan, and other non-implementer agents.
	 */
	reviewParentRequirements?: ReviewerKind[];
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		const allowedSubagents = frontmatter.allowedSubagents
			?.split(",")
			.map((a: string) => a.trim())
			.filter(Boolean);

		const excludeTools = frontmatter.excludeTools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		// Parse `reviewer_kind: implementation | tests` (snake_case YAML key;
		// also accept camelCase `reviewerKind` for forward compatibility).
		// Single token, not a list. Empty / missing → undefined (no reviewerKind).
		// Unknown values warn and fall through to undefined so the agent is not
		// miscategorised.
		let reviewerKind: ReviewerKind | undefined;
		const rawReviewerKind =
			(frontmatter.reviewer_kind as string | undefined)?.trim() ??
			(frontmatter.reviewerKind as string | undefined)?.trim();
		if (rawReviewerKind) {
			if (RECOGNISED_REVIEWER_KINDS.has(rawReviewerKind)) {
				reviewerKind = rawReviewerKind as ReviewerKind;
			} else {
				console.warn(
					`[subagent-async] Agent "${frontmatter.name}" declares unknown reviewer_kind "${rawReviewerKind}". ` +
						`Recognised values: ${[...RECOGNISED_REVIEWER_KINDS].join(", ")}. Treating as no reviewerKind.`,
				);
			}
		}

		// Parse `requires_parent_reviewers: review-code,review-tests` (snake_case
		// YAML key; also accept camelCase `requiresParentReviewers`). The
		// frontmatter uses ReviewerKind tokens directly (already canonical).
		// Empty / missing → undefined (no gate). Unknown values are skipped with
		// a warning so a typo in one agent doesn't break the gate for everyone.
		let reviewParentRequirements: ReviewerKind[] | undefined;
		const rawRequirements =
			(frontmatter.requires_parent_reviewers as string | undefined)?.trim() ??
			(frontmatter.requiresParentReviewers as string | undefined)?.trim();
		if (rawRequirements) {
			const tokens = rawRequirements
				.split(",")
				.map((s: string) => s.trim())
				.filter(Boolean);
			const resolved: ReviewerKind[] = [];
			const unknown: string[] = [];
			for (const token of tokens) {
				if (RECOGNISED_REVIEWER_KINDS.has(token)) {
					resolved.push(token as ReviewerKind);
				} else {
					unknown.push(token);
				}
			}
			if (unknown.length > 0) {
				console.warn(
					`[subagent-async] Agent "${frontmatter.name}" declares unknown reviewer kind(s) ` +
						`in requires_parent_reviewers: ${unknown.join(", ")}. Recognised values: ` +
						`${[...RECOGNISED_REVIEWER_KINDS].join(", ")}. They will be ignored.`,
				);
			}
			reviewParentRequirements = resolved.length > 0 ? resolved : undefined;
		}

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			systemPrompt: body,
			source,
			filePath,
			allowedSubagents: allowedSubagents && allowedSubagents.length > 0 ? allowedSubagents : undefined,
			excludeTools: excludeTools && excludeTools.length > 0 ? excludeTools : undefined,
			reviewerKind,
			reviewParentRequirements,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
