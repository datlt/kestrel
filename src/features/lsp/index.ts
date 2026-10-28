// LSP feature (docs/DESIGN.md, section 7.6). Kotlin, Java and JS/TS language servers
// run as child processes in Rust. The protocol work is done by `@codemirror/lsp-client`,
// which loads lazily when the first matching file opens.
import type { AppContext, FileEditor, StatusItem } from "../../core/types";
import "./lsp.css";
import { LspManager } from "./manager";
import { createOutputView } from "./output";
import { createProblemsView } from "./problems";
import type { Session } from "./session";

const STATUS_ID = "lsp.status";

function statusText(s: Session): string {
  switch (s.state) {
    case "starting":
      return `LSP ${s.serverId}: starting...`;
    case "ready":
      return `LSP ${s.serverId}: ready`;
    case "stopped":
      return `LSP ${s.serverId}: stopped`;
    default:
      return s.missing
        ? `LSP ${s.serverId}: not installed`
        : `LSP ${s.serverId}: error`;
  }
}

export function initLsp(ctx: AppContext): void {
  const manager = new LspManager(ctx);

  ctx.editors.registerExtension(async (editor) => {
    try {
      return await manager.extensionFor(editor);
    } catch (e) {
      console.error("[lsp] cannot attach to", editor.path, e);
      return null;
    }
  });

  // Servers send hover text with links. A normal click would load the page inside
  // the app window. Open web links in the system browser and ignore all others.
  const onLinkClick = (e: MouseEvent) => {
    // Every workbench has this listener. Only the visible one handles the click.
    if (!ctx.window.isActive()) return;
    const a = (e.target as Element | null)?.closest?.(".cm-tooltip a[href]");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (!/^(https?|mailto):/i.test(href)) return;
    import("@tauri-apps/plugin-opener")
      .then((m) => m.openUrl(href))
      .catch((err) =>
        ctx.ui.notify(
          `Cannot open link: ${err instanceof Error ? err.message : String(err)}`,
          { kind: "error" },
        ),
      );
  };
  document.addEventListener("click", onLinkClick, true);

  ctx.views.register(createProblemsView(ctx, manager.diagnostics));
  ctx.views.register(createOutputView(manager));

  // --- status bar ---
  const updateStatus = () => {
    const editor = ctx.editors.active();
    const session = editor && manager.sessionOfPath(editor.path);
    if (!session) {
      ctx.status.remove(STATUS_ID);
      return;
    }
    const { errors, warnings } = manager.diagnostics.counts();
    const lines = [`${session.serverId} server`, `Folder: ${session.root}`];
    if (session.message) lines.push(session.message);
    if (session.state === "ready")
      lines.push(`${errors} errors, ${warnings} warnings`);
    lines.push("Click to show the output.");
    const item: StatusItem = {
      id: STATUS_ID,
      align: "left",
      priority: 50,
      text: statusText(session),
      tooltip: lines.join("\n"),
      command: "lsp.showOutput",
    };
    ctx.status.set(item);
  };
  manager.onChange(updateStatus);
  manager.diagnostics.onChange(updateStatus);
  ctx.bus.on("tab:activated", updateStatus);

  // --- lifecycle ---
  ctx.bus.on("file:closed", ({ path }) => manager.fileClosed(path));
  ctx.bus.on("workspace:will-change", () => {
    void manager.stopAll();
  });
  ctx.bus.on("workbench:disposing", () => {
    document.removeEventListener("click", onLinkClick, true);
    ctx.status.remove(STATUS_ID);
    void manager.stopAll();
    manager.dispose();
  });
  ctx.bus.on("settings:changed", ({ settings, previous }) => {
    if (settings["lsp.enabled"] !== previous["lsp.enabled"]) {
      if (!settings["lsp.enabled"]) {
        void manager.stopAll();
      } else {
        ctx.ui.notify(
          "Language servers are on. Reopen your files to start them.",
        );
      }
      return;
    }
    if (
      JSON.stringify(settings["lsp.servers"]) !==
        JSON.stringify(previous["lsp.servers"]) &&
      manager.list().length
    ) {
      ctx.ui.notify(
        "The language server settings changed. Restart the servers to use them.",
        {
          actions: [{ label: "Restart", run: () => void manager.restartAll() }],
        },
      );
    }
  });

  // --- commands ---
  const lspEditor = (): FileEditor | null => {
    const editor = ctx.editors.active();
    return editor && manager.sessionOfPath(editor.path) ? editor : null;
  };
  const inEditor =
    (
      run: (
        rt: NonNullable<typeof manager.loaded>,
        editor: FileEditor,
      ) => unknown,
    ) =>
    () => {
      const editor = lspEditor();
      const rt = manager.loaded;
      if (editor && rt) run(rt, editor);
    };
  const category = "LSP";
  ctx.commands.registerMany([
    {
      id: "lsp.gotoDefinition",
      title: "Go to Definition",
      category,
      keybinding: "F12",
      when: () => !!lspEditor(),
      run: inEditor((rt, e) => rt.actions.gotoDefinition(e.view)),
    },
    {
      id: "lsp.findReferences",
      title: "Find References",
      category,
      keybinding: "Shift-F12",
      when: () => !!lspEditor(),
      run: inEditor((rt, e) => rt.actions.findReferences(e.view, ctx)),
    },
    {
      id: "lsp.rename",
      title: "Rename Symbol",
      category,
      keybinding: "F2",
      when: () => !!lspEditor(),
      run: inEditor((rt, e) => rt.actions.rename(e.view, ctx)),
    },
    {
      id: "lsp.format",
      title: "Format Document",
      category,
      keybinding: "Shift-Alt-f",
      when: () => !!lspEditor(),
      run: inEditor((rt, e) => rt.actions.format(e.view)),
    },
    {
      id: "lsp.workspaceSymbols",
      title: "Go to Symbol in Workspace",
      category,
      keybinding: "Mod-t",
      run: () => {
        const session = manager.currentSession();
        const rt = manager.loaded;
        if (!session || !rt) {
          ctx.ui.notify(
            "No language server is running. Open a Kotlin, Java, JavaScript or TypeScript file first.",
          );
          return;
        }
        if (session.state === "error" || session.state === "stopped") {
          ctx.ui.notify(
            `The ${session.serverId} server is not running. Use "LSP: Restart Language Server".`,
            { kind: "warn" },
          );
          return;
        }
        rt.actions.workspaceSymbols(session.client, ctx);
      },
    },
    {
      id: "lsp.restart",
      title: "Restart Language Server",
      category,
      run: async () => {
        const editor = ctx.editors.active();
        const own = editor && manager.sessionOfPath(editor.path);
        if (own) await manager.restart(own);
        else if (manager.list().length) await manager.restartAll();
        else ctx.ui.notify("No language server is running.");
      },
    },
    {
      id: "lsp.showOutput",
      title: "Show Language Server Output",
      category,
      run: () => ctx.views.show("lsp-output"),
    },
    {
      id: "lsp.showProblems",
      title: "Show Problems",
      category,
      run: () => ctx.views.show("problems"),
    },
  ]);
}
