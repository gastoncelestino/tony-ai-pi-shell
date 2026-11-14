/** OpenCode-style shell for Pi: right sidebar, stats footer and themed prompt. */
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const AGENT = "Tony Stark";
const DEFAULT_TITLE = "Mereces lo que sueñas ...";
const MIN_TERMINAL = 100;
const SIDEBAR_GAP = 3;
const BAR_SIZE = 14;
const HEX = /^#[0-9a-f]{6}$/i;

const state = {
  pi: undefined as ExtensionAPI | undefined,
  ctx: undefined as ExtensionContext | undefined,
  tui: undefined as any,
  theme: undefined as any,
  sidebar: undefined as any,
  timer: undefined as ReturnType<typeof setInterval> | undefined,
  title: DEFAULT_TITLE,
  model: "",
  turn: { input: 0, output: 0, cacheRead: 0, totalTokens: 0, startedAt: 0, endedAt: 0 },
  editor: undefined as any,
  footer: undefined as any,
  footerHeight: 0,
  mainWidth: 0,
  config: {} as Record<string, any>,
  vars: {} as Record<string, string>,
  mcp: {} as Record<string, any>
};

const formatTokens = (count: number): string => (count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count));
const formatDuration = (ms: number): string => (ms <= 0 ? "0s" : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`);

function readJson(...file: string[]): any {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), ...file), "utf8"));
  } catch {
    return {};
  }
}

function loadConfig(): void {
  const config = readJson("kernel", "ui", "opencode-ui.json");
  state.config = { userPrompt: config.userPrompt ?? {}, sidebarLeft: config.sidebarLeft ?? {}, sidebarRight: config.sidebarRight ?? {} };
  state.vars = readJson(".pi", "themes", "opencode.json").vars ?? {};
  const mcp = readJson("kernel", "ui", "mcp.json");
  state.mcp = mcp.mcpServers ?? mcp.servers ?? {};
}

function color(value: string | undefined): string {
  const text = value ?? "";
  if (!text.startsWith("$")) return text;
  const direct = state.vars[text.slice(1)];
  const hex = direct?.startsWith("#") ? direct : state.vars[direct ?? ""];
  return hex && HEX.test(hex) ? hex : "";
}

function rgb(hex: string): string {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(";");
}

function fg(value: string | undefined, text: string): string {
  const c = color(value);
  if (HEX.test(c)) return `\x1b[38;2;${rgb(c)}m${text}\x1b[39m`;
  return c ? state.theme.fg(c, text) : text;
}

function bgCode(value: string | undefined): string {
  const c = color(value);
  if (HEX.test(c)) return `\x1b[48;2;${rgb(c)}m`;
  if (!c) return "";
  const marker = "\u0001";
  const painted: string = state.theme.bg(c, marker);
  return painted.slice(0, painted.indexOf(marker));
}

function withBackground(line: string, width: number, bg: string): string {
  const content = truncateToWidth(line, width, "", true);
  return bg + content.replace(/\x1b\[(?:0|49)m/g, (reset) => reset + bg) + "\x1b[0m";
}

function sidebarIsVisible(terminalWidth: number): boolean {
  return terminalWidth >= MIN_TERMINAL && !(state.sidebar?.isHidden?.() ?? false);
}

function mainContentWidth(terminalWidth: number): number {
  if (!sidebarIsVisible(terminalWidth)) return terminalWidth;
  return Math.max(20, Math.floor((terminalWidth * (100 - state.config.sidebarRight.width)) / 100));
}

function shrinkMainContent(ui: any): void {
  for (const child of ui.children ?? []) {
    if (child.__shrunk) continue;
    child.__shrunk = true;
    const originalRender = child.render.bind(child);
    child.render = (width: number): string[] => {
      if (child.children?.includes(state.editor) || child.children?.includes(state.footer)) return originalRender(width);
      const main = mainContentWidth(width);
      state.mainWidth = main;
      const gap = sidebarIsVisible(width) ? SIDEBAR_GAP : 0;
      const bg = bgCode(state.config.sidebarLeft.bg);
      return originalRender(Math.max(10, main - gap)).map((line: string) => {
        if (line.includes("\x1b_G") || line.includes("\x1b]1337")) return line;
        return withBackground(line, main, bg) + " ".repeat(Math.max(0, width - main));
      });
    };
  }
}

function shorten(text: string, room: number): string {
  if (visibleWidth(text) <= room) return text;
  return "…" + text.slice(-Math.max(1, room - 1));
}

function createFooter() {
  return {
    invalidate() {},

    render(width: number): string[] {
      const theme = state.theme;
      const turn = state.turn;
      const usage = state.ctx?.getContextUsage();
      const used = usage?.tokens ?? undefined;
      const limit = usage?.contextWindow;
      const raw = usage?.percent;
      const percent = raw == null ? undefined : Math.max(0, Math.min(100, raw));
      const context = used !== undefined && limit ? `${formatTokens(used)}/${formatTokens(limit)}` : "–";
      const filled = percent === undefined ? 0 : Math.round((percent / 100) * BAR_SIZE);
      const bar = percent === undefined ? "·".repeat(BAR_SIZE) : "█".repeat(filled) + "░".repeat(BAR_SIZE - filled);
      const elapsed = turn.startedAt ? (turn.endedAt || Date.now()) - turn.startedAt : 0;
      const speed = elapsed > 0 && turn.output > 0 ? `${(turn.output / (elapsed / 1000)).toFixed(1)} tok/s` : "tok/s";
      const total = turn.totalTokens > 0 ? turn.totalTokens : turn.input + turn.output;
      const cwd = (state.ctx?.cwd ?? "").replace(os.homedir(), "~");
      const separator = theme.fg("dim", "  ·  ");
      const stats = [
        theme.fg("text", `↑ ${formatTokens(turn.input)}`),
        theme.fg("text", `↓ ${formatTokens(turn.output)}`),
        theme.fg("text", `Total ${formatTokens(total)}`),
        theme.fg("text", `Cached ${formatTokens(turn.cacheRead)}`),
        theme.fg("text", `🕒 ${formatDuration(elapsed)}`),
        theme.fg("text", `Ctx ${context}`),
        theme.fg("success", `⚡ ${speed}`)
      ];
      const withBar = [...stats.slice(0, 6), theme.fg("text", bar), stats[6]];
      const segments = width - visibleWidth(withBar.join(separator)) > 3 ? withBar : stats;
      const room = width - visibleWidth(segments.join(separator)) - visibleWidth(separator);
      const path = room > 3 ? shorten(cwd, room - 1) : "";
      const line = path ? [theme.fg("muted", ` ${path}`), ...segments].join(separator) : segments.join(separator);
      const out = ["", truncateToWidth(line, width)];
      state.footerHeight = out.length;
      return out;
    }
  };
}

class StatusSidebar {
  invalidate(): void {}
  dispose(): void {}

  render(width: number): string[] {
    const theme = state.theme;
    const config = state.config.sidebarRight;
    const height = Math.max(1, process.stdout.rows - state.footerHeight);
    const bg = bgCode(config.bg);
    const inner = Math.max(8, width);
    const names = Object.keys(state.mcp);
    const lines = ["", ...wrapTextWithAnsi("\x1b[1m" + theme.fg("text", state.title || " ") + "\x1b[22m", inner).slice(0, 3), "", theme.fg("text", "▾ MCP") + theme.fg("dim", names.length ? ` (${names.length})` : "")];
    if (names.length === 0) lines.push(theme.fg("dim", "  sin MCP configurados"));
    for (const name of names) {
      lines.push(`  ${theme.fg(state.mcp[name]?.disabled ? "dim" : "success", "●")} ${theme.fg("muted", name)}`);
    }
    const rendered = lines.slice(0, height).map((line) => withBackground("  " + truncateToWidth(line, inner + 2, "…"), width, bg));
    while (rendered.length < height) rendered.push(withBackground("", width, bg));
    return rendered;
  }
}

class PromptEditor extends CustomEditor {
  override render(width: number): string[] {
    const theme = state.theme;
    const config = state.config.userPrompt;
    const main = state.mainWidth || mainContentWidth(width);
    const gap = sidebarIsVisible(width) ? SIDEBAR_GAP : 0;
    const room = Math.max(10, main - gap);
    const panelWidth = config.width ? Math.min(room, Math.floor((room * config.width) / 100)) : room;
    const lines = super.render(Math.max(10, panelWidth - 3));
    const bottom = lines.findLastIndex((line) => /^─{3,}/.test(line.replace(/\x1b\[[0-9;]*m/g, "")));
    if (bottom < 1) return lines;
    const bar = fg(config.border, "┃");
    const bg = bgCode(config.bg);
    const effort = state.pi?.getThinkingLevel?.() ?? "–";
    const model = theme.fg("accent", AGENT) + " " + theme.fg("muted", "·") + " " + theme.fg("text", state.model || "—") + " " + theme.fg("muted", "·") + " " + theme.fg("muted", effort || "—");
    const panel = ["", ...lines.slice(1, bottom), "", model, ""].map((line) => withBackground(bar + "  " + line, panelWidth, bg));
    const separator = bgCode(state.config.sidebarLeft.bg) + " ".repeat(Math.max(0, main - panelWidth)) + "\x1b[0m";
    return [...panel.map((line) => line + separator), ...lines.slice(bottom + 1).map((line) => truncateToWidth(line, panelWidth) + separator)];
  }
}

export function requestRender(): void {
  state.tui?.requestRender?.();
}

export function initializeUi(context: ExtensionContext, api: ExtensionAPI): void {
  state.ctx = context;
  state.pi = api;
  state.model = context.model?.id ?? "";
  state.theme = context.ui.theme;
  loadConfig();

  context.ui.setEditorComponent((ui: any, editorTheme: any, keybindings: any) => {
    state.tui = ui;
    shrinkMainContent(ui);

    if (!state.sidebar) {
      state.sidebar = ui.showOverlay(new StatusSidebar(), { nonCapturing: true, anchor: "top-right", width: `${state.config.sidebarRight.width}%`, minWidth: 10, visible: (terminalWidth: number) => terminalWidth >= MIN_TERMINAL });
    }
    state.editor = new PromptEditor(ui, editorTheme, keybindings);
    return state.editor;
  });

  context.ui.setFooter((ui: any, activeTheme: any) => {
    state.tui = ui;
    state.theme = activeTheme;
    state.footer = createFooter();
    return state.footer;
  });
}

export function startTurn(): void {
  Object.assign(state.turn, { input: 0, output: 0, cacheRead: 0, totalTokens: 0, startedAt: Date.now(), endedAt: 0 });
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(requestRender, 250);
  requestRender();
}

export function endTurn(): void {
  if (state.timer) clearInterval(state.timer);
  state.timer = undefined;
  if (state.turn.startedAt && !state.turn.endedAt) state.turn.endedAt = Date.now();
  requestRender();
}

export function addTurnUsage(usage: any): void {
  if (!usage) return;

  if (!state.turn.startedAt) startTurn();
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  state.turn.input += input;
  state.turn.output += output;
  state.turn.cacheRead += cacheRead;
  state.turn.totalTokens += usage.totalTokens ?? input + output + cacheRead + cacheWrite;
  requestRender();
}

export function toggleSidebar(): void {
  if (!state.sidebar) return;
  state.sidebar.setHidden(!state.sidebar.isHidden());
  requestRender();
}

export function setSessionTitle(text: unknown): void {
  if (state.title || typeof text !== "string" || !text.trim()) return;
  state.title = text.trim().split("\n")[0] ?? "";
  requestRender();
}

export function setCurrentModel(modelId: unknown): void {
  if (typeof modelId !== "string" || !modelId) return;
  state.model = modelId;
  requestRender();
}