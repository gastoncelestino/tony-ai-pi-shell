import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ───────────────────────── Variables ─────────────────────────
const min_terminal = 100; // con menos columnas el sidebar se oculta
const config: Record<string, Record<string, any>> = { userPrompt: {}, sidebarLeft: {}, sidebarRight: {}, themeVars: {}, themeColors: {} };
const mcpServers: Record<string, any> = {};
const agent = "Tony Stark";
const turn = { input: 0, output: 0, cacheRead: 0, totalTokens: 0, startedAt: undefined as number | undefined, endedAt: undefined as number | undefined };
const hex_color = /^#[0-9a-f]{6}$/i;
const bar_size = 14;
const sidebar_gap = 3;

let pi: ExtensionAPI | undefined;
let ctx: ExtensionContext | undefined;
let tui: any;
let theme: any;
let sidebar: any;
let footerTimer: ReturnType<typeof setInterval> | undefined;
let title = "Mereces lo que sueñas ...";
let model = "";

// ───────────────────────── Configuración ─────────────────────────
function readJson(...file: string[]): any {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), ...file), "utf8"));
  } catch {
    return {};
  }
}

function loadConfig(): void {
  const json = readJson("kernel", "ui", "opencode-ui.json");
  const themeJson = readJson(".pi", "themes", "opencode.json");

  Object.assign(config.userPrompt, json.userPrompt ?? {});
  Object.assign(config.sidebarLeft, json.sidebarLeft ?? {});
  Object.assign(config.sidebarRight, json.sidebarRight ?? {});
  Object.assign(config.themeVars, themeJson.vars ?? {});
  Object.assign(config.themeColors, themeJson.colors ?? {});
}

function loadMcpServers(): void {
  const json = readJson("kernel", "ui", "mcp.json");

  Object.assign(mcpServers, json.mcpServers ?? json.servers ?? {});
}

// ───────────────────────── Colores ─────────────────────────
function resolveThemeVar(name: string, seen = new Set<string>()): string {
  const nombre = config.themeVars[name];

  if (nombre === undefined || seen.has(name)) return "";
  if (hex_color.test(nombre)) return nombre;

  return resolveThemeVar(config.themeVars[name], seen.add(name));
}

function color(value: string | undefined): string {
  const text = value ?? "";

  return text.startsWith("$") ? resolveThemeVar(text.slice(1)) : text;
}

function rgb(hex: string): string {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(";");
}

function fg(value: string | undefined, text: string): string {
  const c = color(value);

  if (hex_color.test(c)) return `\x1b[38;2;${rgb(c)}m${text}\x1b[39m`;

  return c ? theme.fg(c, text) : text;
}

function bgCode(value: string | undefined): string {
  const c = color(value);
  if (hex_color.test(c)) return `\x1b[48;2;${rgb(c)}m`;
  const marker = "\u0001";
  const painted: string = theme.bg(c, marker);

  if (!c) return "";
  return painted.slice(0, painted.indexOf(marker));
}

function withBackground(line: string, width: number, bg: string): string {
  const content = truncateToWidth(line, width, "", true);
  const keepBackgroundAfterReset = content.replace(/\x1b\[(?:0|49)m/g, (reset) => reset + bg);

  return bg + keepBackgroundAfterReset + "\x1b[0m";
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function sidebarIsVisible(terminalWidth: number): boolean {
  return terminalWidth >= min_terminal && !(sidebar?.isHidden?.() ?? false);
}

function mainContentWidth(terminalWidth: number): number {
  if (!sidebarIsVisible(terminalWidth)) return terminalWidth;

  return Math.max(20, Math.floor((terminalWidth * (100 - config.sidebarRight.width)) / 100));
}

// Hace que cada bloque del chat se dibuje con el ancho de la zona izquierda y
// su fondo; el resto de la línea queda en blanco para el sidebar.
function shrinkMainContent(ui: any): void {
  for (const child of ui.children ?? []) {
    if (child.__shrunk) continue; // ya lo parcheamos antes
    child.__shrunk = true;

    const originalRender = child.render.bind(child);

    child.render = (width: number): string[] => {
      const main = mainContentWidth(width);
      const gap = sidebarIsVisible(width) ? sidebar_gap : 0;
      const bg = bgCode(config.sidebarLeft.bg);

      return originalRender(Math.max(10, main - gap)).map((line: string) => {
        if (line.includes("\x1b_G") || line.includes("\x1b]1337")) return line;

        return withBackground(line, main, bg) + " ".repeat(Math.max(0, width - main));
      });
    };
  }
}

function showSidebar(ui: any): void {
  tui = ui;
  shrinkMainContent(ui);

  // Si ya existe una barra lateral activa, nos ahorramos recrearla innecesariamente
  if (sidebar) return;
  sidebar = ui.showOverlay(new StatusSidebar(), { nonCapturing: true, anchor: "top-right", width: `${config.sidebarRight.width}%`, minWidth: 10, visible: (terminalWidth: number) => terminalWidth >= min_terminal });
}

// ───────────────────────── Footer (línea de estadísticas, 100% del ancho) ─────────────────────────

function formatTokens(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "0s";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;

  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);

  return `${minutes}m${seconds}s`;
}

function createFooter() {
  return {
    invalidate() {},

    render(width: number): string[] {
      // Contexto: cuántos tokens lleva la conversación y cuánto entra en el modelo
      const usage = ctx?.getContextUsage();
      const used = usage?.tokens ?? undefined;
      const limit = usage?.contextWindow;
      const percent = usage?.percent == null ? undefined : Math.max(0, Math.min(100, usage.percent));

      const contextText = used !== undefined && limit ? `${formatTokens(used)}/${formatTokens(limit)}` : "–";

      const filled = percent === undefined ? 0 : Math.round((percent / 100) * bar_size);
      const bar = percent === undefined ? "·".repeat(bar_size) : "█".repeat(filled) + "░".repeat(bar_size - filled);

      // Tiempo del turno: corre mientras responde y se congela al terminar
      const elapsedMs = turn.startedAt === undefined ? 0 : (turn.endedAt ?? Date.now()) - turn.startedAt;

      // Velocidad: tokens de salida por segundo
      const speed = elapsedMs > 0 && turn.output > 0 ? `${(turn.output / (elapsedMs / 1000)).toFixed(1)} tok/s` : "tok/s";

      const total = turn.totalTokens > 0 ? turn.totalTokens : turn.input + turn.output;
      const cwd = (ctx?.cwd ?? "").replace(os.homedir(), "~");

      const parts = [
        theme.fg("muted", ` ${cwd}`),
        theme.fg("text", `↑ ${formatTokens(turn.input)}`),
        theme.fg("text", `↓ ${formatTokens(turn.output)}`),
        theme.fg("text", `Total ${formatTokens(total)}`),
        theme.fg("text", `Cached ${formatTokens(turn.cacheRead)}`),
        theme.fg("text", `🕒 ${formatDuration(elapsedMs)}`),
        theme.fg("text", `Ctx ${contextText}`),
        theme.fg("text", bar),
        theme.fg("success", `⚡ ${speed}`)
      ];

      return ["", truncateToWidth(parts.join(theme.fg("dim", "  ·  ")), width)];
    }
  };
}

class ThemedEditor extends CustomEditor {
  render(width: number): string[] {
    const screen = process.stdout.columns || width;
    const panelWidth = config.userPrompt.width ? Math.min(width, Math.floor((screen * config.userPrompt.width) / 100)) : width;
    const lines = super.render(Math.max(10, panelWidth - 3));
    const bottomBorder = lines.findLastIndex((line) => /^─{3,}/.test(stripAnsi(line)));

    if (bottomBorder < 1) return lines;

    const text = lines.slice(1, bottomBorder);
    const rest = lines.slice(bottomBorder + 1);

    const bar = fg(config.userPrompt.border, "┃");
    const bg = bgCode(config.userPrompt.bg);
    const effort = pi?.getThinkingLevel?.() ?? "–";

    const modelLine = theme.fg("accent", agent) + " " + theme.fg("muted", "·") + " " + theme.fg("text", model || "—") + " " + theme.fg("muted", "·") + " " + theme.fg("muted", effort || "—");

    const panel = ["", ...text, "", modelLine, ""].map((line) => withBackground(bar + "  " + line, panelWidth, bg));

    return [...panel, ...rest.map((line) => truncateToWidth(line, panelWidth))];
  }
}

class StatusSidebar {
  invalidate(): void {}
  dispose(): void {}

  render(width: number): string[] {
    const height = Math.min(process.stdout.rows - 1, config.sidebarRight.height || process.stdout.rows - 1);
    const bg = bgCode(config.sidebarRight.bg);
    const innerWidth = Math.max(8, width);
    const lines: string[] = [""];
    const count = Object.keys(mcpServers).length ? ` (${Object.keys(mcpServers).length})` : "";

    lines.push(...wrapTextWithAnsi("\x1b[1m" + theme.fg("text", title || " ") + "\x1b[22m", innerWidth).slice(0, 3));
    lines.push("");
    lines.push(theme.fg("text", "▾ MCP") + theme.fg("dim", count));

    if (Object.keys(mcpServers).length === 0) lines.push(theme.fg("dim", "  sin MCP configurados"));

    for (const [name, server] of Object.entries(mcpServers)) {
      lines.push("  " + theme.fg(server?.disabled ? "dim" : "success", "●") + " " + theme.fg("muted", name));
    }

    const rendered = lines.slice(0, height).map((line) => withBackground("  " + truncateToWidth(line, innerWidth + 2, "…"), width, bg));

    while (rendered.length < height) rendered.push(withBackground("", width, bg));

    return rendered;
  }
}

// ───────────────────────── Export funciones events.ts ─────────────────────────

// Se llama una vez al iniciar la sesión (evento session_start)
export function initializeUi(context: ExtensionContext, api: ExtensionAPI): void {
  ctx = context;
  pi = api;

  loadConfig();
  loadMcpServers();
  model = context.model?.id ?? "";

  context.ui.setEditorComponent((ui: any, activeTheme: any, keybindings: any) => {
    theme = activeTheme;
    showSidebar(ui);

    return new ThemedEditor(ui, activeTheme, keybindings);
  });

  context.ui.setFooter((ui: any, activeTheme: any) => {
    tui = ui;
    theme = activeTheme;

    return createFooter();
  });
}

// Empieza a responder el agente: reinicia las métricas y arranca el reloj
export function startTurn(): void {
  Object.assign(turn, { input: 0, output: 0, cacheRead: 0, totalTokens: 0, startedAt: Date.now(), endedAt: undefined });

  if (footerTimer) clearInterval(footerTimer);
  footerTimer = setInterval(requestRender, 250); // para que tiempo y velocidad corran en vivo
  
  requestRender();
}

// Terminó de responder: congela el tiempo
export function endTurn(): void {
  if (footerTimer) {
    clearInterval(footerTimer);
    footerTimer = undefined;
  }

  if (turn.startedAt !== undefined && turn.endedAt === undefined) {
    turn.endedAt = Date.now();
  }

  requestRender();
}

// El título del sidebar es la primera línea del primer mensaje que escribís
export function setSessionTitle(input: unknown): void {
  if (title || typeof input !== "string" || !input.trim()) return;

  title = input.trim().split("\n")[0] ?? "";
  
  requestRender();
}

export function setCurrentModel(modelId: unknown): void {
  if (typeof modelId !== "string" || !modelId) return;

  model = modelId;
  
  requestRender();
}

export function requestRender(): void {
  tui?.requestRender?.();
}

// Suma los tokens que informó el modelo (evento turn_end)
export function addTurnUsage(usage: any): void {
  if (!usage) return;

  // Si no hubo startTurn (por ejemplo un turno que ya venía corriendo), abrimos uno
  if (turn.startedAt === undefined) startTurn();

  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;

  turn.input += input;
  turn.output += output;
  turn.cacheRead += cacheRead;
  turn.totalTokens += usage.totalTokens ?? input + output + cacheRead + cacheWrite;

  requestRender();
}

export function toggleSidebar(): void {
  if (!sidebar) return;

  sidebar.setHidden(!sidebar.isHidden());
  requestRender();
}