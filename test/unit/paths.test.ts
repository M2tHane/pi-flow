import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globsOverlap, globWithin, matchesAny, normalizeRelPath, isProtected } from '../../src/core/paths.ts';

test('globsOverlap：目录嵌套与通配', () => {
  assert.equal(globsOverlap('src/server/**', 'src/server/export/**'), true);
  assert.equal(globsOverlap('src/server/**', 'src/web/**'), false);
  assert.equal(globsOverlap('src/web/*.css', 'src/web/*.ts'), false);
  assert.equal(globsOverlap('src/web/*.ts', 'src/web/a.ts'), true);
  assert.equal(globsOverlap('src/**/x.ts', 'src/a/b/x.ts'), true);
  assert.equal(globsOverlap('src/**/x.ts', 'src/a/b/y.ts'), false);
  assert.equal(globsOverlap('package.json', 'package.json'), true);
  assert.equal(globsOverlap('tsconfig*.json', 'tsconfig.base.json'), true);
  assert.equal(globsOverlap('src/{db,server}/**', 'src/server/a.ts'), true);
  assert.equal(globsOverlap('src/{db,web}/**', 'src/server/a.ts'), false);
});

test('globWithin：任务 writes 不得越出 scope', () => {
  assert.equal(globWithin('src/server/export/**', 'src/server/**'), true);
  assert.equal(globWithin('src/server/a.ts', 'src/server/**'), true);
  assert.equal(globWithin('src/**', 'src/server/**'), false);
  assert.equal(globWithin('src/*/x.ts', 'src/server/**'), false);
  assert.equal(globWithin('src/web/**', 'src/server/**'), false);
});

test('normalizeRelPath：消除 .. 并拒绝越出根目录', () => {
  assert.equal(normalizeRelPath('/repo', 'src/../src/a.ts'), 'src/a.ts');
  assert.equal(normalizeRelPath('/repo', '/repo/src/a.ts'), 'src/a.ts');
  assert.equal(normalizeRelPath('/repo', './a/./b'), 'a/b');
  assert.equal(normalizeRelPath('/repo', '../etc/passwd'), null);
  assert.equal(normalizeRelPath('/repo', '/etc/passwd'), null);
});

test('matchesAny 与受保护路径', () => {
  assert.equal(matchesAny('src/server/a.ts', ['src/server/**']), true);
  assert.equal(matchesAny('.flow/state.json', ['src/**']), false);
  assert.equal(isProtected('.flow/state.json'), true);
  assert.equal(isProtected('.git/HEAD'), true);
  assert.equal(isProtected('workflow.yaml'), true);
  assert.equal(isProtected('rules/backend.md'), true);
  assert.equal(isProtected('.pi/settings.json'), true);
  assert.equal(isProtected('docs/interfaces/a.md'), false);
  assert.equal(isProtected('src/a.ts'), false);
});
