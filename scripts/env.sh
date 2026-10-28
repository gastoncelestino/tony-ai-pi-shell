#!/usr/bin/env bash
# @project-map
# purpose: Carga .env como valores por defecto: el entorno del proceso gana.
# role: config-loader
# inputs: Un directorio con un archivo .env y el entorno heredado del proceso.
# outputs: Las variables del .env exportadas, sin pisar las que ya venían fijadas.
# used-by: scripts/pi.sh al preparar la corrida.
# read-when: Cambia la precedencia entre el entorno del proceso y el archivo .env.

# Carga <root>/.env sin pisar lo que ya venía en el entorno: el archivo aporta
# valores por defecto y el proceso decide. Es la misma regla que ya usa
# load_env() en la matriz de integración, y la que permite que una corrida
# encienda o apague TONY_CODE_INDEX sin editar el archivo.
load_env_defaults() {
  local root="$1"
  local preset_env=""
  local line=""
  local allexport="off"
  [[ -f "$root/.env" ]] || return 0

  case "$-" in *a*) allexport="on" ;; esac

  # Copia del entorno heredado. `export -p` emite "declare -x", y `declare` dentro
  # de una función crea una variable local: el valor se perdería al salir. Se
  # reescribe como `export`, que sí alcanza el ámbito global.
  while IFS= read -r line; do
    case "$line" in
      "declare -f"*|"declare -fx"*) continue ;;
      "declare -x "*) preset_env+="export ${line#declare -x }"$'\n' ;;
    esac
  done < <(export -p)

  set -a
  # shellcheck disable=SC1090
  . "$root/.env"
  set +a
  [[ "$allexport" == "on" ]] && set -a

  # Vuelve a poner lo que venía: el entorno del proceso gana sobre el archivo.
  eval "$preset_env"
  unset preset_env
}
