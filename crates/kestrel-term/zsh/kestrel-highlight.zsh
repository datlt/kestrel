# Kestrel command line colors for zsh. Kestrel rewrites this file, so do not edit it.
#
# A zle hook runs before each redraw of the command line. It sets `region_highlight`
# for the command word (green when zsh finds it, red when not), options (-x, --name),
# quoted strings, $variables, and comments. It leaves the entries of other tools alone.
# It does nothing when you load zsh-syntax-highlighting or fast-syntax-highlighting.

autoload -Uz add-zle-hook-widget is-at-least 2>/dev/null
# `zle-line-pre-redraw` needs zsh 5.3 or newer.
is-at-least 5.3 || return 0
(( $+functions[_zsh_highlight] || $+ZSH_HIGHLIGHT_VERSION || $+FAST_HIGHLIGHT_VERSION )) && return 0

# zsh 5.9 can tag an entry with `memo=...`. The hook tags its entries and removes
# only those on the next run. Older zsh cannot tag, so there the hook owns the whole list.
typeset -gi __kestrel_hl_memo=0
is-at-least 5.9 && __kestrel_hl_memo=1
# Regular expressions for one token at the start of the text.
typeset -g __kestrel_re_space='^[[:space:]]+'
typeset -g __kestrel_re_single="^'[^']*('|\$)"
typeset -g __kestrel_re_double='^"([^"\\]|\\.)*("|$)'
typeset -g __kestrel_re_var='^\$(\{[^}]*\}?|[[:alnum:]_]+|[@*#?$!-])'
typeset -g __kestrel_re_op='^(\|\||\|&|&&|\||;;?|&|\(|\)|`|<<<?|<|>>?|>)'
typeset -g __kestrel_re_word='^([^[:space:]'"'"'"$|&;<>()`\\]|\\.)+'

__kestrel_hl() {
  emulate -L zsh
  # Remove our old entries first.
  if (( __kestrel_hl_memo )); then
    region_highlight=( "${(@)region_highlight:#*memo=kestrel}" )
  else
    region_highlight=()
  fi
  # A highlighter loaded later (a plugin manager can load it late) wins.
  (( $+functions[_zsh_highlight] || $+ZSH_HIGHLIGHT_VERSION || $+FAST_HIGHLIGHT_VERSION )) && return 0
  local rest=$BUFFER
  (( ${#rest} == 0 || ${#rest} > 800 )) && return 0

  local w style f p
  local -a out
  local -i pos=0 len cmd=1 file=0 count=0 comments=0
  [[ -o interactive_comments ]] && comments=1

  while [[ -n $rest ]] && (( ++count <= 100 )); do
    style=
    len=0
    if [[ $rest =~ $__kestrel_re_space ]]; then
      len=${#MATCH}
    elif (( comments )) && [[ $rest == '#'* ]]; then
      len=${#rest}
      style=fg=8
    elif [[ $rest == \'* ]]; then
      [[ $rest =~ $__kestrel_re_single ]] && len=${#MATCH}
      style=fg=yellow
      cmd=0 file=0
    elif [[ $rest == \"* ]]; then
      [[ $rest =~ $__kestrel_re_double ]] && len=${#MATCH}
      style=fg=yellow
      cmd=0 file=0
    elif [[ $rest == '$('* ]]; then
      len=2
      cmd=1
    elif [[ $rest == \$* ]]; then
      [[ $rest =~ $__kestrel_re_var ]] && len=${#MATCH}
      (( len == 0 )) && len=1
      (( len > 1 )) && style=fg=magenta
      cmd=0 file=0
    elif [[ $rest =~ $__kestrel_re_op ]]; then
      len=${#MATCH}
      case $MATCH in
        '|'|'||'|'|&'|'&&'|';'|';;'|'&'|'('|'`') cmd=1 file=0 ;;
        ')') cmd=0 ;;
        *) file=1 ;;  # a redirection: the next word is a file name
      esac
    elif [[ $rest =~ $__kestrel_re_word ]]; then
      len=${#MATCH}
      w=$MATCH
      if (( file )); then
        file=0
      elif (( cmd )); then
        if [[ $w == [A-Za-z_]*=* && ${w%%=*} == [A-Za-z_][A-Za-z0-9_]# ]]; then
          : # VAR=value before a command: the command word comes next
        else
          w=${w#\\}
          f=0
          if (( $+reswords[$w] || $+aliases[$w] || $+functions[$w] || $+builtins[$w] || $+commands[$w] )); then
            f=1
          elif [[ $w == */* || $w == '~'* ]]; then
            p=${(Q)w}
            p=${p/#\~/$HOME}
            if [[ -x $p && ! -d $p ]] || [[ -o autocd && -d $p ]]; then f=1; fi
          fi
          (( f )) && style=fg=green || style=fg=red
          # After these words another command follows.
          case $w in
            sudo|doas|command|builtin|exec|nocorrect|noglob|nohup|time|env|if|then|else|elif|do|while|until|'!'|'{'|coproc) ;;
            *) cmd=0 ;;
          esac
        fi
      elif [[ $w == -?* ]]; then
        style=fg=cyan
      fi
    fi
    (( len == 0 )) && len=1
    if [[ -n $style ]]; then
      (( __kestrel_hl_memo )) && style+=,memo=kestrel
      out+=( "$pos $(( pos + len )) $style" )
    fi
    (( pos += len ))
    rest=${rest[len+1,-1]}
  done

  region_highlight+=( "${out[@]}" )
}

zle -N __kestrel_hl
add-zle-hook-widget zle-line-pre-redraw __kestrel_hl
