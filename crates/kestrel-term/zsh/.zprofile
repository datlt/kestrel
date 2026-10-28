# Kestrel shell integration. Kestrel rewrites this file, so do not edit it.
# A login shell reads this file after .zshenv. It runs your own .zprofile.
if [[ -n $KESTREL_ZDOTDIR ]]; then
  typeset -g __kestrel_dir=${KESTREL_USER_ZDOTDIR:-$HOME}
  if [[ -r $__kestrel_dir/.zprofile ]]; then
    ZDOTDIR=$__kestrel_dir
    builtin . "$__kestrel_dir/.zprofile"
    [[ $ZDOTDIR != $__kestrel_dir ]] && KESTREL_USER_ZDOTDIR=$ZDOTDIR
    ZDOTDIR=$KESTREL_ZDOTDIR
  fi
  unset __kestrel_dir
fi
