# Kestrel shell integration. Kestrel rewrites this file, so do not edit it.
# zsh reads this file only when ZDOTDIR still points here (the .zshrc of Kestrel
# gives ZDOTDIR back, so this is rare). It runs your own .zlogin.
if [[ -n $KESTREL_ZDOTDIR ]]; then
  typeset -g __kestrel_dir=${KESTREL_USER_ZDOTDIR:-$HOME}
  if [[ -r $__kestrel_dir/.zlogin ]]; then
    ZDOTDIR=$__kestrel_dir
    builtin . "$__kestrel_dir/.zlogin"
    [[ $ZDOTDIR != $__kestrel_dir ]] && KESTREL_USER_ZDOTDIR=$ZDOTDIR
  fi
  if [[ -n $KESTREL_USER_ZDOTDIR ]]; then ZDOTDIR=$KESTREL_USER_ZDOTDIR; else unset ZDOTDIR; fi
  unset __kestrel_dir KESTREL_ZDOTDIR KESTREL_USER_ZDOTDIR KESTREL_HIGHLIGHT
fi
