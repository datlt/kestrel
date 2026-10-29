// GitHub-like styles for the markdown frame. Colors come from the theme
// variables that `themeCss()` copies into the frame.

export const MARKDOWN_CSS = `
html{background:var(--bg);color:var(--fg);}
body{margin:0;padding:0;background:var(--bg);color:var(--fg);font-family:var(--font-ui);font-size:15px;line-height:1.6;word-wrap:break-word;-webkit-font-smoothing:antialiased;}
::selection{background:var(--selection);}
::-webkit-scrollbar{width:12px;height:12px;}
::-webkit-scrollbar-thumb{background:var(--scrollbar);border-radius:6px;border:3px solid transparent;background-clip:content-box;}
::-webkit-scrollbar-corner{background:transparent;}
#md{max-width:900px;margin:0 auto;padding:24px 32px 80px;}
#md>*:first-child{margin-top:0;}
#md a{color:var(--accent);text-decoration:none;}
#md a:hover{text-decoration:underline;}
#md a.wikilink-missing{opacity:.65;text-decoration:underline dashed;}
#md .wikilink-embed > a::before{content:'\\21AA  ';}
#md a.anchor{display:inline-block;width:0;height:0;overflow:hidden;}
#md h1,#md h2,#md h3,#md h4,#md h5,#md h6{margin:24px 0 16px;font-weight:600;line-height:1.25;}
#md h1{font-size:2em;padding-bottom:.3em;border-bottom:1px solid var(--border);}
#md h2{font-size:1.5em;padding-bottom:.3em;border-bottom:1px solid var(--border);}
#md h3{font-size:1.25em;}
#md h4{font-size:1em;}
#md h5{font-size:.875em;}
#md h6{font-size:.85em;color:var(--fg-muted);}
#md p,#md blockquote,#md ul,#md ol,#md dl,#md table,#md pre,#md details,#md .markdown-alert{margin:0 0 16px;}
#md ul,#md ol{padding-left:2em;}
#md li+li{margin-top:.25em;}
#md li>p{margin-top:16px;}
#md ul.contains-task-list{list-style:none;padding-left:1.6em;}
#md .task-list-item input{margin:0 .5em .25em -1.4em;vertical-align:middle;}
#md dt{font-weight:600;margin-top:16px;}
#md dd{margin:0 0 16px;padding:0 16px;}
#md blockquote{padding:0 1em;color:var(--fg-muted);border-left:.25em solid var(--border);}
#md blockquote>:last-child{margin-bottom:0;}
#md hr{height:.25em;padding:0;margin:24px 0;background:var(--border);border:0;}
#md img,#md video{max-width:100%;height:auto;}
#md code,#md kbd,#md samp{font-family:var(--font-mono);font-size:85%;}
#md :not(pre)>code{padding:.2em .4em;background:var(--bg-alt);border-radius:6px;}
#md kbd{padding:3px 5px;background:var(--bg-alt);border:1px solid var(--border);border-bottom-width:2px;border-radius:6px;}
#md pre{padding:16px;overflow:auto;font-size:85%;line-height:1.45;background:var(--bg-alt);border:1px solid var(--border);border-radius:6px;}
#md pre code{padding:0;background:transparent;font-size:100%;white-space:pre;}
#md table{display:block;width:max-content;max-width:100%;overflow:auto;border-spacing:0;border-collapse:collapse;}
#md table th,#md table td{padding:6px 13px;border:1px solid var(--border);}
#md table th{font-weight:600;}
#md table tr:nth-child(2n){background:var(--bg-alt);}
#md table.front-matter{font-size:.9em;color:var(--fg-muted);}
#md table.front-matter th{text-align:left;}
#md details>summary{cursor:pointer;}
#md .markdown-alert{padding:4px 16px;border-left:.25em solid var(--alert,var(--border));}
#md .markdown-alert>:last-child{margin-bottom:0;}
#md .markdown-alert-title{display:flex;align-items:center;margin:8px 0 !important;font-weight:600;color:var(--alert,var(--fg));}
#md .markdown-alert-note{--alert:var(--info);}
#md .markdown-alert-tip{--alert:var(--ok);}
#md .markdown-alert-important{--alert:#a371f7;}
#md .markdown-alert-warning{--alert:var(--warn);}
#md .markdown-alert-caution{--alert:var(--danger);}
#md .footnotes{margin-top:32px;padding-top:8px;border-top:1px solid var(--border);font-size:.875em;color:var(--fg-muted);}
#md sup.footnote-ref a{padding:0 2px;}
#md .footnote-backref{margin-left:4px;}
#md mark{background:var(--selection);color:inherit;}
`;
