import { completionDefinitions } from "./commands-table.ts";

const quote = (text: string) => `'${text.replace(/'/g, `'"'"'`)}'`;
const print = (values: readonly string[]) => values.length ? `printf '%s\\n' ${values.map(quote).join(" ")}` : "true";

/** Static lookup data generated from the exact definitions the CLI uses. No installed executable is queried. */
function metadata(fish: boolean): string {
  const cases: [string, string[]][] = [];
  for (const definition of completionDefinitions()) {
    const state = definition.path.join(" ");
    cases.push([`children:${state}:`, definition.children]);
    cases.push([`options:${state}:`, Object.keys(definition.options)]);
    for (const [name, option] of Object.entries(definition.options)) {
      if (option.value === undefined) continue;
      cases.push([`type:${state}:${name}`, [typeof option.value === "string" ? option.value : "enum"]]);
      if (typeof option.value !== "string") cases.push([`values:${state}:${name}`, [...option.value]]);
    }
    for (const [index, argument] of definition.args.entries()) {
      cases.push([`argument:${state}:${index}`, [argument.path ? "path" : argument.values ? "enum" : "text"]]);
      if (argument.values) cases.push([`arguments:${state}:${index}`, [...argument.values]]);
    }
  }
  if (fish) return `function _amem_meta\n    switch "$argv[1]:$argv[2]:$argv[3]"\n${cases.map(([key, values]) => `        case ${quote(key)}\n            ${print(values)}`).join("\n")}\n    end\nend\n`;
  return `_amem_meta() {\n  case "$1:$2:$3" in\n${cases.map(([key, values]) => `    ${quote(key)}) ${print(values)} ;;`).join("\n")}\n  esac\n}\n`;
}

/** Bash and zsh share a POSIX-style word walker; the last supplied token is the current prefix. */
const context = `_amem_context() {
  _amem_state='' _amem_pos=0 _amem_pending='' _amem_cur='' _amem_literal=0
  local word child option i=0
  for word do
    i=$((i + 1))
    if [ "$i" -eq "$#" ]; then _amem_cur=$word; break; fi
    if [ -n "$_amem_pending" ]; then _amem_pending=''; continue; fi
    if [ "$_amem_literal" -eq 0 ]; then
      if [ "$word" = '--' ]; then _amem_literal=1; continue; fi
      case "$word" in
        --*=*) continue ;;
        -*)
          if [ -n "$(_amem_meta type "$_amem_state" "$word")" ]; then _amem_pending=$word; fi
          continue ;;
      esac
      if [ "$_amem_pos" -eq 0 ]; then
        child=''
        while IFS= read -r option; do
          if [ "$option" = "$word" ]; then child=$word; break; fi
        done <<AMEM_CHILDREN
$(_amem_meta children "$_amem_state" '')
AMEM_CHILDREN
        if [ -n "$child" ]; then _amem_state="\${_amem_state:+$_amem_state }$child"; _amem_pos=0; continue; fi
      fi
    fi
    _amem_pos=$((_amem_pos + 1))
  done
}

_amem_emit() {
  local candidate
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    case "$candidate" in "$_amem_cur"*) printf '%s\\n' "$_amem_lead$candidate" ;; esac
  done
}
`;

function shCandidates(zsh: boolean): string {
  const files = zsh ? `local pattern="\${(b)_amem_cur}*" candidate
    local -a paths
    paths=( \${~pattern}(N) )
    for candidate in "\${paths[@]}"; do
      [ -d "$candidate" ] && candidate="$candidate/"
      printf '%s\\n' "$_amem_lead$candidate"
    done` : `local candidate
    while IFS= read -r candidate; do
      [ -d "$candidate" ] && candidate="$candidate/"
      printf '%s\\n' "$_amem_lead$candidate"
    done < <(compgen -f -- "$_amem_cur")`;
  return `${context}
_amem_candidates() {
  ${zsh ? "emulate -L zsh" : ":"}
  _amem_context "$@"
  local kind='' _amem_lead=''
  if [ -n "$_amem_pending" ]; then
    kind=$(_amem_meta type "$_amem_state" "$_amem_pending")
  elif [ "$_amem_literal" -eq 0 ]; then
    case "$_amem_cur" in
      --*=*)
        _amem_pending=\${_amem_cur%%=*}
        _amem_lead="$_amem_pending="
        _amem_cur=\${_amem_cur#*=}
        kind=$(_amem_meta type "$_amem_state" "$_amem_pending") ;;
    esac
  fi
  if [ -z "$kind" ] && [ -z "$_amem_pending" ]; then kind=$(_amem_meta argument "$_amem_state" "$_amem_pos"); fi
  if [ "$kind" = path ]; then
    ${files}
  elif [ "$kind" = enum ]; then
    if [ -n "$_amem_pending" ]; then _amem_meta values "$_amem_state" "$_amem_pending"
    else _amem_meta arguments "$_amem_state" "$_amem_pos"; fi | _amem_emit
  elif [ -n "$_amem_pending" ]; then
    return 0
  else
    if [ "$_amem_literal" -eq 0 ]; then
      {
        [ "$_amem_pos" -ne 0 ] || _amem_meta children "$_amem_state" ''
        _amem_meta options "$_amem_state" ''
      } | _amem_emit
    fi
  fi
}
`;
}

function bash(): string {
  return `# amem bash completion; generated from command definitions.\n${metadata(false)}${shCandidates(false)}
_amem_complete() {
  local candidate
  COMPREPLY=()
  while IFS= read -r candidate; do COMPREPLY+=("$candidate"); done < <(_amem_candidates "\${COMP_WORDS[@]:1:COMP_CWORD}")
  compopt -o filenames 2>/dev/null || :
}
complete -F _amem_complete amem
`;
}

function zsh(): string {
  return `#compdef amem\n# amem zsh completion; generated from command definitions.\n${metadata(false)}${shCandidates(true)}
_amem_complete() {
  emulate -L zsh
  local -a candidates
  _amem_context "\${words[@]:1:$((CURRENT - 1))}"
  local kind=''
  if [ -n "$_amem_pending" ]; then kind=$(_amem_meta type "$_amem_state" "$_amem_pending")
  else kind=$(_amem_meta argument "$_amem_state" "$_amem_pos"); fi
  if [ "$kind" = path ]; then _files; return; fi
  candidates=( "\${(@f)$(_amem_candidates "\${words[@]:1:$((CURRENT - 1))}")}" )
  (( \${#candidates} )) && compadd -- "\${candidates[@]}"
}
# An autoloaded _amem file is itself the first completion invocation.
if [[ "\${funcstack[1]-}" == _amem ]]; then
  _amem_complete
elif (( $+functions[compdef] )); then
  compdef _amem_complete amem
fi
`;
}

function fish(): string {
  return `# amem fish completion; generated from command definitions.\n${metadata(true)}
function _amem_candidates
    set -l state ''
    set -l positional 0
    set -l pending ''
    set -l literal 0
    set -l current ''
    set -l index 0
    for word in $argv
        set index (math $index + 1)
        if test $index -eq (count $argv)
            set current "$word"
            break
        end
        if test -n "$pending"
            set pending ''
            continue
        end
        if test $literal -eq 0
            if test "$word" = --
                set literal 1
                continue
            end
            if string match -q -- '-*' "$word"
                set -l option_kind (_amem_meta type "$state" "$word")
                if not string match -q -- '*=*' "$word"; and test (count $option_kind) -gt 0
                    set pending "$word"
                end
                continue
            end
            if test $positional -eq 0; and contains -- "$word" (_amem_meta children "$state" '')
                set state (string trim -- "$state $word")
                set positional 0
                continue
            end
        end
        set positional (math $positional + 1)
    end
    set -l kind ''
    set -l lead ''
    if test -n "$pending"
        set kind (_amem_meta type "$state" "$pending")
    else if test $literal -eq 0; and string match -q -- '--*=*' "$current"
        set pending (string split -m 1 = -- "$current")[1]
        set lead "$pending="
        set current (string split -m 1 = -- "$current")[2]
        set kind (_amem_meta type "$state" "$pending")
    end
    if test -z "$kind"; and test -z "$pending"
        set kind (_amem_meta argument "$state" "$positional")
    end
    if test "$kind" = path
        for candidate in "$current"*
            if test -d "$candidate"
                set candidate "$candidate/"
            end
            printf '%s\\n' "$lead$candidate"
        end
    else
        set -l candidates
        if test "$kind" = enum
            if test -n "$pending"
                set candidates (_amem_meta values "$state" "$pending")
            else
                set candidates (_amem_meta arguments "$state" "$positional")
            end
        else if test -z "$pending"; and test $literal -eq 0
            if test $positional -eq 0
                set candidates (_amem_meta children "$state" '')
            end
            set -a candidates (_amem_meta options "$state" '')
        end
        set -l prefix_regex (string escape --style=regex -- "$current")
        for candidate in $candidates
            if string match -rq -- "^$prefix_regex" "$candidate"
                printf '%s\\n' "$lead$candidate"
            end
        end
    end
end

complete -c amem -f -a '(_amem_candidates (commandline -opc)[2..-1] (commandline -ct))'
`;
}

/** Generate a self-contained script; neither generation nor completion consults memory or network. */
export function completionScript(shell: string): string {
  if (shell === "bash") return bash();
  if (shell === "zsh") return zsh();
  if (shell === "fish") return fish();
  throw new Error(`unsupported completion shell ${shell}; choose zsh, bash or fish`);
}
