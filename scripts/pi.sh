#!/usr/bin/env bash
# @project-map
# purpose: Prepara llama-swap y qdrant, valida modelos y lanza Pi Agent.
# role: system-launcher
# inputs: Argumentos CLI, config.yaml y variables de entorno (el entorno gana sobre .env).
# outputs: Sesión Pi y liberación de recursos al finalizar.
# used-by: Usuario o entorno de ejecución.
# read-when: Cambia el arranque, la selección del modelo o el cierre.
set -uo pipefail

is_up() { curl -fsS -m 2 "${TONY_LLAMASWAP_URL:-http://localhost:8080}/health" >/dev/null 2>&1; }

# Enfriar el entorno solo si el server no está arriba (evitar matar un server reutilizable).
if ! is_up; then
  ps aux | grep -E 'llama|python.*cuda' | grep -v grep | grep -v opencode \
    | awk '{print $2}' | xargs -r kill -9 2>/dev/null || true
  sleep 2   # esperar a que VRAM/RAM se liberen de verdad
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$ROOT/scripts/env.sh"
load_env_defaults "$ROOT"

URL="${TONY_LLAMASWAP_URL:-http://localhost:8080}"
BIN="${TONY_LLAMASWAP_BIN:-/usr/local/bin/llama-swap}"
CONFIG="${TONY_LLAMASWAP_CONFIG:-$ROOT/config.yaml}"
TONY_HOME="${TONY_AI_HOME:-$HOME/.tony-ai}"
LOG_DIR="${TONY_LLAMASWAP_LOG:-$TONY_HOME/logs-pi}"
LOG="$LOG_DIR/llama-swap.log"
PIDFILE="$TONY_HOME/llama-swap.pid"
AGENT_DIR=""

QDRANT_BIN="${TONY_QDRANT_BIN:-/usr/local/bin/qdrant}"
QDRANT_URL="${TONY_QDRANT_URL:-http://127.0.0.1:6334}"
QDRANT_CONFIG="$ROOT/scripts/qdrant.yaml"
QDRANT_LOG="$TONY_HOME/qdrant-startup.log"

for d in "${PI_CODING_AGENT_DIR:-}" "$ROOT/.pi/agent" "$HOME/.pi/agent" "$(dirname "$TONY_HOME")/.pi/agent"; do
  if [[ -n "$d" && -f "$d/settings.json" ]]; then AGENT_DIR="$d"; break; fi
done

if [[ -n "$AGENT_DIR" ]]; then export PI_CODING_AGENT_DIR="$AGENT_DIR"; fi

# Prioriza el CLI instalado en este repositorio. Se invoca con node para no depender del bit ejecutable del shim npm.
PI_LOCAL_CLI=""
if [[ -z "${PI_BIN:-}" && -f "$ROOT/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" ]]; then
  PI_BIN="node"
  PI_LOCAL_CLI="$ROOT/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
else
  PI_BIN="${PI_BIN:-pi}"
fi
PORT="${URL##*:}"; PORT="${PORT%%/*}"
LISTEN="${TONY_LLAMASWAP_LISTEN:-127.0.0.1:$PORT}"
WATCH_CONFIG="${TONY_LLAMASWAP_WATCH_CONFIG:--watch-config}"

say()  { printf '\033[36m✔️\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[33m⚠ %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
not_in() { grep -vxFf <(printf '%s\n' "$2") <(printf '%s\n' "$1") || true; }

# Levanta qdrant si no está corriendo. Fail-open: sin qdrant, tony-mem degrada
# a SQLite/FTS5 (semantic.available=false) y todo sigue funcionando.
ensure_qdrant() {
  if curl -sf -m 3 "${QDRANT_URL}/healthz" >/dev/null 2>&1; then
    say "qdrant arriba (${QDRANT_URL})"
    return 0
  fi
  if [[ ! -x "$QDRANT_BIN" ]]; then
    warn "qdrant no encontrado en ${QDRANT_BIN} — memoria semantica off"
    return 1
  fi
  [[ -f "$QDRANT_CONFIG" ]] || { warn "no existe ${QDRANT_CONFIG} — memoria semantica off"; return 1; }
  mkdir -p "$TONY_HOME" "$(dirname "$QDRANT_LOG")"

  # El storage del config y el del .env tienen que ser el mismo: si divergen,
  # la capa semantica escribe en un lado y el servidor de tony-mem lee del otro.
  local cfg_storage
  cfg_storage="$(awk '/^[[:space:]]*storage_path:/{print $2; exit}' "$QDRANT_CONFIG" 2>/dev/null)"
  if [[ -n "${TONY_QDRANT_STORAGE:-}" && -n "$cfg_storage" && "$cfg_storage" != "$TONY_QDRANT_STORAGE" ]]; then
    die "storage_path del config ($cfg_storage) != TONY_QDRANT_STORAGE ($TONY_QDRANT_STORAGE)"
  fi

  say "qdrant abajo, levantando (${QDRANT_URL})…"
  # Qdrant crea en su cwd el marcador .qdrant-initialized y el directorio
  # snapshots/. Levantarlo con el cwd en TONY_AI_HOME deja ese estado de
  # runtime fuera del proyecto.
  nohup env -C "$TONY_HOME" "$QDRANT_BIN" --config-path "$QDRANT_CONFIG" >>"$QDRANT_LOG" 2>&1 </dev/null &
  disown $! 2>/dev/null || true

  local i
  for ((i = 0; i < 15; i++)); do
    curl -sf -m 2 "${QDRANT_URL}/healthz" >/dev/null 2>&1 && { say "qdrant ok"; return 0; }
    sleep 1
  done
  warn "qdrant tardo demasiado — memoria semantica off"
  return 1
}

command -v curl >/dev/null || die "falta curl"
command -v jq   >/dev/null || die "falta jq (sudo apt install jq)"
command -v "$PI_BIN" >/dev/null || die "no encuentro '$PI_BIN' en el PATH"

# verificar si llama-swap esta arriba
if is_up; then
  say "llama-swap está arriba en $URL"
else
  [[ -x "$BIN" ]]    || die "no existe o no es ejecutable: $BIN"
  [[ -f "$CONFIG" ]] || die "no existe el config: $CONFIG"
  mkdir -p "$LOG_DIR" "$TONY_HOME"

  say "llama-swap abajo, levantando ($LISTEN)…"
  nohup "$BIN" --config "$CONFIG" --listen "$LISTEN" $WATCH_CONFIG >>"$LOG" 2>&1 </dev/null &
  SWAP_PID=$!
  echo "$SWAP_PID" >"$PIDFILE"
  disown "$SWAP_PID" 2>/dev/null || true

  for ((i = 0; i < 60; i++)); do
    is_up && break
    if ! kill -0 "$SWAP_PID" 2>/dev/null; then
      tail -n 20 "$LOG" >&2
      die "llama-swap murió al arrancar (log: $LOG)"
    fi
    sleep 0.5
  done
  is_up || die "llama-swap no respondió en 30s (log: $LOG)"
  say "llama-swap arriba (pid $SWAP_PID)"
fi

# verificar carga de modelos config.yaml
registered="$(curl -fsS -m 5 "$URL/v1/models" | jq -r '.data[].id')" || die "no pude leer $URL/v1/models"
expected="$(awk '/^models:/{m=1; next} m && /^  [^ #][^:]*:[[:space:]]*$/{gsub(/^ +|:[[:space:]]*$/, ""); print}' "$CONFIG")"
missing="$(not_in "$expected" "$registered")"
n_exp="$(printf '%s\n' "$expected" | grep -c .)"
n_reg="$(printf '%s\n' "$registered" | grep -c .)"

if [[ -n "$missing" ]]; then
  warn "llama-swap no expone estos modelos de config.yaml (¿está corriendo con otro config?):"
  printf '    - %s\n' $missing >&2
else
  say "modelos OK: $n_reg registrados, $n_exp en config.yaml"
fi

# qdrant: capa semántica de tony-mem. Fail-open si no levanta.
ensure_qdrant || true


if [[ -n "$AGENT_DIR" && -f "$AGENT_DIR/models.json" ]]; then
  pi_models="$(jq -r '.providers[]?.models[]?.id' "$AGENT_DIR/models.json" 2>/dev/null)"
  pi_missing="$(not_in "$pi_models" "$registered")"
  if [[ -n "$pi_missing" ]]; then
    warn "pi tiene modelos en models.json que llama-swap no expone:"
    printf '    - %s\n' $pi_missing >&2
  fi
fi


files_missing="$(grep -oP '(?:--model|--chat-template-file) \K\S+' "$CONFIG" | sort -u \
  | while read -r f; do [[ -f "$f" ]] || echo "$f"; done)"
if [[ -n "$files_missing" ]]; then
  warn "archivos referenciados en config.yaml que no existen:"
  printf '    - %s\n' $files_missing >&2
fi


# precarga de modelos, solo si PI_WARM=1
if [[ "${PI_WARM:-1}" == "1" ]]; then
  model="${PI_DEFAULT_MODEL:-}"
  for f in "$ROOT/.pi/settings.json" "${AGENT_DIR:+$AGENT_DIR/settings.json}"; do
    [[ -z "$model" && -n "$f" && -f "$f" ]] && model="$(jq -r '.defaultModel // empty' "$f" 2>/dev/null)"
  done

  if [[ -z "$model" ]]; then
    warn "no encontré defaultModel (busqué en: ${AGENT_DIR:-<sin settings.json>}/settings.json y $ROOT/.pi/settings.json). Usá PI_DEFAULT_MODEL=<id> — salto la precarga"
  elif ! grep -qxF "$model" <<<"$registered"; then
    warn "el modelo por defecto '$model' no está registrado en llama-swap — salto la precarga"
  elif curl -fsS -m 3 "$URL/running" 2>/dev/null \
         | jq -e --arg m "$model" '.running[]? | select(.model == $m and .state == "ready")' >/dev/null 2>&1; then
    say "$model ya está cargado y listo"
  else
    say "cargando $model en VRAM…"
    t0=$SECONDS
    body="$(jq -n --arg m "$model" \
      '{model:$m, messages:[{role:"user",content:"ok"}], max_tokens:1, stream:false, cache_prompt:true}')"
    if curl -fsS -m "${PI_WARM_TIMEOUT:-120}" "$URL/v1/chat/completions" \
         -H 'Content-Type: application/json' -d "$body" -o /dev/null; then
      say "$model listo en $((SECONDS - t0))s"
    else
      warn "falló la precarga de $model (revisá el log del modelo)"
      die "No puedo continuar"
    fi
  fi
fi

# verificar si $AGENT_DIR esta en directorio correcto
[[ -n "$AGENT_DIR" ]] && say "config de pi: $AGENT_DIR"
if [[ -n "$PI_LOCAL_CLI" ]]; then
  "$PI_BIN" "$PI_LOCAL_CLI" "$@"
else
  "$PI_BIN" "$@"
fi
rc=$?

# Liberar VRAM/RAM al salir de pi
if [[ "${TONY_UNLOAD_ON_EXIT:-1}" == "1" ]]; then
  curl -fsS -m 15 "$URL/unload" >/dev/null 2>&1 \
    && say "VRAM/RAM liberadas" \
    || warn "no pude descargar los modelos"
fi
exit "$rc"
