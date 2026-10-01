import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShell } from '../../src/core/shell.ts';

const argvs = (s: string) => parseShell(s).commands.map((c) => c.words.map((w) => w.text));

test('分隔符、管道与引号', () => {
  assert.deepEqual(argvs(`a 1 && b "x y" | c 'q;r' ; d\ne`), [['a', '1'], ['b', 'x y'], ['c', 'q;r'], ['d'], ['e']]);
  assert.deepEqual(argvs(`echo a\\ b "c\\"d"`), [['echo', 'a b', 'c"d']]);
  assert.deepEqual(argvs('ls # 注释 ; rm x'), [['ls']]);
});

test('重定向：目标、fd 复制、here-string', () => {
  const c = parseShell('echo x >out 2>>err.log &>all <in 2>&1 >&2 <<<"s" >| f').commands[0]!;
  assert.deepEqual(c.words.map((w) => w.text), ['echo', 'x']);
  assert.deepEqual(c.redirects.map((r) => [r.op, r.target.text]), [
    ['>', 'out'], ['>>', 'err.log'], ['&>', 'all'], ['<', 'in'], ['>&', '1'], ['>&', '2'], ['<<<', 's'], ['>|', 'f'],
  ]);
  assert.equal(c.redirects[4]!.fdDup, true);
});

test('命令替换与进程替换被递归解析', () => {
  const r = parseShell('echo "$(rm -rf a)" `mv b c` $(cat <(cp d e))');
  const names = r.commands.map((c) => c.words[0]?.text);
  assert.ok(names.includes('rm') && names.includes('mv') && names.includes('cat') && names.includes('cp'), names.join());
  assert.equal(r.commands.find((c) => c.words[0]?.text === 'echo')!.words[1]!.dynamic, true);
});

test('变量与 heredoc', () => {
  const r = parseShell('F=.flow; echo $F ${F}/x\ncat <<EOF > out\n$(rm z)\nEOF\ncat <<\'Q\'\n$(rm y)\nQ\necho done');
  const names = r.commands.map((c) => c.words[0]?.text);
  assert.ok(names.includes('rm'), '未加引号的 heredoc 中的命令替换应被解析');
  assert.equal(r.commands.filter((c) => c.words[0]?.text === 'rm').length, 1, '加引号的 heredoc 不展开');
  assert.equal(r.commands[0]!.assignments.length, 1);
  assert.equal(r.commands[1]!.words[1]!.dynamic, true);
  assert.ok(names.includes('echo'));
  assert.deepEqual(r.errors, []);
});

test('无法解析时返回错误', () => {
  assert.ok(parseShell('echo "abc').errors.length > 0);
  assert.ok(parseShell('echo $(ls').errors.length > 0);
  assert.ok(parseShell("echo 'x").errors.length > 0);
});

test('子 shell 与分组', () => {
  assert.deepEqual(argvs('(cd a && ls) ; { pwd; }'), [['cd', 'a'], ['ls'], ['pwd']]);
});
