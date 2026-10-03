/**
 * ResearchPanel - interactive Perplexity research TUI.
 *
 * A full-screen custom component (via ctx.ui.custom) that lets you run a
 * back-and-forth research session against the Perplexity API *outside* your
 * main pi context window. Queries and streamed answers live only in this
 * component's memory; nothing enters the session until you build a recap.
 *
 * The layout mirrors the bordered, composable style used by pi's own
 * selectors: an accent top border carrying the
 * title/model/status, a scrollable transcript body, a bottom border with a
 * scroll indicator, an input line, and a dim help line.
 *
 * Rendered transcript lines are cached (keyed by content version + width) so
 * scrolling and typing in the input box are instant instead of re-running the
 * Markdown renderer on every frame.
 *
 * Keys:
 *   Enter        send query (streamed answer appended to transcript)
 *   Ctrl+R       build recap from transcript (closes panel)
 *   Ctrl+N       deliberate new session (idle/error only): clears the panel
 *                transcript/render/source state, keeps the current input text
 *   Up / Down    scroll transcript (instant; auto-tails while streaming)
 *   Esc          cancel a running search, or close the panel when idle
 *
 * Queries are preflighted locally (exact shared request validation) before
 * anything is committed: a rejected query is never added to the transcript and
 * stays editable in the input. If accepted history alone already exhausts the
 * provider replay budget, the panel says so explicitly and offers Ctrl+R recap
 * or Ctrl+N new session; it never truncates or silently remaps history.
 */

import { type Theme, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Input,
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import { scopeTranscriptCitations, unresolvedCitationMarkers } from "./citations.ts";
import {
	preflightResearchRequest,
	streamPerplexity,
	type PerplexityMessage,
	type PerplexitySource,
	type RequestValidationError,
} from "./perplexity.ts";

export interface TranscriptTurn {
	role: "user" | "assistant";
	text: string;
	citations?: PerplexitySource[];
	responseId?: string;
	unresolvedCitations?: string[];
	/** External provider usage; not fabricated Pi-model accounting. */
	usage?: unknown;
}

export interface ResearchResult {
	recap: true;
	transcript: TranscriptTurn[];
	recapText: string;
}

export interface ResearchPanelDeps {
	/** Instance-local offline fixture seam; production uses the bounded Agent adapter. */
	streamResearch?: typeof streamPerplexity;
	/** Build a recap string from the transcript using the current pi model. */
	synthesize: (transcript: TranscriptTurn[], signal: AbortSignal) => Promise<string>;
	/** Called when the panel closes (null = cancelled). */
	done: (value: ResearchResult | null) => void;
}

const RESEARCH_SYSTEM_PROMPT =
	"You are a precise research assistant. Use search results to answer the user's question with concrete facts and cite sources. Be thorough but concise. When the user asks follow-ups, maintain context across the conversation.";

export class ResearchPanel implements Component, Focusable {
	private tui: TUI;
	private theme: Theme;
	private mdTheme: ReturnType<typeof getMarkdownTheme>;
	private deps: ResearchPanelDeps;

	private input: Input;
	private turns: TranscriptTurn[] = [];

	private status: "idle" | "searching" | "recap" | "error" = "idle";
	private statusMessage = "";

	// streaming state for the in-flight answer
	private partial = "";
	private partialCitations: PerplexitySource[] = [];
	private abortController: AbortController | null = null;

	// scroll
	private scrollOffset = 0; // lines from the bottom
	private autoScroll = true;

	// rendered-transcript cache: recompute only when content or width changes,
	// so scrolling / typing in the input never re-runs the Markdown renderer.
	private version = 0;
	private cachedLines: string[] = [];
	private cachedKey = "";

	private _focused = false;

	prefill(text: string): void {
		this.input.setValue(text);
	}

	constructor(tui: TUI, theme: Theme, deps: ResearchPanelDeps) {
		this.tui = tui;
		this.theme = theme;
		this.mdTheme = getMarkdownTheme();
		this.deps = deps;
		this.input = new Input();
		this.input.onSubmit = (value) => this.submitQuery(value);
		this.input.onEscape = () => this.handleEscape();
	}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	/** Bump the content version so the rendered-transcript cache is rebuilt. */
	private bump(): void {
		this.version++;
	}

	invalidate(): void {
		this.cachedKey = "";
		this.input.invalidate();
		this.tui.requestRender();
	}

	private get transcriptHeight(): number {
		const rows = process.stdout.rows ?? 24;
		// top border(1) + bottom border(1) + input(1) + help(1) = 4
		return Math.max(3, rows - 4);
	}

	handleInput(data: string): void {
		// While searching, only Esc (cancel) and scroll are allowed.
		if (this.status === "searching" || this.status === "recap") {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
				this.abortController?.abort();
				return;
			}
			if (matchesKey(data, "up")) {
				this.handleScroll(-1);
				this.tui.requestRender();
			} else if (matchesKey(data, "down")) {
				this.handleScroll(1);
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.handleEscape();
			return;
		}
		if (matchesKey(data, "ctrl+r")) {
			void this.requestRecap();
			return;
		}
		if (matchesKey(data, "ctrl+n")) {
			this.resetSession();
			return;
		}
		if (matchesKey(data, "up")) {
			this.handleScroll(-1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			this.handleScroll(1);
			this.tui.requestRender();
			return;
		}

		// printable / editing keys go to the input box
		this.input.handleInput(data);
		this.tui.requestRender();
	}

	private handleEscape(): void {
		if (this.status === "searching" || this.status === "recap") {
			this.abortController?.abort();
			return;
		}
		// idle: close panel, discard everything
		this.deps.done(null);
	}

	private handleScroll(delta: number): void {
		// delta < 0 scrolls up (away from the latest content); disable auto-tail
		// delta > 0 scrolls back down; re-enable auto-tail once we reach the bottom
		const lines = this.getRenderedLines(this.lastWidth);
		const th = this.transcriptHeight;
		if (lines.length <= th) return;
		if (delta < 0) {
			this.autoScroll = false;
			this.scrollOffset = Math.min(lines.length - th, this.scrollOffset + -delta);
		} else {
			this.scrollOffset = Math.max(0, this.scrollOffset - delta);
			if (this.scrollOffset === 0) this.autoScroll = true;
		}
	}

	private buildMessages(turns: TranscriptTurn[]): PerplexityMessage[] {
		const messages: PerplexityMessage[] = [{ role: "system", content: RESEARCH_SYSTEM_PROMPT }];
		for (const turn of scopeTranscriptCitations(turns).turns) {
			const sources = turn.citations?.map((source) => `[${source.id}] ${source.title} ${source.url}`).join("\n");
			messages.push({ role: turn.role, content: turn.text + (sources ? `\n\nPrior-turn provider sources (not locally inspected):\n${sources}` : "") });
		}
		return messages;
	}

	private async submitQuery(rawQuery: string): Promise<void> {
		const query = rawQuery.trim();
		if (!query || this.status === "searching" || this.status === "recap") return;

		// Candidate transcript: built and preflighted WITHOUT committing the query
		// or clearing the input, so a locally rejected request cannot poison the
		// session. Preflight uses the exact scoped replay messages (and stream=true,
		// default maxTokens/preset) the transport call below sends; signal/callback
		// options do not affect the encoded body or envelope validation.
		const messages = this.buildMessages([...this.turns, { role: "user", text: query }]);
		try {
			preflightResearchRequest(messages, {});
		} catch (err) {
			this.rejectQueryLocally(err);
			return;
		}

		this.input.setValue("");
		this.turns.push({ role: "user", text: query });
		this.partial = "";
		this.partialCitations = [];
		this.status = "searching";
		this.statusMessage = "researching (fast synthesis)…";
		this.autoScroll = true;
		this.scrollOffset = 0;
		this.bump();
		this.tui.requestRender();

		this.abortController = new AbortController();

		try {
			await (this.deps.streamResearch ?? streamPerplexity)(messages, {
				signal: this.abortController.signal,
				onDelta: (chunk) => {
					this.partial += chunk;
					this.bump();
					this.tui.requestRender();
				},
				onCitations: (sources) => {
					this.partialCitations = sources;
					this.bump();
					this.tui.requestRender();
				},
			}).then((result) => {
				if (this.abortController?.signal.aborted) throw new DOMException("Research cancelled", "AbortError");
				this.turns.push({
					role: "assistant",
					text: result.content, // Terminal structured text is authoritative.
					citations: result.citations,
					responseId: result.responseId,
					unresolvedCitations: result.unresolvedCitations,
					usage: result.usage,
				});
			});
			this.status = "idle";
			this.statusMessage = "";
			this.partial = "";
			this.partialCitations = [];
			this.autoScroll = true;
			this.scrollOffset = 0;
			this.bump();
		} catch (err) {
			if (this.abortController?.signal.aborted) {
				// keep whatever streamed so far as a partial answer
				if (this.partial.trim()) {
					this.turns.push({
						role: "assistant",
						text: this.partial + "\n\n_(search cancelled)_",
						citations: this.partialCitations,
						unresolvedCitations: unresolvedCitationMarkers(this.partial, this.partialCitations),
					});
				}
				this.status = "idle";
				this.statusMessage = "";
			} else {
				this.status = "error";
				this.statusMessage = err instanceof Error ? err.message : String(err);
			}
			this.partial = "";
			this.partialCitations = [];
			this.bump();
		} finally {
			this.abortController = null;
			this.tui.requestRender();
		}
	}

	/**
	 * Local preflight rejection: no fetch, key lookup, or billable work. The
	 * submitted text stays editable in the input and the transcript is untouched
	 * (citation scopes therefore never shift). Classified by a second preflight
	 * of the accepted history alone — if that also exceeds the replay budget,
	 * say so explicitly and offer recap (Ctrl+R) or a deliberate new session
	 * (Ctrl+N) instead of truncating or remapping anything.
	 */
	private rejectQueryLocally(err: unknown): void {
		const detail = err instanceof Error ? err.message : String(err);
		const code = (err as RequestValidationError | undefined)?.code;
		let exhausted = false;
		try {
			preflightResearchRequest(this.buildMessages(this.turns), {});
		} catch {
			exhausted = true;
		}
		this.status = "error";
		this.statusMessage = exhausted
			? `${detail} — history replay budget exhausted; press ctrl+r to recap this transcript, or ctrl+n for a new session (input kept for retry)`
			: `${detail} — query not sent${code ? ` (${code})` : ""}; edit it in the input and resubmit`;
		this.partial = "";
		this.partialCitations = [];
		this.bump();
		this.tui.requestRender();
	}

	/**
	 * Deliberate Ctrl+N action (idle/error only, never mid-search/recap): clears
	 * prior panel transcript/render/source state only on this explicit choice;
	 * the current input text is retained for retry.
	 */
	private resetSession(): void {
		if (this.status === "searching" || this.status === "recap") return;
		this.turns = [];
		this.partial = "";
		this.partialCitations = [];
		this.status = "idle";
		this.statusMessage = "";
		this.autoScroll = true;
		this.scrollOffset = 0;
		this.bump();
		this.tui.requestRender();
	}

	private async requestRecap(): Promise<void> {
		if (this.turns.length === 0) {
			this.status = "error";
			this.statusMessage = "nothing to recap yet";
			this.bump();
			this.tui.requestRender();
			return;
		}
		this.status = "recap";
		this.statusMessage = "building recap…";
		this.bump();
		this.tui.requestRender();

		this.abortController = new AbortController();
		try {
			const recap = await this.deps.synthesize(this.turns, this.abortController.signal);
			if (!this.abortController.signal.aborted) {
				this.deps.done({ recap: true, transcript: this.turns, recapText: recap });
			} else {
				this.status = "idle";
				this.statusMessage = "";
			}
		} catch (err) {
			if (this.abortController.signal.aborted) {
				this.status = "idle";
				this.statusMessage = "";
			} else {
				this.status = "error";
				this.statusMessage = err instanceof Error ? err.message : String(err);
			}
			this.bump();
		} finally {
			this.abortController = null;
			this.tui.requestRender();
		}
	}

	// ---- rendering --------------------------------------------------------

	private renderQuery(turn: TranscriptTurn, width: number): string[] {
		const prefix = this.theme.fg("accent", this.theme.bold("❯ "));
		return wrapTextWithAnsi(prefix + turn.text, width);
	}

	private renderAnswer(text: string, citations: PerplexitySource[] | undefined, width: number): string[] {
		const md = new Markdown(text || "_(no answer)_", 0, 0, this.mdTheme);
		const lines = md.render(width);

		if (citations && citations.length > 0) {
			lines.push(this.theme.fg("dim", "─".repeat(Math.min(width, 48))));
			citations.forEach((c) => {
				const num = this.theme.fg("accent", `[${c.id}]`);
				const title = this.theme.fg("muted", c.title);
				const url = this.theme.fg("dim", c.url);
				lines.push(truncateToWidth(`${num} ${title} ${url}`, width));
			});
		}
		return lines;
	}

	/** Build the full flat line array for the transcript (all turns + partial). */
	private computeTranscriptLines(width: number): string[] {
		const lines: string[] = [];
		for (const turn of this.turns) {
			if (turn.role === "user") {
				lines.push(...this.renderQuery(turn, width));
			} else {
				lines.push(...this.renderAnswer(turn.text, turn.citations, width));
				if (turn.usage !== undefined) {
					const usageText = JSON.stringify(turn.usage);
					lines.push(...wrapTextWithAnsi(this.theme.fg("dim", `External provider usage: ${usageText.slice(0, 512)}${usageText.length > 512 ? "…" : ""}`), width));
				}
				if (turn.unresolvedCitations?.length) {
					lines.push(...wrapTextWithAnsi(this.theme.fg("warning", `Unresolved citations: ${turn.unresolvedCitations.join(", ")}`), width));
				}
			}
			lines.push("");
		}

		// in-flight streaming answer
		if (this.partial || this.status === "searching") {
			lines.push(...this.renderAnswer(this.partial || "…", this.partialCitations, width));
			const unknown = unresolvedCitationMarkers(this.partial, this.partialCitations);
			if (unknown.length) lines.push(...wrapTextWithAnsi(this.theme.fg("warning", `Pending/unresolved citations: ${unknown.join(", ")}`), width));
		}

		// Wrap (never truncate) so oversized error/status text — e.g. the deterministic
		// local-rejection guidance for ctrl+r/ctrl+n — stays fully visible at narrow
		// terminal widths instead of emitting an over-width line the host renderer
		// cannot draw. Handles embedded newlines and ANSI codes.
		if (this.status === "error" && this.statusMessage) {
			lines.push(...wrapTextWithAnsi(this.theme.fg("error", `Error: ${this.statusMessage}`), width));
			lines.push("");
		}

		return lines;
	}

	/** Cached accessor for the rendered transcript lines. */
	private lastWidth = 80;

	private getRenderedLines(width: number): string[] {
		this.lastWidth = width;
		const key = `${this.version}:${width}`;
		if (key !== this.cachedKey) {
			this.cachedLines = this.computeTranscriptLines(width);
			this.cachedKey = key;
		}
		return this.cachedLines;
	}

	render(width: number): string[] {
		const innerWidth = Math.max(10, width - 2);

		// ---- top border: title · model · status ----
		const modeTag = this.theme.fg("dim", "fast · provider synthesis, not inspected evidence");
		const statusTag =
			this.status === "searching"
				? this.theme.fg("warning", ` ${this.statusMessage}`)
				: this.status === "recap"
					? this.theme.fg("accent", ` ${this.statusMessage}`)
					: this.status === "error"
						? this.theme.fg("error", " error")
						: "";
		const title = this.theme.fg("accent", this.theme.bold(" Perplexity Research "));
		const label = title + this.theme.fg("dim", " · ") + modeTag + statusTag;
		const topBorder = this.theme.fg("border", "─".repeat(Math.max(1, innerWidth - visibleWidth(label)))) + label;
		const topLine = truncateToWidth(topBorder, innerWidth);

		// ---- transcript (scrollable slice) ----
		const allLines = this.getRenderedLines(innerWidth);
		const th = this.transcriptHeight;

		let start: number;
		if (this.autoScroll || allLines.length <= th) {
			start = Math.max(0, allLines.length - th);
			this.scrollOffset = 0;
		} else {
			const maxStart = Math.max(0, allLines.length - th);
			start = Math.max(0, maxStart - this.scrollOffset);
		}
		const visible = allLines.slice(start, start + th);
		while (visible.length < th) visible.push("");

		// ---- bottom border: scroll indicator ----
		const scrollInfo =
			allLines.length > th
				? this.theme.fg("dim", ` ${start + 1}-${Math.min(start + th, allLines.length)}/${allLines.length} `)
				: "";
		const bottomBorder = this.theme.fg("border", "─".repeat(Math.max(1, innerWidth - visibleWidth(scrollInfo)))) + scrollInfo;
		const bottomLine = truncateToWidth(bottomBorder, innerWidth);

		// ---- input line ----
		const prompt = this.theme.fg("accent", "▸ ");
		const inputWidth = Math.max(4, innerWidth - visibleWidth(prompt));
		const renderedInput = this.input.render(inputWidth);
		const inputLine = truncateToWidth(prompt + (renderedInput[0] ?? ""), innerWidth);

		// ---- help line ----
		const help = truncateToWidth(
			this.theme.fg(
				"dim",
				" ⏎ send · fast only · ctrl+r recap · ctrl+n new session · ↑↓ scroll · esc cancel/close",
			),
			innerWidth,
		);

		const out: string[] = [];
		out.push(topLine);
		out.push(...visible);
		out.push(bottomLine);
		out.push(inputLine);
		out.push(help);
		return out;
	}
}

export type { Theme };
