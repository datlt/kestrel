import { describe, expect, it } from 'vitest';
import { fenceLanguage, languageIdFor, LANGUAGES, resolveLanguageId } from './languages';

describe('languageIdFor', () => {
  const cases: [string, string][] = [
    ['/p/Main.kt', 'kotlin'],
    ['/p/build.gradle.kts', 'kotlin'],
    ['/p/settings.gradle.kts', 'kotlin'],
    ['/p/build.gradle', 'groovy'],
    ['/p/Jenkinsfile', 'groovy'],
    ['/p/A.java', 'java'],
    ['/p/a.js', 'javascript'],
    ['/p/a.mjs', 'javascript'],
    ['/p/a.ts', 'typescript'],
    ['/p/a.d.ts', 'typescript'],
    ['/p/a.jsx', 'jsx'],
    ['/p/a.tsx', 'tsx'],
    ['/p/a.py', 'python'],
    ['/p/index.html', 'html'],
    ['/p/a.css', 'css'],
    ['/p/a.scss', 'css'],
    ['/p/a.sql', 'sql'],
    ['/p/a.mysql', 'sql'],
    ['/p/package.json', 'json'],
    ['/p/.eslintrc', 'json'],
    ['/p/README.md', 'markdown'],
    ['/p/pom.xml', 'xml'],
    ['/p/logo.svg', 'xml'],
    ['/p/ci.yml', 'yaml'],
    ['/p/ci.yaml', 'yaml'],
    ['/p/lib.rs', 'rust'],
    ['/p/main.go', 'go'],
    ['/p/Sources/App/ViewModel.swift', 'swift'],
    ['/p/Package.swift', 'swift'],
    ['/p/a.cpp', 'cpp'],
    ['/p/a.h', 'cpp'],
    ['/p/run.sh', 'shell'],
    ['/p/Makefile', 'shell'],
    ['/p/.gitignore', 'shell'],
    ['/p/app.properties', 'properties'],
    ['/p/.env', 'properties'],
    ['/p/.env.local', 'properties'],
    ['/p/Cargo.toml', 'toml'],
    ['/p/Cargo.lock', 'toml'],
    ['/p/Dockerfile', 'dockerfile'],
    ['/p/Dockerfile.dev', 'dockerfile'],
    ['/p/app.dockerfile', 'dockerfile'],
    ['/p/a.patch', 'diff'],
    ['/p/notes.txt', 'plaintext'],
    ['/p/noext', 'plaintext'],
    ['C:\\work\\src\\Main.KT', 'kotlin'],
  ];
  for (const [path, id] of cases) {
    it(`${path} -> ${id}`, () => expect(languageIdFor(path)).toBe(id));
  }

  it('covers all ids of the spec', () => {
    const ids = new Set(LANGUAGES.map((l) => l.id));
    for (const id of [
      'kotlin', 'java', 'javascript', 'typescript', 'jsx', 'tsx', 'python', 'html', 'css', 'sql', 'json', 'markdown',
      'xml', 'yaml', 'rust', 'go', 'swift', 'cpp', 'shell', 'groovy', 'properties', 'toml', 'dockerfile', 'diff', 'plaintext',
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
  });
});

describe('aliases and code fences', () => {
  it('resolves aliases', () => {
    expect(resolveLanguageId('kt')).toBe('kotlin');
    expect(resolveLanguageId('JS')).toBe('javascript');
    expect(resolveLanguageId('py')).toBe('python');
    expect(resolveLanguageId('swift')).toBe('swift');
    expect(resolveLanguageId('ts')).toBe('typescript');
    expect(resolveLanguageId('yml')).toBe('yaml');
    expect(resolveLanguageId('nope')).toBeNull();
  });

  it('reads the language of a fence', () => {
    expect(fenceLanguage('kotlin')).toBe('kotlin');
    expect(fenceLanguage('js {1,3}')).toBe('javascript');
    expect(fenceLanguage('{.python}')).toBe('python');
    expect(fenceLanguage('language-bash')).toBe('shell');
    expect(fenceLanguage('')).toBeNull();
  });
});
