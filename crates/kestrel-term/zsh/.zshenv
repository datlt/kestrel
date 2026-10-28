# Kestrel shell integration. Kestrel rewrites this file, so do not edit it.
# zsh reads this file first because Kestrel set ZDOTDIR to this folder.
# The next lines run your own .zshenv, then put ZDOTDIR back to this folder.
if [[ -n $KESTREL_ZDOTDIR ]]; then
  typeset -g __kestrel_dir=${KESTREL_USER_ZDOTDIR:-$HOME}
  if [[ -r $__kestrel_dir/.zshenv ]]; then
    ZDOTDIR=$__kestrel_dir
    builtin . "$__kestrel_dir/.zshenv"
    # Your .zshenv can set ZDOTDIR itself. Then the other files come from there.
    [[ $ZDOTDIR != $__kestrel_dir ]] && KESTREL_USER_ZDOTDIR=$ZDOTDIR
    ZDOTDIR=$KESTREL_ZDOTDIR
  fi
  unset __kestrel_dir
fi
