# Kestrel shell integration. Kestrel rewrites this file, so do not edit it.
# An interactive shell reads this file after /etc/zshrc. It runs your own .zshrc,
# loads the command line colors, and gives ZDOTDIR back to you.
if [[ -n $KESTREL_ZDOTDIR ]]; then
  typeset -g __kestrel_dir=${KESTREL_USER_ZDOTDIR:-$HOME}
  # /etc/zshrc on macOS sets HISTFILE from ZDOTDIR, which is the Kestrel folder
  # now. Point it to your own folder, so the history stays where you expect it.
  [[ -n $HISTFILE && $HISTFILE == "$KESTREL_ZDOTDIR"/* ]] && HISTFILE=$__kestrel_dir/${HISTFILE:t}
  if [[ -r $__kestrel_dir/.zshrc ]]; then
    ZDOTDIR=$__kestrel_dir
    builtin . "$__kestrel_dir/.zshrc"
    [[ $ZDOTDIR != $__kestrel_dir ]] && KESTREL_USER_ZDOTDIR=$ZDOTDIR
  fi
  # Load the colors after your .zshrc, so we can see if you use your own highlighter.
  if [[ -n $KESTREL_HIGHLIGHT && -r $KESTREL_ZDOTDIR/kestrel-highlight.zsh ]]; then
    builtin . "$KESTREL_ZDOTDIR/kestrel-highlight.zsh"
  fi
  # Give ZDOTDIR back. zsh reads .zlogin from there. Without a ZDOTDIR of your own, remove it.
  if [[ -n $KESTREL_USER_ZDOTDIR ]]; then
    ZDOTDIR=$KESTREL_USER_ZDOTDIR
  else
    unset ZDOTDIR
  fi
  unset __kestrel_dir KESTREL_ZDOTDIR KESTREL_USER_ZDOTDIR KESTREL_HIGHLIGHT
fi
