import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CustomEntry, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * pi-recap — a Claude Code-style session recap for pi.
 *
 * Shows a one-line recap of the current session state above the footer
 * (the line between the input editor and the status bar), like this:
 *
 *   ※ recap: Building a pi extension that summarizes sessions, next up: widget rendering
 *
 * The recap is generated from the session goal (first user prompt) plus the
 * most recent rounds of activity, so it stays stable across turns and only
 * changes when the actual session state changes. It is a pure UI element:
 * it never enters the model context.
 *
 * Triggers:
 *   - automatically after `agent_end`, once the session has at least
 *     MIN_TURNS user messages (never twice for the same input key)
 *   - manually at any time via the `/recap` command
 *
 * State survives session switches: the latest recap is persisted as a custom
 * session entry and restored on `/resume` or `/fork`.
 */

const STATE_KEY = "pi-recap";
const WIDGET_KEY = "pi-recap";
const RECAP_PREFIX = "※ recap:";

/** Minimum number of user messages before the recap kicks in. */
const MIN_TURNS = 3;
/** How many most recent user/assistant rounds feed the recap. */
const MAX_ROUNDS = 3;
/** Only attempt an automatic recap update every N agent turns. */
const AUTO_UPDATE_COOLDOWN_TURNS = 3;
/** Word-overlap ratio above which a freshly generated recap is considered
 * unchanged and the displayed one is kept. */
const SIMILARITY_THRESHOLD = 0.7;
/** Truncation limits for the model input (keeps each call ~1-2k tokens). */
const GOAL_MAX_CHARS = 200;
const USER_MAX_CHARS = 200;
const ASSISTANT_MAX_CHARS = 300;

const DEFAULT_MAX_WORDS = 25;

const DEFAULT_RECAP_PROMPT = (maxWords: number) =>
	[
		`The user is returning to the terminal. Recap in under ${maxWords} words, 1-2 plain sentences, no markdown, no headings — just the status line itself.`,
		"Focus on the concrete capability, decision, or result.",
		"End with the single thing up next.",
		"Describe the session from an outside view. Do not address the user, answer their last question, or review the conversation.",
		"Skip root-cause narrative, fix internals, secondary to-dos, and em-dash tangents.",
	].join("\n");

type Settings = {
	recap?: {
		model?: string;
		maxWords?: number;
		placement?: "above" | "below";
		prompts?: {
			recap?: string;
		};
	};
};

type SessionState = {
	recap?: string;
	goal?: string;
	inputKey?: string;
};

type Round = {
	user: string;
	assistant: string;
	tools: string[];
};

/** Outcome of a generateRecap attempt, surfaced to the /recap command. */
type GenerateOutcome =
	| { kind: "generated" }
	| { kind: "busy" }
	| { kind: "skipped"; reason: string };

let currentRecap: string | null = null;
let goalPrompt: string | null = null;
let lastInputKey: string | null = null;
let isGenerating = false;
let agentEndCount = 0;
let lastAutoUpdateAt = -Infinity;

// ---------------------------------------------------------------------------
// Content helpers
// ---------------------------------------------------------------------------

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const item = block as { type?: string; text?: string };
			if (item.type === "text") return item.text ?? "";
			return "";
		})
		.filter(Boolean)
		.join(" ");
}

function extractToolNames(content: unknown): string[] {
	if (!Array.isArray(content)) return [];

	const names: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const item = block as { type?: string; name?: string };
		if (item.type === "toolCall" && typeof item.name === "string") {
			names.push(item.name);
		}
	}
	return names;
}

export function cleanLine(line: string): string {
	return line
		.replace(/^[-•*]\s+/, "") // bullet marker + required space ("-3" stays intact)
		.replace(/^#+\s*/, "") // markdown heading syntax
		.replace(/^\d{1,3}[.)]\s+/, "") // ordered list marker + required space; 1-3 digits so years/decimals survive
		.replace(/^[※*](?:\s*recap\s*[:：]|\s+)/i, "") // "※ recap:" / "※recap:" / "※ " prefix; bare "**" stays intact
		.replace(/^recap\s*[:：]\s*/i, "")
		.replace(/^(?:here(?:'s| is| are)? (?:a |the )?recap[^:：]*[:：]\s*)/i, "") // "Here is a recap...:" preamble
		.replace(/\*\*/g, "")
		.replace(/`/g, "")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/^['"`]+|['"`]+$/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[.?!。！？]+$/, "");
}

export function cleanSingleLine(text: string, fallback = ""): string {
	// Skip preamble lines ("Here is a recap...:") and heading-only lines
	// ("## Recap"), take the first line that still has content after cleaning.
	for (const part of text.split("\n")) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		if (/^#+\s*/.test(trimmed)) continue; // heading-only lines are not recap content
		const cleaned = cleanLine(trimmed);
		if (cleaned) return cleaned;
	}
	return fallback;
}

export function limitWords(text: string, maxWords: number): string {
	const words = text.trim().split(/\s+/).filter(Boolean);
	if (words.length <= maxWords) return text.trim();
	return `${words.slice(0, maxWords).join(" ")}…`;
}

// ---------------------------------------------------------------------------
// Session context extraction
// ---------------------------------------------------------------------------

function buildSessionContext(ctx: ExtensionContext): { goal: string | null; rounds: Round[]; userCount: number } {
	const branch = ctx.sessionManager.getBranch();
	const rounds: Round[] = [];
	let current: Round | null = null;
	let userCount = 0;

	for (const entry of branch) {
		if (entry.type !== "message") continue;
		if (!("content" in entry.message)) continue;
		const role = entry.message.role;
		const content = entry.message.content;

		if (role === "user") {
			const text = extractText(content).trim();
			if (!text) continue;
			userCount++;
			current = { user: text, assistant: "", tools: [] };
			rounds.push(current);
		} else if (role === "assistant" && current) {
			const text = extractText(content).trim();
			if (text) current.assistant = text;
			const tools = extractToolNames(content);
			if (tools.length > 0) current.tools = tools;
		}
	}

	return {
		goal: rounds[0]?.user ?? null,
		rounds: rounds.slice(-MAX_ROUNDS),
		userCount,
	};
}

export function buildInputKey(goal: string, rounds: Round[]): string {
	const last = rounds[rounds.length - 1];
	return [
		goal.slice(0, 80),
		last?.user.slice(0, 80) ?? "",
		last?.assistant.slice(0, 80) ?? "",
	].join("|");
}

function normalizeForCompare(text: string): string {
	return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function similarity(a: string, b: string): number {
	const wordsA = new Set(normalizeForCompare(a).split(" ").filter(Boolean));
	const wordsB = new Set(normalizeForCompare(b).split(" ").filter(Boolean));
	if (wordsA.size === 0 || wordsB.size === 0) return 0;
	let overlap = 0;
	for (const word of wordsA) {
		if (wordsB.has(word)) overlap++;
	}
	// Jaccard: symmetric overall similarity (a shortened recap that drops
	// content scores lower, so it is not suppressed by the gate).
	const union = new Set([...wordsA, ...wordsB]);
	return overlap / union.size;
}

function buildPrompt(goal: string, rounds: Round[], maxWords: number): string {
	const sections: string[] = [
		"<session_goal>",
		"Note: this is the ORIGINAL goal from the start of the session. It may already be completed or superseded. Judge the CURRENT state from <recent_activity> below, not from this goal.",
		goal.slice(0, GOAL_MAX_CHARS),
		"</session_goal>",
		"",
		"<recent_activity>",
	];

	for (const [index, round] of rounds.entries()) {
		const label = `Round ${index + 1}`;
		sections.push(`${label} user: ${round.user.slice(0, USER_MAX_CHARS)}`);
		if (round.tools.length > 0) {
			sections.push(`${label} tools: ${round.tools.join(", ")}`);
		}
		if (round.assistant) {
			sections.push(`${label} assistant: ${round.assistant.slice(0, ASSISTANT_MAX_CHARS)}`);
		}
	}

	sections.push("</recent_activity>");
	sections.push("");
	sections.push("Write the recap now.");
	sections.push("Write the recap in the same language as the user's messages.");

	return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(process.env.HOME ?? "", ".pi", "agent");
}

function readJsonFile(path: string): Record<string, unknown> {
	try {
		if (!existsSync(path)) return {};
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch (error) {
		reportError("settings", `${path}: ${describeError(error)}`);
		return {};
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function mergeSettings(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
	const result = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const current = result[key];
		result[key] = isPlainObject(current) && isPlainObject(value) ? mergeSettings(current, value) : value;
	}
	return result;
}

function getRecapConfig(ctx: ExtensionContext): { model: string | undefined; maxWords: number; prompt: string; placement: "aboveEditor" | "belowEditor" } {
	const globalSettings = readJsonFile(join(getAgentDir(), "settings.json"));
	const projectSettings = readJsonFile(join(ctx.cwd, ".pi", "settings.json"));
	const recap = (mergeSettings(globalSettings, projectSettings) as Settings).recap;

	const configuredMaxWords = recap?.maxWords;
	const maxWords =
		typeof configuredMaxWords === "number" && Number.isFinite(configuredMaxWords) && configuredMaxWords > 0
			? Math.floor(configuredMaxWords)
			: DEFAULT_MAX_WORDS;

	return {
		model: recap?.model?.trim() || undefined,
		maxWords,
		prompt: recap?.prompts?.recap?.trim() || DEFAULT_RECAP_PROMPT(maxWords),
		placement: recap?.placement === "above" ? "aboveEditor" : "belowEditor",
	};
}

// ---------------------------------------------------------------------------
// Model selection & recap generation
// ---------------------------------------------------------------------------

function splitModelRef(modelRef: string): { provider: string; modelId: string } | undefined {
	const separator = modelRef.indexOf("/");
	if (separator <= 0 || separator === modelRef.length - 1) return undefined;
	return {
		provider: modelRef.slice(0, separator).trim(),
		modelId: modelRef.slice(separator + 1).trim(),
	};
}

function pickModel(ctx: ExtensionContext, configuredModel: string | undefined) {
	if (configuredModel) {
		const parsed = splitModelRef(configuredModel);
		let found = parsed && ctx.modelRegistry.find(parsed.provider, parsed.modelId);
		// Bare model id ("deepseek-v4-flash"): resolve against the current
		// session model's provider.
		if (!found && !parsed && ctx.model) {
			found = ctx.modelRegistry.find(ctx.model.provider, configuredModel);
		}
		if (found && ctx.modelRegistry.hasConfiguredAuth(found)) return found;
		reportError("model", `${configuredModel} is not configured, falling back to the session model`);
	}

	if (ctx.model && ctx.modelRegistry.hasConfiguredAuth(ctx.model)) return ctx.model;
	reportError("model", "no usable model for recap generation");
	return undefined;
}

async function generateRecap(pi: ExtensionAPI, ctx: ExtensionContext, force: boolean): Promise<GenerateOutcome> {
	if (isGenerating) return { kind: "busy" };
	if (!ctx.hasUI) return { kind: "skipped", reason: "no UI" };

	const { goal, rounds, userCount } = buildSessionContext(ctx);
	if (!goal || rounds.length === 0) return { kind: "skipped", reason: "no conversation yet" };
	if (!force && userCount < MIN_TURNS) return { kind: "skipped", reason: "fewer than 3 turns" };

	const inputKey = buildInputKey(goal, rounds);
	if (!force && inputKey === lastInputKey) return { kind: "skipped", reason: "input unchanged" };

	const config = getRecapConfig(ctx);
	const model = pickModel(ctx, config.model);
	if (!model) return { kind: "skipped", reason: "no usable model" };

	// Cooldown: only attempt an automatic update every N turns, and only
	// count attempts that actually passed all gates above. Manual (/recap)
	// runs bypass it.
	if (!force) {
		if (agentEndCount - lastAutoUpdateAt < AUTO_UPDATE_COOLDOWN_TURNS) {
			return { kind: "skipped", reason: "cooldown" };
		}
		lastAutoUpdateAt = agentEndCount;
	}

	// After compaction the branch goal may drift to the first post-compaction
	// user message; the persisted goalPrompt is the true original session goal.
	const effectiveGoal = goalPrompt ?? goal;

	isGenerating = true;
	try {
		const response = await ctx.modelRegistry.complete(
			model,
			{
				systemPrompt: config.prompt,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: buildPrompt(effectiveGoal, rounds, config.maxWords) }],
						timestamp: Date.now(),
					},
				],
			},
			{
				maxTokens: 256,
				// Only honored by OpenAI-family adapters (covers deepseek et al.);
				// other adapter families silently ignore it.
				reasoningEffort: "minimal",
				cacheRetention: "none",
				signal: ctx.signal,
			},
		);

		const recap = cleanSingleLine(extractText(response.content));
		if (!recap) return { kind: "skipped", reason: "empty model output" };

		// Similarity gate: if the freshly generated recap says essentially
		// the same thing as the displayed one, keep the displayed text so
		// the line stays visually stable across similar turns.
		if (currentRecap && !force && similarity(currentRecap, recap) >= SIMILARITY_THRESHOLD) {
			lastInputKey = inputKey;
			persistState(pi, { recap: currentRecap, goal: effectiveGoal, inputKey });
			return { kind: "skipped", reason: "similar to displayed recap" };
		}

		currentRecap = limitWords(recap, config.maxWords);
		lastInputKey = inputKey;
		renderWidget(ctx, config.placement);
		persistState(pi, { recap: currentRecap, goal: effectiveGoal, inputKey });
		return { kind: "generated" };
	} catch (error) {
		reportError("recap", error);
		return { kind: "skipped", reason: "generation failed" };
	} finally {
		isGenerating = false;
	}
}

// ---------------------------------------------------------------------------
// UI & persistence
// ---------------------------------------------------------------------------

export function isWideChar(ch: string): boolean {
	const code = ch.codePointAt(0) ?? 0;
	return (
		(code >= 0x1100 && code <= 0x11ff) ||
		(code >= 0x2e80 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe4f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		code === 0x203b // ※ (full-width reference mark in CJK terminals)
	);
}

export function wrapText(text: string, maxWidth: number): string[] {
	const lines: string[] = [];
	let current = "";
	let currentWidth = 0;
	for (const ch of text) {
		const w = isWideChar(ch) ? 2 : 1;
		if (currentWidth + w > maxWidth && current) {
			lines.push(current);
			current = "";
			currentWidth = 0;
		}
		current += ch;
		currentWidth += w;
	}
	if (current) lines.push(current);
	return lines;
}

let widgetRegistered = false;
let widgetPlacement: "aboveEditor" | "belowEditor" | null = null;
let widgetTui: { requestRender(): void } | null = null;

function registerWidget(ctx: ExtensionContext, placement: "aboveEditor" | "belowEditor"): void {
	if (widgetRegistered) {
		// Placement changed mid-session (settings edit without reload):
		// re-register under the new placement.
		if (widgetPlacement !== placement) {
			ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: widgetPlacement ?? placement });
			widgetRegistered = false;
		} else {
			widgetTui?.requestRender();
			return;
		}
	}
	ctx.ui.setWidget(
		WIDGET_KEY,
		(tui, theme) => {
			widgetTui = tui;
			return {
				dispose() {},
				invalidate() {},
				render(width: number): string[] {
					if (!currentRecap) return [];
					const lines = wrapText(`${RECAP_PREFIX} ${currentRecap}`, Math.max(12, width - 1));
					return lines.map((line, index) => {
						if (index === 0) {
							const prefixLen = RECAP_PREFIX.length;
							return (
								theme.fg("dim", line.slice(0, 2)) +
								theme.fg("accent", theme.bold(line.slice(2, prefixLen))) +
								theme.fg("muted", theme.italic(line.slice(prefixLen)))
							);
						}
						return theme.fg("muted", theme.italic(line));
					});
				},
			};
		},
		{ placement },
	);
	widgetRegistered = true;
	widgetPlacement = placement;
}

function renderWidget(ctx: ExtensionContext, placement?: "aboveEditor" | "belowEditor"): void {
	if (!ctx.hasUI) return;
	const effectivePlacement = placement ?? getRecapConfig(ctx).placement;
	registerWidget(ctx, effectivePlacement);
}

function persistState(pi: ExtensionAPI, state: SessionState): void {
	pi.appendEntry(STATE_KEY, state);
}

function getStoredState(ctx: ExtensionContext): SessionState {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "custom" || entry.customType !== STATE_KEY) continue;
		return (entry as CustomEntry<SessionState>).data ?? {};
	}
	return {};
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function reportError(area: string, error: unknown): void {
	const message = describeError(error);
	if (message.includes("This extension ctx is stale")) return;
	console.warn(`[pi-recap] ${area} failed: ${message}`);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const state = getStoredState(ctx);
		currentRecap = state.recap ?? null;
		goalPrompt = state.goal ?? null;
		lastInputKey = state.inputKey ?? null;
		// Module-scoped state is per-session: reset everything so cooldown,
		// turn counting, and widget registration do not leak across
		// new/resume/fork sessions.
		agentEndCount = 0;
		lastAutoUpdateAt = -Infinity;
		widgetRegistered = false;
		widgetPlacement = null;
		widgetTui = null;

		renderWidget(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message?.role !== "user") return;
		if (goalPrompt) return;

		const text = extractText(event.message.content).trim();
		if (text) {
			goalPrompt = text;
			persistState(pi, { recap: currentRecap ?? undefined, goal: goalPrompt, inputKey: lastInputKey ?? undefined });
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		agentEndCount++;
		await generateRecap(pi, ctx, false);
	});

	pi.registerCommand("recap", {
		description: "Generate a session recap now",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			ctx.ui.notify("Generating recap…", "info");
			const outcome = await generateRecap(pi, ctx, true);
			if (outcome.kind === "generated") {
				ctx.ui.notify("Recap updated", "info");
			} else if (outcome.kind === "busy") {
				ctx.ui.notify("A recap is already being generated", "warning");
			} else {
				ctx.ui.notify(`Recap skipped: ${outcome.reason}`, "warning");
			}
		},
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: getRecapConfig(ctx).placement });
		widgetRegistered = false;
		widgetPlacement = null;
		widgetTui = null;
	});
}
