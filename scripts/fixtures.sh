#!/usr/bin/env bash
# Makes a test workspace for manual and performance tests of Kestrel.
#
# Usage: scripts/fixtures.sh <dir>
#
# The folder <dir> is created. If it already has files from an earlier run,
# the script stops. Delete the folder first, or pass FORCE=1 to remove it.
# It needs bash, python3 and git. It runs on macOS and Linux.

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <dir>" >&2
  exit 2
fi
command -v python3 >/dev/null || { echo "python3 is needed" >&2; exit 1; }
command -v git >/dev/null || { echo "git is needed" >&2; exit 1; }

mkdir -p "$1"
DIR="$(cd "$1" && pwd)"
if [ -n "$(ls -A "$DIR")" ]; then
  if [ "${FORCE:-0}" = "1" ]; then
    # Safety: only remove a folder that an earlier run of this script made.
    [ -f "$DIR/.kestrel-fixtures" ] || { echo "$DIR is not a fixtures folder; not removing it" >&2; exit 1; }
    rm -rf "${DIR:?}"/* "$DIR"/.kestrel-fixtures "$DIR"/.git 2>/dev/null || true
  else
    echo "$DIR is not empty. Use an empty folder or run with FORCE=1." >&2
    exit 1
  fi
fi
touch "$DIR/.kestrel-fixtures"

SECONDS=0
step() { printf '%-28s %3ss\n' "$1" "$SECONDS"; }

mkdir -p "$DIR"/{highlight,encoding,big,markdown,html-page,many-files,repo}

# ---------------------------------------------------------------- highlight
cat > "$DIR/highlight/Sample.kt" <<'EOF'
@file:JvmName("Sample")
@file:Suppress("unused")

package dev.kestrel.sample

import kotlin.math.max as maximum
import kotlinx.coroutines.*

/**
 * KDoc comment for [Greeter].
 * @param name the name to greet
 */
@Target(AnnotationTarget.CLASS, AnnotationTarget.FUNCTION)
annotation class Marker(val value: String = "x")

/* A block comment /* with a nested comment */ still inside */
@Marker("greeter")
data class Greeter<T : CharSequence>(val name: T, var times: Int = 1_000) {
    val big = 0xFF_EC_DE_5EL
    val bin = 0b1010_1010
    val ratio = 1.5e-3f
    val unsigned = 42u
    val ch = '\n'
    val quote = '\''

    fun greet(): String = "Hello, $name! You have ${times * 2} messages, ${"nested $name"}."

    suspend fun load(): List<String> = coroutineScope {
        val raw = """
            Raw string with $name and ${name.length}
            and a "quote" and a \n that stays.
        """.trimIndent()
        listOf(raw)
    }

    inline fun <reified R> convert(value: Any?): R? = value as? R
}

sealed interface Shape {
    object Unit : Shape
    class Circle(val r: Double) : Shape
}

fun main(args: Array<String>) = runBlocking {
    val g = Greeter("Kestrel")
    println(g.greet())
    when (val s: Shape = Shape.Circle(2.0)) {
        is Shape.Circle -> println(maximum(1, s.r.toInt()))
        else -> Unit
    }
    @Suppress("UNCHECKED_CAST")
    val list = listOf(1, 2, 3) as List<Int>
    for (i in 0 until list.size step 2) if (i > 0) continue
}
EOF
cat > "$DIR/highlight/Sample.java" <<'EOF'
package dev.kestrel.sample;

import java.util.*;
import java.util.stream.Collectors;

/**
 * Javadoc for {@link Sample}.
 * @author kestrel
 */
@FunctionalInterface
interface Greeter { String greet(String name); }

@SuppressWarnings({"unchecked", "rawtypes"})
public class Sample<T extends Comparable<T>> implements Greeter {
    private static final int MAX = 0x7fff_ffff;
    private final Map<String, List<T>> items = new HashMap<>();
    // line comment
    public enum Kind { A, B, C }

    public record Point(int x, int y) {}

    @Override
    public String greet(String name) {
        var text = """
            Hello, %s!
              Text block "with quotes".
            """.formatted(name);
        return text.strip();
    }

    public static void main(String[] args) throws Exception {
        Greeter g = n -> "Hi " + n;
        long big = 1_000_000L;
        char c = 'A';
        Object o = new Point(1, 2);
        if (o instanceof Point(int x, int y) && x < y) {
            System.out.println(g.greet("x=" + x));
        }
        String joined = List.of(1, 2, 3).stream().map(String::valueOf).collect(Collectors.joining(","));
        switch (Kind.A) { case A -> System.out.println(joined); default -> {} }
    }
}
EOF
cat > "$DIR/highlight/sample.js" <<'EOF'
// @ts-check
import { readFile } from 'node:fs/promises';

/** @param {string} path */
export async function load(path) {
  const text = await readFile(path, 'utf8');
  return text.split(/\r?\n/).filter(Boolean);
}

class Counter {
  #count = 0;
  static from(n) { const c = new Counter(); c.#count = n; return c; }
  get value() { return this.#count; }
  inc = () => ++this.#count;
}

const name = 'Kestrel', n = 0xff + 1_000 + 1e3, big = 10n ** 20n;
const tpl = `Hello ${name}, ${n > 1 ? `many ${n}` : 'one'}!`;
const re = /ab+c/gi.test('xabbc');
const { a = 1, ...rest } = { a: undefined, b: 2, c: 3 };
label: for (const [k, v] of Object.entries(rest)) {
  if (v == null) continue label;
  console.log(k, v ?? 'none', tpl, re);
}
new Promise((resolve) => setTimeout(resolve, 10)).then(() => Counter.from(3).inc());
EOF
cat > "$DIR/highlight/sample.ts" <<'EOF'
import type { Readable } from 'node:stream';

export interface User<T = unknown> {
  readonly id: number;
  name: string;
  meta?: Record<string, T>;
}

type Keys<T> = { [K in keyof T]-?: T[K] extends Function ? never : K }[keyof T];
type Pair = [first: string, second?: number, ...rest: boolean[]];

enum Color { Red = 'RED', Green = 'GREEN' }

abstract class Repo<T extends { id: number }> {
  protected items = new Map<number, T>();
  abstract validate(item: T): item is T;
  add(item: T): this {
    if (!this.validate(item)) throw new Error(`bad item ${item.id}`);
    this.items.set(item.id, item);
    return this;
  }
}

@Component({ selector: 'app-x' })
class Widget {
  @Input() label!: string;
  constructor(private readonly repo: Repo<User>, public x = 1) {}
}

export function assertNever(x: never): never {
  throw new Error(`unexpected: ${x as string}`);
}

declare module 'foo' { export const bar: number; }
const u = { id: 1, name: 'a' } satisfies User;
const el = document.querySelector<HTMLInputElement>('#x')!;
function pipe<A, B>(a: A, f: (a: A) => B): B { return f(a); }
export default pipe(u, (x) => x.name.length as number);
EOF
cat > "$DIR/highlight/sample.py" <<'EOF'
#!/usr/bin/env python3
"""Module docstring."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Generic, TypeVar

T = TypeVar("T")


@dataclass(frozen=True)
class Box(Generic[T]):
    value: T
    tags: list[str] = field(default_factory=list)

    def map(self, fn: "Callable[[T], T]") -> Box[T]:
        return Box(fn(self.value), self.tags)


def fib(n: int, /, *, memo: dict[int, int] | None = None) -> int:
    memo = {} if memo is None else memo
    if n < 2:
        return n
    return memo.setdefault(n, fib(n - 1, memo=memo) + fib(n - 2, memo=memo))


async def main(name: str = "Kestrel") -> None:
    print(f"Hello, {name!r:>10} {fib(10):04d} {{literal}}")
    raw = rb"\d+" + b"\x00"
    lam = lambda x, *a, **k: x ** 2 // 3  # comment
    async with asyncio.timeout(1):
        async for i in agen():
            match i:
                case 1 | 2:
                    pass
                case [x, *rest] if x > 0:
                    print(rest, raw, lam)
                case _:
                    ...


if __name__ == "__main__":
    asyncio.run(main())
EOF
cat > "$DIR/highlight/sample.html" <<'EOF'
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Highlight sample</title>
  <style>
    :root { --accent: #3b82f6; }
    body { font: 16px/1.5 system-ui, sans-serif; margin: 2rem; }
    .card:hover > .title::after { content: "\2192"; color: var(--accent); }
    @media (max-width: 600px) { .card { display: none; } }
  </style>
</head>
<body>
  <!-- a comment -->
  <main id="app" class="card" data-x='1' hidden>
    <h1 class="title">Hello &amp; welcome</h1>
    <img src="logo.png" alt="Logo"><br>
    <button onclick="greet('Kestrel')" disabled>Click</button>
  </main>
  <script type="module">
    const greet = (name) => alert(`Hello ${name}`);
    document.getElementById('app').addEventListener('click', () => greet('x'));
  </script>
</body>
</html>
EOF
cat > "$DIR/highlight/sample.sql" <<'EOF'
-- Sample SQL
CREATE TABLE IF NOT EXISTS users (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  email VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  score DECIMAL(10, 2) CHECK (score >= 0)
);

/* Block comment */
WITH recent AS (
  SELECT u.id, u.email, COUNT(o.id) AS orders
  FROM users u
  LEFT JOIN orders o ON o.user_id = u.id AND o.status IN ('paid', 'shipped')
  WHERE u.created_at > NOW() - INTERVAL 30 DAY
  GROUP BY u.id, u.email
  HAVING COUNT(o.id) > 0
)
SELECT r.*, ROW_NUMBER() OVER (PARTITION BY r.orders ORDER BY r.id DESC) AS rn
FROM recent r
ORDER BY r.orders DESC
LIMIT 10 OFFSET 5;

UPDATE users SET score = score + 1.5 WHERE email LIKE '%@example.com' AND id <> 0;
INSERT INTO users (email) VALUES ('it''s@example.com'), ("quoted@example.com");
DELETE FROM users WHERE id = 42;
EOF
step "highlight samples"

# ----------------------------------------------------------------- markdown
python3 - "$DIR/markdown" <<'PYEOF'
import struct, sys, zlib, os
d = sys.argv[1]
# A small 64x64 PNG (a blue to green gradient), made with zlib only.
w = h = 64
raw = b''.join(b'\x00' + b''.join(bytes((30, 80 + x * 2, 200 - y * 2)) for x in range(w)) for y in range(h))
def chunk(t, data):
    c = struct.pack('>I', len(data)) + t + data
    return c + struct.pack('>I', zlib.crc32(t + data) & 0xffffffff)
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
open(os.path.join(d, 'image.png'), 'wb').write(png)
PYEOF
cat > "$DIR/markdown/gfm.md" <<'EOF'
---
title: GFM feature test
tags: [markdown, sample]
draft: false
---

# Heading 1 {#custom-id}

## Heading 2

### Heading 3 with `code`

#### Heading 4

##### Heading 5

###### Heading 6

Setext heading
==============

Another setext
--------------

Plain text with **bold**, *italic*, ***both***, ~~strikethrough~~, `inline code`,
a [link](https://example.com "Title"), an autolink https://example.com, <https://example.org>,
an email <me@example.com>, and a hard break at the end of this line.  
This is the next line. Escaped \*stars\* and an emoji :tada: and a footnote.[^1]

> A block quote.
>
> > Nested quote with a list:
> > - one
> > - two

> [!NOTE]
> Useful information that users should know.

> [!TIP]
> Helpful advice.

> [!IMPORTANT]
> Key information.

> [!WARNING]
> Urgent info that needs attention.

> [!CAUTION]
> Negative potential consequences.

## Lists

- Item A
  - Nested item
    - Deeper item
- Item B

1. First
2. Second
   1. Sub one
   2. Sub two
3. Third

- [x] Done task
- [ ] Open task
- [ ] Another open task

## Table

| Left | Center | Right |
|:-----|:------:|------:|
| a    |   b    |     c |
| `x`  | **y**  |  [z](#) |
| 日本語 | 한국어 | emoji 🎉 |

## Images

Local image:

![A gradient](image.png "Local gradient")

Remote image: ![badge](https://img.shields.io/badge/kestrel-test-blue)

## Rule

---

## HTML

<details>
<summary>Click to open</summary>

Hidden **markdown** inside details.

</details>

<p align="center"><kbd>Ctrl</kbd> + <kbd>C</kbd> and H<sub>2</sub>O and x<sup>2</sup></p>

## Math-like and special text

Dollar signs $5 and $10, a snake_case_word, and 2 * 3 * 4.

## Code blocks

```kotlin
data class User(val name: String)
fun main() = println("Hello, ${User("Kestrel").name}")
```

```java
public class Main { public static void main(String[] a) { System.out.println("hi"); } }
```

```javascript
const add = (a, b) => a + b;
console.log(add(1, 2));
```

```typescript
const add = (a: number, b: number): number => a + b;
```

```python
def add(a, b):
    return a + b
```

```html
<div class="x">Hello</div>
```

```sql
SELECT * FROM users WHERE id = 1;
```

```json
{ "a": [1, 2, 3], "b": null }
```

```rust
fn main() { println!("hi"); }
```

```diff
- old line
+ new line
```

```
plain block without a language
```

    indented code block

## Footnotes

Here is a second footnote.[^note]

[^1]: The first footnote text.
[^note]: A longer footnote.

    With a second paragraph.

## Reference links

[Kestrel][repo] and [Tauri][tauri].

[repo]: https://example.com/kestrel
[tauri]: https://tauri.app

Term with a definition list is not GFM, so it stays as text.
EOF
cat > "$DIR/markdown/README.md" <<'EOF'
# Fixtures

Short Markdown file. See [gfm.md](gfm.md) for all features.
EOF
step "markdown"

# ---------------------------------------------------------------- html page
cat > "$DIR/html-page/index.html" <<'EOF'
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Kestrel HTML preview test</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header><h1>HTML preview test</h1></header>
  <main>
    <p id="status">Scripts are off.</p>
    <img src="../markdown/image.png" alt="gradient" width="64">
    <button id="btn">Run script</button>
    <ul id="list"></ul>
  </main>
  <script src="app.js"></script>
  <script>
    document.getElementById('status').textContent = 'Inline script ran.';
  </script>
</body>
</html>
EOF
cat > "$DIR/html-page/style.css" <<'EOF'
:root { --bg: #f5f5f7; --fg: #1d1d1f; --accent: #0a84ff; }
@media (prefers-color-scheme: dark) { :root { --bg: #1c1c1e; --fg: #f5f5f7; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
header { padding: 1rem 2rem; border-bottom: 1px solid color-mix(in srgb, var(--fg) 20%, transparent); }
main { padding: 2rem; display: grid; gap: 1rem; max-width: 40rem; }
button { background: var(--accent); color: #fff; border: 0; border-radius: 6px; padding: .5rem 1rem; cursor: pointer; }
#list li:nth-child(odd) { opacity: .7; }
EOF
cat > "$DIR/html-page/app.js" <<'EOF'
document.getElementById('btn').addEventListener('click', () => {
  const li = document.createElement('li');
  li.textContent = 'Clicked at ' + new Date().toISOString();
  document.getElementById('list').appendChild(li);
});
EOF
step "html page"

# ----------------------------------------------------------------- encoding
python3 - "$DIR/encoding" <<'PYEOF'
import os, sys
d = sys.argv[1]
def w(name, data): open(os.path.join(d, name), 'wb').write(data)
text = "Line one\nLine two with text\nLast line\n"
w('utf8-bom.txt', b'\xef\xbb\xbf' + "UTF-8 with BOM: café, 日本語, 한국어\nsecond line\n".encode('utf-8'))
w('utf8.txt', "UTF-8 without BOM: café, 日本語, 한국어, emoji 🎉\nsecond line\n".encode('utf-8'))
w('utf16le-bom.txt', b'\xff\xfe' + "UTF-16LE with BOM: café, 日本語\r\nsecond line\r\n".encode('utf-16-le'))
w('utf16be-bom.txt', b'\xfe\xff' + "UTF-16BE with BOM: café, 日本語\nsecond line\n".encode('utf-16-be'))
sjis = "Shift_JIS のテキストです。\nこんにちは、世界。日本語の文章がここにあります。\nプログラミング言語 Kotlin と Java。\n" * 5
w('shift_jis.txt', sjis.encode('shift_jis'))
euckr = "EUC-KR 텍스트입니다.\n안녕하세요, 세계. 한국어 문장이 여기에 있습니다.\n프로그래밍 언어 코틀린과 자바.\n" * 5
w('euc-kr.txt', euckr.encode('euc-kr'))
w('latin1.txt', "Latin-1: café, naïve, über, señor\n".encode('latin-1') * 3)
w('crlf.txt', b'one\r\ntwo\r\nthree\r\n')
w('lf.txt', b'one\ntwo\nthree\n')
w('cr-only.txt', b'one\rtwo\rthree\r')
w('mixed-eol.txt', b'crlf line\r\nlf line\nanother lf\nanother crlf\r\ncr line\rlast line without newline')
w('empty.txt', b'')
w('no-final-newline.txt', b'no newline at the end')
w('trailing-ws.txt', b'trailing spaces   \nand tabs\t\t\nclean\n')
w('long-line.txt', (b'x' * 200000) + b'\n' + b'short\n')
w('spaces and unicode é日本.txt', b'file name with spaces and non-ASCII characters\n')
PYEOF
step "encoding samples"

# --------------------------------------------------------------------- big
python3 - "$DIR/big" <<'PYEOF'
import os, random, sys, time
d = sys.argv[1]
random.seed(1)
# 20 MB log file.
levels = ['INFO', 'DEBUG', 'WARN', 'ERROR']
msgs = ['request handled', 'cache miss for key', 'connection reset by peer', 'slow query detected',
        'user logged in', 'job finished', 'retrying after failure', 'file saved']
target = 20 * 1024 * 1024
size = 0
with open(os.path.join(d, 'app.log'), 'w', buffering=1 << 20) as f:
    n = 0
    base = 1700000000
    while size < target:
        n += 1
        t = time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(base + n // 7))
        line = f"{t}.{n % 1000:03d} {random.choice(levels):5} [worker-{n % 16:02d}] com.example.Service{n % 40} - {random.choice(msgs)} id={random.getrandbits(48):012x} took={random.randint(1, 900)}ms\n"
        f.write(line)
        size += len(line)
# 200k-line Kotlin file.
with open(os.path.join(d, 'Big.kt'), 'w', buffering=1 << 20) as f:
    f.write('package dev.kestrel.big\n\n')
    lines = 2
    i = 0
    while lines < 200000:
        block = f'''/** Doc for Item{i}. */
@Suppress("unused")
data class Item{i}(val id: Int = {i}, val name: String = "item-{i}") {{
    fun describe(prefix: String): String = "$prefix ${{name}} #$id"

    fun compute(x: Int): Int {{
        val raw = """raw $x"""
        return x * {i % 97 + 1} + raw.length // comment {i}
    }}
}}

'''
        f.write(block)
        lines += block.count('\n')
        i += 1
    f.write('fun main() = println("done")\n')
# Binary file (has NUL bytes).
random.seed(2)
with open(os.path.join(d, 'data.bin'), 'wb') as f:
    f.write(b'\x7fELF\x00\x00\x00' + bytes(random.getrandbits(8) for _ in range(256 * 1024)))
PYEOF
step "big files"

# --------------------------------------------------------------- many files
python3 - "$DIR/many-files" <<'PYEOF'
import os, sys
d = sys.argv[1]
exts = ['kt', 'java', 'ts', 'js', 'py', 'md', 'json', 'txt']
count = 0
for a in range(20):
    for b in range(10):
        sub = os.path.join(d, f'group{a:02d}', f'module{b:02d}')
        os.makedirs(sub)
        for c in range(100):
            ext = exts[(a + b + c) % len(exts)]
            with open(os.path.join(sub, f'File{c:03d}.{ext}'), 'w') as f:
                f.write(f'// file {a}/{b}/{c}\n')
            count += 1
print(count, 'files', file=sys.stderr)
PYEOF
step "many files (20k)"

# --------------------------------------------------------------- git repo
(
  cd "$DIR/repo"
  export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
  export GIT_AUTHOR_NAME="Kestrel Test" GIT_AUTHOR_EMAIL="test@example.com"
  export GIT_COMMITTER_NAME="Kestrel Test" GIT_COMMITTER_EMAIL="test@example.com"
  g() { git -c core.autocrlf=false -c commit.gpgsign=false "$@"; }
  g init -q -b main .
  mkdir -p src docs
  printf 'line 1\nline 2\nline 3\nline 4\nline 5\n' > src/app.txt
  printf 'to be renamed\nwith some content\nthat stays the same\nso git sees a rename\n' > src/old-name.txt
  printf 'shared\nconflict base\nend\n' > src/conflict.txt
  printf 'will be deleted\n' > src/gone.txt
  printf '# Repo\n' > docs/README.md
  printf 'unstaged\nstart\n' > src/unstaged.txt
  printf 'build/\n*.tmp\n' > .gitignore
  g add -A && g commit -q -m "Initial commit"
  printf 'line 1\nline 2 changed on main\nline 3\nline 4\nline 5\n' > src/app.txt
  g commit -q -am "Change app.txt on main"
  g branch feature
  printf 'shared\nconflict from main\nend\n' > src/conflict.txt
  g commit -q -am "Change conflict.txt on main"
  g checkout -q feature
  printf 'shared\nconflict from feature\nend\n' > src/conflict.txt
  printf 'feature file\n' > src/feature.txt
  g add -A && g commit -q -m "Feature work"
  printf 'more feature\n' >> src/feature.txt
  g commit -q -am "More feature work"
  g checkout -q main
  printf 'main only\n' > docs/main-only.md
  g add -A && g commit -q -m "Main only change"
  # Conflict: merge feature into main.
  g merge feature >/dev/null 2>&1 || true
  # Rename (staged).
  g mv src/old-name.txt src/new-name.txt
  # Staged new file and staged edit.
  printf 'staged new file\n' > src/staged-new.txt
  g add src/staged-new.txt
  printf 'line 1\nline 2 changed on main\nline 3 staged edit\nline 4\nline 5\n' > src/app.txt
  g add src/app.txt
  # Unstaged edit on top of the staged edit, and another unstaged file.
  printf 'line 1\nline 2 changed on main\nline 3 staged edit\nline 4 unstaged edit\nline 5\nline 6 unstaged add\n' > src/app.txt
  printf 'unstaged\nstart\nunstaged edit\n' > src/unstaged.txt
  # Unstaged delete.
  rm src/gone.txt
  # Untracked files and an ignored file.
  printf 'untracked\n' > src/untracked.txt
  mkdir -p scratch && printf 'in untracked folder\n' > scratch/note.txt
  mkdir -p build && printf 'ignored\n' > build/out.tmp
)
step "git repo"

echo
echo "Fixtures are ready in $DIR"
echo "Open the folder for the tree and search tests. Open $DIR/repo for the Git view."
echo
echo "Sizes:"
du -sh "$DIR"/* 2>/dev/null | sed "s|$DIR/||" | awk '{printf "  %-8s %s\n", $1, $2}'
echo "  files in many-files: $(find "$DIR/many-files" -type f | wc -l | tr -d ' ')"
echo "  lines in big/Big.kt: $(wc -l < "$DIR/big/Big.kt" | tr -d ' ')"
echo "  bytes in big/app.log: $(wc -c < "$DIR/big/app.log" | tr -d ' ')"
echo "Total time: ${SECONDS}s"
