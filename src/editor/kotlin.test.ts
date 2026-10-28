import { getIndentation, indentUnit } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { kotlin, kotlinLanguage } from './kotlin';

/** Returns [text, token name] for every token that has a name. */
function tokens(code: string): [string, string][] {
  const tree = kotlinLanguage.parser.parse(code);
  const out: [string, string][] = [];
  tree.iterate({
    enter(node) {
      if (node.type.isTop) return;
      out.push([code.slice(node.from, node.to), node.name]);
    },
  });
  return out;
}

function nameOf(code: string, text: string, occurrence = 0): string | undefined {
  return tokens(code).filter(([t]) => t === text)[occurrence]?.[1];
}

describe('kotlin tokenizer: keywords', () => {
  it('splits hard keywords by role', () => {
    const code = 'package a.b\nimport x.Y\nclass A { fun f() { if (true) return } }';
    expect(nameOf(code, 'package')).toBe('moduleKeyword');
    expect(nameOf(code, 'import')).toBe('moduleKeyword');
    expect(nameOf(code, 'class')).toBe('definitionKeyword');
    expect(nameOf(code, 'fun')).toBe('definitionKeyword');
    expect(nameOf(code, 'if')).toBe('controlKeyword');
    expect(nameOf(code, 'return')).toBe('controlKeyword');
    expect(nameOf(code, 'true')).toBe('bool');
  });

  it('knows null, this and operator words', () => {
    const code = 'val x = if (a is B && c in d) null else this';
    expect(nameOf(code, 'null')).toBe('null');
    expect(nameOf(code, 'this')).toBe('self');
    expect(nameOf(code, 'is')).toBe('operatorKeyword');
    expect(nameOf(code, 'in')).toBe('operatorKeyword');
  });

  it('colors modifiers only before a declaration', () => {
    const code = 'private suspend fun load() {}\nval data = 1\nval x = data in list';
    expect(nameOf(code, 'private')).toBe('modifier');
    expect(nameOf(code, 'suspend')).toBe('modifier');
    expect(nameOf(code, 'data', 0)).toBe('variableName.definition');
    expect(nameOf(code, 'data', 1)).toBe('variableName');
  });

  it('handles data, sealed and enum class', () => {
    expect(nameOf('data class P(val x: Int)', 'data')).toBe('modifier');
    expect(nameOf('sealed interface S', 'sealed')).toBe('modifier');
    expect(nameOf('enum class E { A }', 'enum')).toBe('modifier');
    expect(nameOf('companion object { }', 'companion')).toBe('modifier');
  });

  it('does not treat members after a dot as keywords', () => {
    const code = 'map.get(key)\nlist.set(1, x)';
    expect(nameOf(code, 'get')).toBe('variableName.function');
    expect(nameOf(code, 'set')).toBe('variableName.function');
  });

  it('knows property accessors and init', () => {
    const code = 'class A {\n  var x = 1\n    private set\n  val y get() = 2\n  init { }\n}';
    expect(nameOf(code, 'set')).toBe('keyword');
    expect(nameOf(code, 'get')).toBe('keyword');
    expect(nameOf(code, 'init')).toBe('keyword');
  });
});

describe('kotlin tokenizer: names', () => {
  it('marks function names after fun', () => {
    expect(nameOf('fun hello(a: Int) {}', 'hello')).toBe('variableName.function.definition');
    expect(nameOf('fun String.shout() = 1', 'shout')).toBe('variableName.function.definition');
    expect(nameOf('fun <T> List<T>.second(): T = get(1)', 'second')).toBe('variableName.function.definition');
    expect(nameOf('inline fun <reified T> make() {}', 'reified')).toBe('modifier');
    expect(nameOf('inline fun <reified T> make() {}', 'make')).toBe('variableName.function.definition');
    expect(nameOf('fun `my test`() {}', '`my test`')).toBe('variableName.function.definition');
  });

  it('marks class, val and var definitions', () => {
    expect(nameOf('class Foo(val name: String)', 'Foo')).toBe('className.definition');
    expect(nameOf('interface Bar', 'Bar')).toBe('className.definition');
    expect(nameOf('object Baz', 'Baz')).toBe('className.definition');
    expect(nameOf('val count = 1', 'count')).toBe('variableName.definition');
    expect(nameOf('var total: Int = 0', 'total')).toBe('variableName.definition');
    expect(nameOf('val (a, b) = pair', 'a')).toBe('variableName.definition');
    expect(nameOf('val (a, b) = pair', 'pair')).toBe('variableName');
    expect(nameOf('val String.size: Int get() = 1', 'size')).toBe('variableName.definition');
  });

  it('marks types, constants, calls and properties', () => {
    const code = 'val m: Map<String, Int> = HashMap()\nconst val MAX_SIZE = 10\nprintln(x.length)';
    expect(nameOf(code, 'Map')).toBe('typeName');
    expect(nameOf(code, 'String')).toBe('typeName');
    expect(nameOf(code, 'HashMap')).toBe('className');
    expect(nameOf(code, 'MAX_SIZE')).toBe('variableName.definition');
    expect(nameOf('x = MAX_SIZE', 'MAX_SIZE')).toBe('variableName.constant');
    expect(nameOf(code, 'println')).toBe('variableName.function');
    expect(nameOf(code, 'length')).toBe('propertyName');
  });

  it('marks parameters and the lambda it', () => {
    expect(nameOf('fun f(name: String, age: Int) {}', 'name')).toBe('variableName.definition');
    expect(nameOf('fun f(name: String, age: Int) {}', 'age')).toBe('variableName.definition');
    expect(nameOf('list.map { it + 1 }', 'it')).toBe('variableName.special');
    expect(nameOf('list.forEach { x -> x }', 'forEach')).toBe('variableName.function');
  });

  it('marks generic angle brackets', () => {
    const code = 'val a: List<Map<String, Int>> = listOf<Int>()';
    const angles = tokens(code).filter(([, n]) => n === 'angleBracket').map(([t]) => t);
    expect(angles.join('')).toBe('<<>><>');
  });

  it('keeps comparison operators as operators', () => {
    const code = 'if (a < b && c > d) {}';
    expect(tokens(code).some(([, n]) => n === 'angleBracket')).toBe(false);
  });

  it('marks import paths', () => {
    const code = 'import kotlinx.coroutines.flow.Flow\nimport a.b.*';
    expect(nameOf(code, 'kotlinx')).toBe('namespace');
    expect(nameOf(code, 'flow')).toBe('namespace');
    expect(nameOf(code, 'Flow')).toBe('typeName');
  });
});

describe('kotlin tokenizer: annotations and labels', () => {
  it('marks annotations, including use-site targets', () => {
    expect(nameOf('@Test fun x() {}', '@Test')).toBe('annotation');
    expect(nameOf('@file:JvmName("A")', '@file:JvmName')).toBe('annotation');
    expect(nameOf('@get:Json(name = "x") val a = 1', '@get:Json')).toBe('annotation');
    expect(nameOf('@kotlin.jvm.JvmStatic fun x() {}', '@kotlin.jvm.JvmStatic')).toBe('annotation');
  });

  it('marks labels', () => {
    expect(nameOf('loop@ for (i in 1..3) {}', 'loop@')).toBe('labelName');
    expect(nameOf('list.forEach { return@forEach }', '@forEach')).toBe('labelName');
    expect(nameOf('this@Outer.x', '@Outer')).toBe('labelName');
    expect(nameOf('break@loop', '@loop')).toBe('labelName');
  });
});

describe('kotlin tokenizer: strings and chars', () => {
  it('marks escapes in normal strings', () => {
    const code = 'val s = "a\\n\\u0041\\"b"';
    // Neighbor tokens of the same type are merged into one node.
    expect(nameOf(code, '\\n\\u0041\\"')).toBe('escape');
  });

  it('marks $name and ${expr} templates', () => {
    const code = 'val s = "Hi $name, ${user.name.uppercase()}!"';
    expect(nameOf(code, '$name')).toBe('interpolation');
    expect(nameOf(code, '${')).toBe('interpolation');
    expect(nameOf(code, '}')).toBe('interpolation');
    expect(nameOf(code, 'uppercase')).toBe('variableName.function');
    expect(nameOf(code, '!"')).toBe('string');
  });

  it('handles braces and nested strings inside a template', () => {
    const code = 'val s = "a ${ mapOf("k" to { 1 }) } b" + c';
    expect(nameOf(code, 'mapOf')).toBe('variableName.function');
    expect(nameOf(code, 'c')).toBe('variableName');
    expect(tokens(code).filter(([t, n]) => t === '}' && n === 'interpolation').length).toBe(1);
  });

  it('handles raw strings over several lines with templates', () => {
    const code = 'val s = """\n  line $a\n  "quoted" ${b}\n"""\nval t = 1';
    const toks = tokens(code);
    expect(toks.find(([t]) => t === '$a')?.[1]).toBe('interpolation');
    expect(toks.find(([t]) => t === '${')?.[1]).toBe('interpolation');
    expect(toks.find(([t]) => t === 't')?.[1]).toBe('variableName.definition');
    // A backslash is plain text in a raw string.
    expect(nameOf('val s = """a\\nb"""', '\\n')).toBeUndefined();
  });

  it('marks char literals', () => {
    expect(nameOf("val c = 'a'", "'a'")).toBe('character');
    expect(nameOf("val c = '\\n'", "'\\n'")).toBe('character');
    expect(nameOf("val c = '\\u0041'", "'\\u0041'")).toBe('character');
  });

  it('does not run an unfinished string into the next line', () => {
    const code = 'val s = "oops\nval t = 1';
    expect(nameOf(code, 'val', 1)).toBe('definitionKeyword');
  });
});

describe('kotlin tokenizer: numbers', () => {
  it('reads kotlin number forms as one token', () => {
    for (const n of ['1_000_000', '0xFF_EC', '0b1010', '123L', '1.5f', '1e10', '2.5e-3', '10u', '0xFFUL', '.5']) {
      expect(nameOf(`val x = ${n}`, n), n).toBe('number');
    }
  });

  it('does not take the dot of a range or a call', () => {
    expect(nameOf('1..5', '1')).toBe('number');
    expect(nameOf('1..5', '5')).toBe('number');
    expect(nameOf('1.toString()', '1')).toBe('number');
    expect(nameOf('1.toString()', 'toString')).toBe('variableName.function');
  });
});

describe('kotlin tokenizer: comments', () => {
  it('handles nested block comments over lines', () => {
    const code = '/* a /* b */ still\n comment */ val x = 1';
    const toks = tokens(code);
    expect(toks[0][1]).toBe('blockComment');
    expect(toks.find(([t]) => t === 'val')?.[1]).toBe('definitionKeyword');
    expect(toks.find(([t]) => t === 'still')).toBeUndefined();
  });

  it('marks line comments', () => {
    expect(nameOf('val x = 1 // note', '// note')).toBe('lineComment');
  });

  it('marks KDoc and its tags', () => {
    const code = '/**\n * Does it.\n * @param x the value\n * @return nothing\n */\nfun f(x: Int) {}';
    const toks = tokens(code);
    expect(toks.find(([t]) => t === '@param')?.[1]).toBe('docTag');
    expect(toks.find(([t]) => t === '@return')?.[1]).toBe('docTag');
    expect(toks[0][1]).toBe('docComment');
    expect(toks.find(([t]) => t === 'f')?.[1]).toBe('variableName.function.definition');
  });

  it('treats an empty comment as a normal comment', () => {
    expect(tokens('/**/ val x = 1')[0][1]).toBe('blockComment');
  });
});

describe('kotlin indentation', () => {
  function indentAt(code: string, pos: number): number | null {
    const state = EditorState.create({ doc: code, extensions: [kotlin(), indentUnit.of('    ')] });
    return getIndentation(state, pos);
  }

  it('indents inside braces and parentheses', () => {
    const code = 'class A {\n    fun f(\n';
    expect(indentAt(code, code.length)).toBe(8);
    const code2 = 'class A {\n';
    expect(indentAt(code2, code2.length)).toBe(4);
  });

  it('puts a closing bracket at the indent of its opening line', () => {
    const code = 'class A {\n    fun f() {\n        x()\n    }';
    expect(indentAt(code, code.lastIndexOf('}'))).toBe(4);
  });

  it('keeps the previous indent at the top level', () => {
    expect(indentAt('val x = 1\n', 10)).toBeNull();
  });
});
