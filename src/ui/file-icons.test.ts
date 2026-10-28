import { describe, expect, it } from 'vitest';
import { allIconIds, fileIconId } from './file-icons';

const id = (n: string): string => fileIconId(n, false);

describe('fileIconId files', () => {
  it('matches exact names first', () => {
    expect(id('build.gradle')).toBe('gradle');
    expect(id('build.gradle.kts')).toBe('gradle');
    expect(id('settings.gradle.kts')).toBe('gradle');
    expect(id('gradlew')).toBe('gradle');
    expect(id('gradle.properties')).toBe('gradle');
    expect(id('pom.xml')).toBe('maven');
    expect(id('package.json')).toBe('npm');
    expect(id('tsconfig.json')).toBe('tsconfig');
    expect(id('tsconfig.build.json')).toBe('tsconfig');
    expect(id('Dockerfile')).toBe('docker');
    expect(id('Dockerfile.dev')).toBe('docker');
    expect(id('docker-compose.yml')).toBe('compose');
    expect(id('compose.yaml')).toBe('compose');
    expect(id('Makefile')).toBe('make');
    expect(id('.editorconfig')).toBe('editorconfig');
  });

  it('ignores case for names', () => {
    expect(id('DOCKERFILE')).toBe('docker');
    expect(id('MAKEFILE')).toBe('make');
    expect(id('POM.XML')).toBe('maven');
    expect(id('README.MD')).toBe('readme');
  });

  it('uses the longest extension', () => {
    expect(id('types.d.ts')).toBe('dts');
    expect(id('app.gradle.kts')).toBe('gradle');
    expect(id('app.gradle')).toBe('gradle');
    expect(id('foo.test.ts')).toBe('test');
    expect(id('foo.spec.js')).toBe('test');
    expect(id('foo.test.tsx')).toBe('test');
    expect(id('foo.ts')).toBe('ts');
    expect(id('Main.kt')).toBe('kotlin');
    expect(id('x.min.js')).toBe('js');
    expect(id('.eslintrc.json')).toBe('json');
  });

  it('detects test files by name', () => {
    expect(id('FooTest.kt')).toBe('test');
    expect(id('FooTest.java')).toBe('test');
    expect(id('FooTests.java')).toBe('test');
    expect(id('test_foo.py')).toBe('test');
    expect(id('foo_test.go')).toBe('test');
    expect(id('Foo.kt')).toBe('kotlin');
    expect(id('Latest.java')).toBe('java');
  });

  it('maps languages', () => {
    const table: Record<string, string> = {
      'a.kt': 'kotlin', 'a.kts': 'kotlin', 'A.java': 'java', 'a.groovy': 'groovy', 'a.scala': 'scala',
      'a.js': 'js', 'a.mjs': 'js', 'a.cjs': 'js', 'a.ts': 'ts', 'a.mts': 'ts', 'a.cts': 'ts',
      'a.jsx': 'jsx', 'a.tsx': 'tsx', 'a.json': 'json', 'a.py': 'python', 'a.html': 'html',
      'a.css': 'css', 'a.scss': 'scss', 'a.less': 'less', 'a.sql': 'sql', 'a.md': 'markdown',
      'a.yml': 'yaml', 'a.yaml': 'yaml', 'a.xml': 'xml', 'a.toml': 'toml',
      'a.properties': 'properties', 'a.sh': 'shell', 'a.rs': 'rust', 'a.go': 'go', 'a.c': 'c',
      'a.cpp': 'cpp', 'a.h': 'header', 'a.hpp': 'header', 'a.cs': 'csharp', 'a.swift': 'swift',
      'a.php': 'php', 'a.rb': 'ruby', 'a.dart': 'dart', 'a.vue': 'vue', 'a.svelte': 'svelte',
      'a.csv': 'csv', 'a.tsv': 'tsv', 'a.log': 'log', 'a.txt': 'text',
    };
    for (const [name, want] of Object.entries(table)) expect(id(name), name).toBe(want);
  });

  it('maps media, archives and binaries', () => {
    for (const e of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif']) expect(id(`a.${e}`)).toBe('image');
    expect(id('a.svg')).toBe('svg');
    for (const e of ['ttf', 'otf', 'woff', 'woff2']) expect(id(`a.${e}`)).toBe('font');
    expect(id('a.pdf')).toBe('pdf');
    for (const e of ['zip', 'tar', 'gz', 'jar', 'war', '7z']) expect(id(`a.${e}`)).toBe('archive');
    expect(id('a.tar.gz')).toBe('archive');
    expect(id('a.exe')).toBe('binary');
    expect(id('a.class')).toBe('binary');
  });

  it('maps lock, git, env, readme and license', () => {
    for (const n of ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'foo.lock']) expect(id(n)).toBe('lock');
    for (const n of ['.gitignore', '.gitattributes', '.gitmodules']) expect(id(n)).toBe('git');
    for (const n of ['.env', '.env.local', '.env.production']) expect(id(n)).toBe('env');
    expect(id('README')).toBe('readme');
    expect(id('README.md')).toBe('readme');
    expect(id('readme.txt')).toBe('readme');
    expect(id('LICENSE')).toBe('license');
    expect(id('LICENSE.txt')).toBe('license');
    expect(id('Cargo.toml')).toBe('toml');
  });

  it('falls back to a default', () => {
    expect(id('noext')).toBe('file');
    expect(id('weird.zzz')).toBe('file');
    expect(id('')).toBe('file');
    expect(id('trailing.')).toBe('file');
    expect(id('.hidden')).toBe('file');
  });
});

describe('fileIconId folders', () => {
  it('uses default closed and open folders', () => {
    expect(fileIconId('foo', true)).toBe('folder');
    expect(fileIconId('foo', true, false)).toBe('folder');
    expect(fileIconId('foo', true, true)).toBe('folder-open');
  });

  it('maps special folders', () => {
    const table: Record<string, string> = {
      src: 'folder-src', main: 'folder-main', test: 'folder-test', tests: 'folder-test',
      __tests__: 'folder-test', java: 'folder-java', kotlin: 'folder-kotlin',
      resources: 'folder-resources', docs: 'folder-docs', scripts: 'folder-scripts',
      config: 'folder-config', assets: 'folder-assets', images: 'folder-assets', lib: 'folder-lib',
      public: 'folder-public', '.github': 'folder-github', '.git': 'folder-git',
      '.idea': 'folder-idea', '.vscode': 'folder-vscode', node_modules: 'folder-node-modules',
      build: 'folder-build', dist: 'folder-build', out: 'folder-build', target: 'folder-build',
    };
    for (const [name, want] of Object.entries(table)) {
      expect(fileIconId(name, true), name).toBe(want);
      expect(fileIconId(name, true, true), name).toBe(`${want}-open`);
    }
    expect(fileIconId('SRC', true)).toBe('folder-src');
  });

  it('does not use file rules for folders', () => {
    expect(fileIconId('build.gradle', true)).toBe('folder');
    expect(fileIconId('Dockerfile', true)).toBe('folder');
  });
});

describe('icon ids', () => {
  it('lists unique ids and covers every mapping result', () => {
    const ids = allIconIds();
    expect(new Set(ids).size).toBe(ids.length);
    for (const n of ['a.kt', 'a.d.ts', 'a.test.ts', 'Dockerfile', 'noext', 'a.exe', '.gitignore', 'LICENSE']) {
      expect(ids).toContain(fileIconId(n, false));
    }
    for (const n of ['src', 'foo', 'build']) {
      expect(ids).toContain(fileIconId(n, true));
      expect(ids).toContain(fileIconId(n, true, true));
    }
  });
});
