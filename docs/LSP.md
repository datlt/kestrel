# Language servers

Kestrel can start language servers (LSP) for Kotlin, Java, JavaScript and TypeScript.
A language server gives you errors, completion, hover, go to definition, references, rename and format.

Kestrel does not install servers. You install them yourself, then Kestrel finds them in your PATH.
If a server is missing, Kestrel shows a message once with an install hint.

## Kotlin

Server: `kotlin-lsp` from JetBrains. It needs Java 17 or newer.

macOS (Homebrew):

```sh
brew install JetBrains/utils/kotlin-lsp
```

This command adds the tap `JetBrains/utils` for you. You can also run `brew tap JetBrains/utils` first.

Check it:

```sh
kotlin-lsp --help
java -version
```

Kestrel starts it as `kotlin-lsp --stdio`. The project root is the nearest folder with `settings.gradle.kts`, `settings.gradle`, `build.gradle.kts`, `build.gradle` or `pom.xml`.

On Windows and Linux, download `kotlin-lsp` from the JetBrains release page and put the folder with the `kotlin-lsp` script in your PATH.

## Java

Server: Eclipse `jdtls`. It needs Java 21 or newer to run.

macOS (Homebrew):

```sh
brew install jdtls
```

Linux and Windows: download a build from the Eclipse JDT Language Server project, unpack it, and put a `jdtls` launcher script in your PATH.

Check it:

```sh
jdtls --help
java -version
```

Kestrel starts it as `jdtls`. It adds the `-data` folder itself. The data folder is inside the Kestrel cache folder, in `jdtls/<hash of the project root>`. The first start of a big project can take a minute.

The project root is the nearest folder with `settings.gradle.kts`, `settings.gradle`, `build.gradle.kts`, `build.gradle`, `pom.xml` or `.project`.

## JavaScript and TypeScript

Server: `typescript-language-server`. It needs Node.js and the `typescript` package.

```sh
npm install -g typescript typescript-language-server
```

Check it:

```sh
typescript-language-server --version
```

Kestrel starts it as `typescript-language-server --stdio` for the languages `javascript`, `typescript`, `jsx` and `tsx`. The project root is the nearest folder with `tsconfig.json`, `jsconfig.json` or `package.json`.

## Swift

Server: `sourcekit-lsp`. Xcode and the Swift toolchain from swift.org include it, so on a Mac with Xcode you do not need to install anything.

Check it:

```sh
sourcekit-lsp --help
```

Kestrel starts it as `sourcekit-lsp` for the language `swift`. The project root is the nearest folder with `Package.swift`, `buildServer.json`, `compile_commands.json` or `.sourcekit-lsp`, else the open folder.

For a Swift package (`Package.swift`) the server knows every file. For an Xcode project it only knows the file you edit, unless you set up a build server (for example `xcode-build-server`) and build the project once. Find Usages and the class diagram do not need the server: Kestrel reads the Swift files itself.

## The `lsp.servers` setting

Put this in `settings.json`. Your value replaces the whole default value of `lsp.servers`.
So when you set it, include every server you want, also the ones from the defaults.

Each key is a server id. Each value has these fields:

| Field | Type | Meaning |
|-------|------|---------|
| `command` | list of strings | The program and its arguments. The first item is the program. |
| `languages` | list of strings | Language ids that this server handles (for example `kotlin`, `java`, `typescript`). |
| `rootMarkers` | list of strings, optional | Files that mark a project root. Kestrel looks from the opened file upward. |
| `initializationOptions` | any JSON, optional | Sent to the server as `initializationOptions`. |
| `env` | object, optional | More environment variables for the server process. |
| `enabled` | true or false, optional | Set `false` to turn off one server. |

Default value:

```jsonc
"lsp.servers": {
  "kotlin": {
    "command": ["kotlin-lsp", "--stdio"],
    "languages": ["kotlin"],
    "rootMarkers": ["settings.gradle.kts", "settings.gradle", "build.gradle.kts", "build.gradle", "pom.xml"]
  },
  "java": {
    "command": ["jdtls"],
    "languages": ["java"],
    "rootMarkers": ["settings.gradle.kts", "settings.gradle", "build.gradle.kts", "build.gradle", "pom.xml", ".project"]
  },
  "swift": {
    "command": ["sourcekit-lsp"],
    "languages": ["swift"],
    "rootMarkers": ["Package.swift", "buildServer.json", "compile_commands.json", ".sourcekit-lsp"]
  },
  "typescript": {
    "command": ["typescript-language-server", "--stdio"],
    "languages": ["javascript", "typescript", "jsx", "tsx"],
    "rootMarkers": ["tsconfig.json", "jsconfig.json", "package.json"]
  }
}
```

Example: use a full path and a specific Java version for `jdtls`, and keep the other servers:

```jsonc
"lsp.servers": {
  "kotlin": {
    "command": ["kotlin-lsp", "--stdio"],
    "languages": ["kotlin"],
    "rootMarkers": ["settings.gradle.kts", "build.gradle.kts", "pom.xml"]
  },
  "java": {
    "command": ["/opt/jdtls/bin/jdtls"],
    "languages": ["java"],
    "rootMarkers": ["pom.xml", "build.gradle", ".project"],
    "env": { "JAVA_HOME": "/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home" }
  },
  "typescript": {
    "command": ["typescript-language-server", "--stdio"],
    "languages": ["javascript", "typescript", "jsx", "tsx"],
    "rootMarkers": ["tsconfig.json", "package.json"],
    "enabled": false
  }
}
```

To turn off all language servers, set `"lsp.enabled": false`.

## PATH when you start Kestrel from the Dock

On macOS and Linux, an app that starts from the Dock or a desktop launcher does not get the PATH from your shell profile (`~/.zshrc`, `~/.profile`). Tools from Homebrew, SDKMAN or nvm would not be found.

Kestrel handles this. At startup it runs your login shell once, reads the environment, and uses it for every program it starts (git and language servers). On Windows the app already has your full PATH.

If a server is still not found:

- Make sure the PATH is set in a file that your login shell reads. For zsh this is `~/.zprofile` or `~/.zshenv`. Some people only set it in `~/.zshrc`, and the login shell may not read that file in the same way.
- Use a full path in `command`, for example `["/opt/homebrew/bin/jdtls"]`.
- Start Kestrel from a terminal. It then inherits the PATH of the terminal.

Java: the server needs the right Java version. Set `JAVA_HOME` in your shell profile, or in the `env` field of the server.

## Troubleshooting

Open the bottom panel with Mod-j and choose the Output tab (`lsp-output`). It shows the messages that each server writes to stderr. Kestrel also keeps the last lines of each server in memory.

The status bar item on the left (`lsp.status`) shows the state of the server for the current file.

| Problem | What to check |
|---------|---------------|
| "Server not found" message | Run the program in a terminal. Check the PATH. Use a full path in `command`. |
| Server starts and stops at once | Read the Output panel. Often the Java version is too old (Kotlin needs 17, jdtls needs 21). |
| No errors or completion | Check that the file language is right (status bar), that `lsp.enabled` is `true`, and that the server `enabled` is not `false`. |
| Wrong project root | Add the right file to `rootMarkers`. For Gradle projects the root needs a `settings.gradle(.kts)` or `build.gradle(.kts)`. |
| Java project is slow at first start | `jdtls` imports the project once. Wait for it. The next starts are faster. |
| Big files have no LSP | Files bigger than `editor.largeFileMB` (8 MB by default) open in plain mode. |
| Server is stuck | Run the command `lsp.restart` from the command palette. |
| Changed `settings.json` has no effect | Save the file. Kestrel reloads it after you save. Then run `lsp.restart`. |
