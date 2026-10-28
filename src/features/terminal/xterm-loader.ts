// Loads xterm and its add-ons the first time a terminal opens. They go into
// their own chunk, so the startup bundle stays small.

export interface XtermModules {
  Terminal: typeof import('@xterm/xterm').Terminal;
  FitAddon: typeof import('@xterm/addon-fit').FitAddon;
  WebglAddon: typeof import('@xterm/addon-webgl').WebglAddon;
  Unicode11Addon: typeof import('@xterm/addon-unicode11').Unicode11Addon;
  WebLinksAddon: typeof import('@xterm/addon-web-links').WebLinksAddon;
  SearchAddon: typeof import('@xterm/addon-search').SearchAddon;
}

let loading: Promise<XtermModules> | null = null;

/** The loaded code is cached for the whole page. It holds no per-workbench state. */
export function loadXterm(): Promise<XtermModules> {
  loading ??= Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/addon-webgl'),
    import('@xterm/addon-unicode11'),
    import('@xterm/addon-web-links'),
    import('@xterm/addon-search'),
    import('@xterm/xterm/css/xterm.css'),
  ]).then(([xterm, fit, webgl, unicode, links, search]) => ({
    Terminal: xterm.Terminal,
    FitAddon: fit.FitAddon,
    WebglAddon: webgl.WebglAddon,
    Unicode11Addon: unicode.Unicode11Addon,
    WebLinksAddon: links.WebLinksAddon,
    SearchAddon: search.SearchAddon,
  }));
  // After a failed load (for example no network in dev), the next terminal tries again.
  loading.catch(() => {
    loading = null;
  });
  return loading;
}
