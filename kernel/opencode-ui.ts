import { CustomEditor, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ───────────────────────── Estado ─────────────────────────

type McpServer = { name: string; enabled: boolean };

type TurnStats = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  startedAt?: number;
  endedAt?: number;
};

const emptyTurn = (): TurnStats => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });

let terminalUi: any = null;
let sidebarOverlay: any = null;
let overlayUi: any = null;
let sessionContext: any = null;
let activeTheme: any = null;
let piApi: any = null;
let footerTicker: ReturnType<typeof setInterval> | undefined;

const state = {
  title: "",
  mode: "Tony Stark",
  model: "",
  effort: "",
  mcpServers: [] as McpServer[],
  tokensIn: 0,
  tokensOut: 0,
  tokensCached: 0,
  cost: 0,
  turn: emptyTurn()
};

const config = {
  layout: {} as Record<string, number>,
  stats: {} as Record<string, number>,
  colors: {} as Record<string, string>
};

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

const requestRender = (): void => {
  terminalUi?.requestRender?.();
};

function getTheme(): any {
  return activeTheme ?? sessionContext?.ui?.theme;
}

// ───────────────────────── Configuración ─────────────────────────

function loadConfig(): void {
  const file = path.resolve(process.cwd(), ".pi", "agent", "opencode-ui.json");

  try {
    const json = JSON.parse(fs.readFileSync(file, "utf8"));

    Object.assign(config.layout, json.layout);
    Object.assign(config.stats, json.stats);
    Object.assign(config.colors, json.colors);
  } catch {
    // Se conservan los valores predeterminados.
  }
}

function loadMcpServers(): McpServer[] {
  const file = path.join(os.homedir(), ".pi", "agent", "mcp.json");

  try {
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    const servers = json.mcpServers ?? json.servers ?? {};

    return Object.entries(servers).map(([name, value]) => {
      const server = value as { disabled?: boolean } | null;

      return { name, enabled: server?.disabled !== true };
    });
  } catch {
    return [];
  }
}

// ───────────────────────── Colores ─────────────────────────

function getColor(key: string, fallback: string): string {
  return config.colors[key] ?? config.colors[fallback] ?? fallback;
}

function hexToRgb(hex: string): string {
  return [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16)).join(";");
}

function foreground(key: string, fallback: string, text: string): string {
  const color = getColor(key, fallback);

  if (HEX_COLOR.test(color)) {
    return `\x1b[38;2;${hexToRgb(color)}m${text}\x1b[39m`;
  }

  if (!color) {
    return text;
  }

  return getTheme().fg(color, text);
}

function background(key: string, fallback: string): string {
  const color = getColor(key, fallback);

  if (HEX_COLOR.test(color)) {
    return `\x1b[48;2;${hexToRgb(color)}m`;
  }

  const marker = "\u0001";
  const sequence = getTheme().bg(color, marker);

  return sequence.slice(0, sequence.indexOf(marker));
}

function renderBackgroundLine(line: string, width: number, backgroundAnsi: string): string {
  const content = truncateToWidth(line, width, "", true);

  return backgroundAnsi + content.replace(/\x1b\[(?:0|49)m/g, (reset) => reset + backgroundAnsi) + "\x1b[0m";
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

// ───────────────────────── Mensajes del usuario ─────────────────────────

const userMessagePrototype: any = UserMessageComponent.prototype;

if (!userMessagePrototype.__piUiOriginalRender) {
  userMessagePrototype.__piUiOriginalRender = userMessagePrototype.render;

  userMessagePrototype.render = function (width: number): string[] {
    const bar = background("userBg", "userMessageBg") + foreground("userBorder", "accent", "┃") + "\x1b[0m";

    return userMessagePrototype.__piUiOriginalRender
      .call(this, Math.max(1, width - 1))
      .map((line: string) => bar + line);
  };
}

// ───────────────────────── Editor ─────────────────────────

class ThemedEditor extends CustomEditor {
  render(width: number): string[] {
    const theme = getTheme();
    const contentWidth = Math.max(10, width - 3);
    const originalLines = super.render(contentWidth);

    let bottomBorder = -1;

    for (let index = originalLines.length - 1; index > 0; index--) {
      if (/^─{3,}/.test(stripAnsi(originalLines[index]!))) {
        bottomBorder = index;
        break;
      }
    }

    if (bottomBorder < 1) {
      return originalLines;
    }

    const body = originalLines.slice(1, bottomBorder);
    const remaining = originalLines.slice(bottomBorder + 1);

    const panelBackground = background("promptBg", "selectedBg");
    const border = foreground("promptBorder", "accent", "┃");

    const modelInfo =
      foreground("promptMode", "accent", state.mode) +
      " " +
      theme.fg("muted", "·") +
      " " +
      theme.fg("text", state.model || "—");

    const lines = ["", ...body, "", modelInfo, ""].map((line) =>
      renderBackgroundLine(border + " " + line, width, panelBackground)
    );

    return [...lines, ...remaining.map((line) => truncateToWidth(line, width))];
  }
}

// ───────────────────────── Sidebar ─────────────────────────

class StatusSidebar {
  invalidate(): void {}
  dispose(): void {}

  render(width: number): string[] {
    const theme = getTheme();
    const height = Math.min(process.stdout.rows - 1, config.layout.sidebarHeight || process.stdout.rows - 1);
    const innerWidth = Math.max(8, width);
    const panelBackground = background("sidebarBg", "userMessageBg");
    const lines: string[] = [""];

    lines.push(
      ...wrapTextWithAnsi("\x1b[1m" + theme.fg("text", state.title || " ") + "\x1b[22m", innerWidth).slice(
        0,
        3
      )
    );

    lines.push("");

    lines.push(
      theme.fg("text", "▾ MCP") +
        theme.fg("dim", state.mcpServers.length ? ` (${state.mcpServers.length})` : "")
    );

    if (state.mcpServers.length === 0) {
      lines.push(theme.fg("dim", "  sin MCP configurados"));
    } else {
      for (const server of state.mcpServers) {
        lines.push(
          "  " + theme.fg(server.enabled ? "success" : "dim", "●") + " " + theme.fg("muted", server.name)
        );
      }
    }

    const output = lines
      .slice(0, height)
      .map((line) =>
        renderBackgroundLine("  " + truncateToWidth(line, innerWidth + 2, "…"), width, panelBackground)
      );

    while (output.length < height) {
      output.push(renderBackgroundLine("", width, panelBackground));
    }

    return output;
  }
}

// ───────────────────────── Layout ─────────────────────────

function getMainContentWidth(width: number): number {
  const sidebarVisible = width >= config.layout.sidebarMinTerm && !(sidebarOverlay?.isHidden?.() ?? false);

  const percentage = sidebarVisible
    ? config.layout.mainWidth - config.layout.mainMarginRight
    : config.layout.mainWidthNoSidebar - config.layout.mainMarginRightNoSidebar;

  return Math.min(width, Math.max(20, Math.floor((width * percentage) / 100)));
}

function installMainContentLayout(ui: any): void {
  for (const child of ui.children ?? []) {
    if (child.__piUiWrapped) continue;

    child.__piUiWrapped = true;

    const originalRender = child.render.bind(child);

    child.render = (width: number) =>
      originalRender(getMainContentWidth(width)).map((line: string) => {
        if (line.includes("\x1b_G") || line.includes("\x1b]1337")) {
          return line;
        }

        return line + "\x1b[0m" + " ".repeat(Math.max(0, width - visibleWidth(line)));
      });
  }
}

function ensureSidebar(ui: any): void {
  terminalUi = ui;
  installMainContentLayout(ui);

  if (sidebarOverlay && overlayUi === ui) {
    return;
  }

  overlayUi = ui;

  sidebarOverlay = ui.showOverlay(new StatusSidebar(), {
    nonCapturing: true,
    anchor: "top-right",
    width: `${config.layout.sidebarWidth}%`,
    minWidth: config.layout.sidebarMinWidth,
    visible: (width: number) => width >= config.layout.sidebarMinTerm
  });
}

// ───────────────────────── Footer ─────────────────────────

function createFooter(): any {
  return {
    invalidate() {},

    render(width: number): string[] {
      const usage = sessionContext?.getContextUsage?.() ?? {};

      const formatTokens = (count: number): string =>
        !Number.isFinite(count) ? "–" : count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);

      const cwd = (sessionContext?.cwd ?? "").replace(os.homedir(), "~");

      // Modelo y nivel de esfuerzo (se lee en vivo desde pi en cada render)
      const model = state.model;
      const modelName = typeof model === "string" ? model : (model?.id ?? "–");

      const liveEffort = typeof piApi?.getThinkingLevel === "function" ? piApi.getThinkingLevel() : undefined;
      const rawEffort = liveEffort ?? state.effort;
      const effort = typeof rawEffort === "string" && rawEffort.trim() ? rawEffort.toLowerCase() : "–";

      // Métricas del turno: activo o el último que terminó.
      // Antes del primer turno se muestran los acumulados de la sesión.
      const turn = state.turn;
      const hasTurn = turn.startedAt != null;

      // Tokens
      const tokensIn = hasTurn ? turn.input : state.tokensIn;
      const tokensOut = hasTurn ? turn.output : state.tokensOut;

      // Cached
      const cached = hasTurn ? turn.cacheRead : state.tokensCached;

      // Total
      const total = hasTurn && turn.totalTokens > 0 ? turn.totalTokens : tokensIn + tokensOut;

      // Contexto
      const used = typeof usage.tokens === "number" ? usage.tokens : undefined;
      const limit = typeof usage.contextWindow === "number" ? usage.contextWindow : undefined;

      const percent =
        typeof usage.percent === "number"
          ? Math.max(0, Math.min(100, usage.percent))
          : used !== undefined && limit !== undefined && limit > 0
            ? Math.max(0, Math.min(100, (used / limit) * 100))
            : undefined;

      const contextText =
        used !== undefined && limit !== undefined ? `${formatTokens(used)}/${formatTokens(limit)}` : "–";

      // Barra de contexto: 40 bloques
      const barWidth = 40;

      const filled = percent === undefined ? 0 : Math.round((percent / 100) * barWidth);

      const bar =
        percent === undefined ? "·".repeat(barWidth) : "█".repeat(filled) + "░".repeat(barWidth - filled);

      // Tiempo: corre en vivo durante el turno y queda fijo al terminar
      const now = Date.now();

      const elapsedMs =
        turn.startedAt != null ? Math.max(0, (turn.endedAt ?? now) - turn.startedAt) : undefined;

      const timeText =
        typeof elapsedMs === "number" && Number.isFinite(elapsedMs) && elapsedMs > 0
          ? elapsedMs >= 60_000
            ? `${Math.floor(elapsedMs / 60_000)}m${Math.floor((elapsedMs % 60_000) / 1000)}s`
            : `${(elapsedMs / 1000).toFixed(1)}s`
          : "0s";

      // Velocidad: tokens de salida por segundo
      const speed =
        typeof elapsedMs === "number" && elapsedMs > 0 && tokensOut > 0
          ? tokensOut / (elapsedMs / 1000)
          : undefined;

      const speedText = speed !== undefined && Number.isFinite(speed) ? `${speed.toFixed(1)} tok/s` : "tok/s";

      const sep = foreground("statsSep", "dim", "  ·  ");

      const parts = [
        foreground("statsCwd", "", ` ${cwd}`),
        foreground("statsCtx", "", `󰧑 ${modelName}`),
        foreground("statsCwd", "", effort),
        foreground("statsClock", "", `↑ ${formatTokens(tokensIn)}`),
        foreground("statsClock", "", `↓ ${formatTokens(tokensOut)}`),
        foreground("statsClock", "", `Total ${formatTokens(total)}`),
        foreground("statsClock", "", `Cached ${formatTokens(cached)}`),
        foreground("statsClock", "", `🕒 ${timeText}`),
        foreground("statsClock", "", `Contexto ${contextText}`),
        foreground("statsClock", "", bar),
        foreground("statsTokens", "", `⚡ ${speedText}`)
      ];

      const line = truncateToWidth(parts.join(sep), width);

      return [
        ...Array(config.stats.marginTop ?? 0).fill(""),
        line,
        ...Array(config.stats.marginBottom ?? 0).fill("")
      ];
    }
  };
}

// ───────────────────────── exports ─────────────────────────

// `pi` es opcional pero necesario para leer el nivel de esfuerzo (pi.getThinkingLevel()).
export function initializeUi(context: any, pi?: any): void {
  sessionContext = context;
  piApi = pi ?? piApi;
  loadConfig();

  state.title = "";
  state.model = context.model?.id ?? "";
  state.mcpServers = loadMcpServers();

  const initialEffort = typeof piApi?.getThinkingLevel === "function" ? piApi.getThinkingLevel() : undefined;
  if (typeof initialEffort === "string") state.effort = initialEffort;

  context.ui.setEditorComponent((ui: any, theme: any, keybindings: any) => {
    activeTheme = theme;
    ensureSidebar(ui);

    return new ThemedEditor(ui, theme, keybindings);
  });

  context.ui.setFooter((ui: any, theme: any) => {
    terminalUi = ui;
    activeTheme = theme;

    return createFooter();
  });
}

export function setSessionTitle(input: unknown): void {
  if (state.title || typeof input !== "string" || !input.trim()) {
    return;
  }

  state.title = input.trim().split("\n")[0] ?? "";
  requestRender();
}

export function setCurrentModel(modelId: unknown): void {
  if (typeof modelId !== "string" || !modelId) {
    return;
  }

  state.model = modelId;
  requestRender();
}

export function setThinkingLevel(level: unknown): void {
  if (typeof level !== "string" || !level) {
    return;
  }

  state.effort = level;
  requestRender();
}

// Llamar al comenzar la respuesta del agente (evento agent_start)
export function startTurn(): void {
  state.turn = { ...emptyTurn(), startedAt: Date.now() };

  if (footerTicker) clearInterval(footerTicker);
  // Refresca el footer para que el tiempo y la velocidad corran en vivo
  footerTicker = setInterval(requestRender, 250);

  requestRender();
}

// Llamar al terminar la respuesta del agente (evento agent_end)
export function endTurn(): void {
  if (footerTicker) {
    clearInterval(footerTicker);
    footerTicker = undefined;
  }

  if (state.turn.startedAt != null && state.turn.endedAt == null) {
    state.turn.endedAt = Date.now();
  }

  requestRender();
}

export function addTurnUsage(usage: any): void {
  if (!usage) return;

  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const totalTokens = usage.totalTokens ?? input + output + cacheRead + cacheWrite;

  // Acumulado de la sesión
  state.tokensIn += input;
  state.tokensOut += output;
  state.tokensCached += cacheRead;
  state.cost += usage.cost?.total ?? 0;

  // Turno en curso (si no hubo startTurn, se abre uno para no perder métricas)
  if (state.turn.startedAt == null) {
    state.turn = { ...emptyTurn(), startedAt: Date.now() };
  }

  state.turn.input += input;
  state.turn.output += output;
  state.turn.cacheRead += cacheRead;
  state.turn.cacheWrite += cacheWrite;
  state.turn.totalTokens += totalTokens;

  requestRender();
}

export function requestUiRender(): void {
  requestRender();
}

export function toggleSidebar(): void {
  if (!sidebarOverlay) return;

  const hidden = sidebarOverlay.isHidden?.() ?? false;
  sidebarOverlay.setHidden(!hidden);
}
