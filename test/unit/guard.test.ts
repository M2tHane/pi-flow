import { test, before, after } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkToolCall, type GuardContext, type GuardDecision } from '../../src/core/guard.ts';
import { parseConfig } from '../../src/core/config.ts';
import { TEST_YAML } from '../helpers/config.ts';

// 额外加一个可写 ** 的角色，用来验证受保护路径对"任何 writes"都只读
const YAML = TEST_YAML
  .replace('infra:      {', 'everything: { writes: ["**"] }\n  infra:      {')
  // chaos：可写 **；reviewer、scout：只读角色（bash 只读白名单），用来验证只读角色的约束
  + '  chaos:             { model: medium, scopes: [everything], tools: [read, find, grep, write, edit, bash, "@serena_edit"] }\n'
  + '  reviewer:          { model: medium, scopes: [], tools: [codemode, read, bash_readonly, "@serena_read", "@codegraph"], writes: [] }\n'
  + '  scout:             { model: cheap,  scopes: [], tools: [codemode, read, bash_readonly, "@serena_read", "@codegraph", flow_note, flow_submit], writes: [] }\n';
const config = parseConfig(YAML);

let base: string, main: string, wt: string;
before(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'pi-flow-guard-')));
  main = path.join(base, 'proj');
  wt = path.join(base, 'proj.worktrees', 'B-001-T-001');
  for (const root of [main, wt]) {
    for (const d of ['.flow', 'src/server', 'src/web', 'docs/contracts', 'secrets', 'config']) mkdirSync(path.join(root, d), { recursive: true });
    writeFileSync(path.join(root, '.env'), 'KEY=1');
    writeFileSync(path.join(root, 'src/server/a.ts'), '');
  }
  symlinkSync(path.join(wt, '.flow'), path.join(wt, 'src/server/evil'));
  symlinkSync(path.join(main, 'src'), path.join(wt, 'src/server/mainlink'));
});
after(() => rmSync(base, { recursive: true, force: true }));

const ctx = (role: string, over: Partial<GuardContext> = {}): GuardContext => {
  const inMain = role === 'orchestrator';
  return { config, role, cwd: inMain ? main : wt, workspaceRoot: inMain ? main : wt, mainRoot: main, ...over };
};
const call = (toolName: string, input: Record<string, unknown>) => ({ toolName, input });
const bash = (command: string) => call('bash', { command });

function blocked(d: GuardDecision, rule?: string, re?: RegExp) {
  assert.equal(d.allow, false, '应被阻断');
  if (d.allow) return;
  if (rule) assert.equal(d.rule, rule, d.reason);
  if (re) assert.match(d.reason, re);
}
function allowed(d: GuardDecision) {
  assert.equal(d.allow, true, d.allow ? '' : `${d.rule}: ${d.reason}`);
}

test('orchestrator：写、编辑、bash、serena 编辑、审批全部被阻断，reason 含指引', () => {
  const c = ctx('orchestrator', { readyTaskId: 'T-003' });
  for (const d of [
    checkToolCall(call('write', { path: 'src/a.ts', content: 'x' }), c),
    checkToolCall(call('edit', { path: 'docs/PRD.md', edits: [] }), c),
    checkToolCall(bash('echo x > .flow/state.json'), c),
    checkToolCall(bash("sed -i 's/a/b/' src/a.ts"), c),
    checkToolCall(call('serena_replace_symbol_body', { relative_path: 'src/a.ts' }), c),
    checkToolCall(call('flow_approve', { decision: 'pass' }), c),
    checkToolCall(call('powershell', { command: 'ls' }), c),
  ]) blocked(d, 'tool_whitelist', /你是调度者，不能直接修改代码。请调用 flow_dispatch\(T-003\) 交给对应 subagent。/);
});

test('orchestrator：read 只能读 docs 与 .flow', () => {
  const c = ctx('orchestrator');
  allowed(checkToolCall(call('read', { path: 'docs/PRD.md' }), c));
  allowed(checkToolCall(call('read', { path: '.flow/state.json' }), c));
  allowed(checkToolCall(call('flow_status', {}), c));
  blocked(checkToolCall(call('read', { path: 'src/server/a.ts' }), c), 'read_paths', /调度者.*flow_wait/);
  blocked(checkToolCall(call('read', { path: '../proj/src/server/a.ts' }), c), 'read_paths');
});

test('reviewer：任何写入都被阻断', () => {
  const c = ctx('reviewer');
  blocked(checkToolCall(call('write', { path: 'src/server/a.ts', content: '' }), c), 'tool_whitelist', /只读/);
  blocked(checkToolCall(call('edit', { path: 'src/server/a.ts', edits: [] }), c), 'tool_whitelist');
  blocked(checkToolCall(call('serena_replace_content', { relative_path: 'x' }), c), 'tool_whitelist');
  for (const cmd of ['echo x > a.txt', "sed -i 's/a/b/' src/server/a.ts", 'npm test', 'find . -name x -delete', 'git checkout main',
    'sort -o out.txt in.txt', 'rm src/server/a.ts', 'touch x', 'git stash', 'tee x', 'awk \'{print > "f"}\' a']) {
    blocked(checkToolCall(bash(cmd), c), 'bash', undefined);
  }
});

test('reviewer：只读命令放行', () => {
  const c = ctx('reviewer');
  for (const cmd of ['git diff main...HEAD', 'git log --oneline -5', 'cat src/server/a.ts | grep -n x', 'ls -la 2>/dev/null',
    'rg foo src', 'find src -name "*.ts"', 'wc -l src/server/a.ts && head -20 src/server/a.ts', 'cd src && ls']) {
    allowed(checkToolCall(bash(cmd), c));
  }
  allowed(checkToolCall(call('read', { path: 'src/server/a.ts' }), c));
  allowed(checkToolCall(call('serena_find_symbol', { name_path: 'X', relative_path: 'src/server' }), c));
});

test('实施角色：writes 白名单', () => {
  const c = ctx('backend-engineer', { writes: ['src/server/**'] });
  allowed(checkToolCall(call('write', { path: 'src/server/new.ts', content: '' }), c));
  allowed(checkToolCall(call('write', { path: '@src/server/new.ts', content: '' }), c));
  allowed(checkToolCall(call('edit', { path: path.join(wt, 'src/server/a.ts'), edits: [] }), c));
  allowed(checkToolCall(call('serena_replace_symbol_body', { relative_path: 'src/server/a.ts', body: '' }), c));
  blocked(checkToolCall(call('write', { path: 'src/web/x.ts', content: '' }), c), 'write_paths', /src\/server\/\*\*/);
  blocked(checkToolCall(call('write', { path: 'src/server/../web/x.ts', content: '' }), c), 'write_paths');
  blocked(checkToolCall(call('write', { path: '/tmp/x.ts', content: '' }), c), 'write_paths', /worktree/);
  blocked(checkToolCall(call('write', { path: path.join(main, 'src/server/a.ts'), content: '' }), c), 'write_paths', /主工作区/);
  blocked(checkToolCall(call('write', { path: 'src/server/mainlink/x.ts', content: '' }), c), 'write_paths', /主工作区/);
  blocked(checkToolCall(call('serena_replace_symbol_body', { relative_path: 'src/web/a.ts' }), c), 'write_paths');
  blocked(checkToolCall(call('serena_replace_symbol_body', { body: 'x' }), c), 'write_paths', /无法确定/);
  // 任务 writes 比角色 writes 窄时以任务为准
  const narrow = ctx('backend-engineer', { writes: ['src/server/export/**'] });
  blocked(checkToolCall(call('write', { path: 'src/server/a.ts', content: '' }), narrow), 'write_paths');
  // merge-fix 以冲突文件为准
  const mf = ctx('backend-engineer', { writes: ['src/server/a.ts'] });
  allowed(checkToolCall(call('edit', { path: 'src/server/a.ts', edits: [] }), mf));
  blocked(checkToolCall(call('edit', { path: 'src/server/b.ts', edits: [] }), mf), 'write_paths');
});

test('受保护路径对所有角色只读（即使 writes 覆盖）', () => {
  const c = ctx('chaos');
  for (const p of ['.flow/state.json', '.git/config', 'workflow.yaml', 'rules/backend.md', '.pi/settings.json',
    '.FLOW/state.json', 'src/server/evil/state.json', '@.flow/x', `file://${wt}/.flow/x`]) {
    blocked(checkToolCall(call('write', { path: p, content: '' }), c), 'protected', /只读/);
  }
  blocked(checkToolCall(call('serena_replace_content', { relative_path: '.flow/tasks/T-001.json' }), c), 'protected');
  allowed(checkToolCall(call('write', { path: 'docs/contracts/api.ts', content: '' }), c));
  allowed(checkToolCall(call('write', { path: 'anything/else.ts', content: '' }), c));
});

const IMPL_BLOCKED = [
  'echo x > .flow/state.json',
  'echo x >> .flow/events.jsonl',
  'cd .flow && echo x > state.json',
  'F=.flow; echo x > $F/state.json',
  'echo x > "$(echo .flow)/s"',
  'tee .flow/x < /dev/null',
  "sed -i 's/a/b/' src/server/a.ts",
  "sed -Ei 's/a/b/' src/server/a.ts",
  "perl -pi -e 's/a/b/' src/server/a.ts",
  'cp a b',
  'rm -rf src',
  'rm -rf .scratchtest',
  'mv src/server/a.ts docs/a.ts',
  'rm src/server/*.ts',
  'cd /tmp && ls',
  'git reset --hard HEAD~1',
  'git rebase main',
  'git push --force',
  'git push origin HEAD',
  'git checkout main',
  'git checkout -b x -- a',
  'git checkout main dev -- a',
  'git switch -c x',
  'git filter-branch --tree-filter x',
  'git commit --amend -m x',
  'git -C ../.. commit -am x',
  'git config core.hooksPath /tmp',
  'cd /tmp',
  'cd ..',
  'cd',
  'curl https://example.com',
  'wget x',
  'ssh host',
  'bash -c "rm x"',
  'sh -c \'echo > .flow/x\'',
  'eval "rm x"',
  'echo $(rm x)',
  'echo `mv a b`',
  'find . -name "*.ts" -delete',
  'find . -exec rm {} \;',
  'ls | xargs rm',
  'env FOO=1 rm x',
  'sudo rm x',
  'nohup rm x &',
  'cat <<EOF > .flow/x\nhi\nEOF',
  'echo x > ../../proj/src/a.ts',
  'echo "unterminated',
  '$CMD src',
];

test('实施角色：bash 约束（对抗用例）', () => {
  const c = ctx('backend-engineer', { writes: ['src/server/**'] });
  for (const cmd of IMPL_BLOCKED) {
    const d = checkToolCall(bash(cmd), c);
    assert.equal(d.allow, false, `应阻断：${cmd}`);
  }
});

test('实施角色：正常命令放行', () => {
  const c = ctx('backend-engineer', { writes: ['src/server/**'] });
  for (const cmd of ['pnpm test', 'pnpm typecheck > /tmp/tc.log 2>&1', 'git status && git diff', 'git add -A && git commit -m "feat: x"',
    'git checkout -- src/server/a.ts', 'git checkout abc123 -- src/server/a.ts', 'git rm -q src/server/a.ts', 'cd src/server && ls', 'echo x > src/server/out.txt', 'node -e "console.log(1)"',
    'ls *', 'grep -rn TODO src', 'FOO=1 pnpm test', 'cat <<EOF\nhello\nEOF']) {
    allowed(checkToolCall(bash(cmd), c));
  }
});

test('临时目录：实施角色可以 cd、写入、rm、mv；worktree 中只能对 writes 内的文件 rm、mv；只读角色不能进临时目录', () => {
  const scratch = path.join(base, 'scratch-r1');
  mkdirSync(scratch, { recursive: true });
  const c = ctx('backend-engineer', { writes: ['src/server/**'], scratchDir: scratch });
  for (const cmd of [`cd ${scratch} && mkdir -p a && echo x > a/b.js && node a/b.js`, `rm -rf ${scratch}/a`, `mv ${scratch}/x ${scratch}/y`,
    `cp src/server/a.ts ${scratch}/a.ts`, 'mv src/server/a.ts src/server/b.ts', 'rm src/server/a.ts', 'rm -f src/server/x.ts']) {
    allowed(checkToolCall(bash(cmd), c));
  }
  allowed(checkToolCall(call('write', { path: path.join(scratch, 'n.js'), content: 'x' }), c));
  blocked(checkToolCall(bash('rm -rf .scratchtest'), c), 'bash', /临时目录/);
  blocked(checkToolCall(bash('cd /tmp'), c), 'bash', /临时目录/);
  const r = ctx('reviewer', { scratchDir: scratch });
  blocked(checkToolCall(bash(`cd ${scratch}`), r), 'bash');
});

test('敏感读取对所有角色阻断', () => {
  for (const role of ['backend-engineer', 'reviewer', 'architect', 'scout']) {
    const c = ctx(role, { writes: undefined });
    for (const p of ['.env', 'config/.env.local', 'key.pem', 'secrets/db.json', '.ENV']) {
      blocked(checkToolCall(call('read', { path: p }), c), 'sensitive', /敏感/);
    }
  }
  const ch = ctx('chaos');
  blocked(checkToolCall(call('find', { pattern: '.env*' }), ch), 'sensitive');
  blocked(checkToolCall(call('grep', { pattern: 'KEY', glob: '*.pem' }), ch), 'sensitive');
  blocked(checkToolCall(call('grep', { pattern: 'KEY', path: 'secrets' }), ch), 'sensitive');
  allowed(checkToolCall(call('find', { pattern: '*.ts' }), ch));
  allowed(checkToolCall(call('grep', { pattern: 'KEY', path: 'src' }), ch));
  const be = ctx('backend-engineer');
  for (const cmd of ['cat .env', 'cat .e*', 'cat < .env', 'grep KEY config/.env.local', 'printenv', 'env', 'head secrets/x', 'source .env']) {
    blocked(checkToolCall(bash(cmd), be), 'sensitive');
  }
  blocked(checkToolCall(bash('cat .env'), ctx('reviewer')), 'sensitive');
  blocked(checkToolCall(call('serena_search_for_pattern', { relative_path: '.env' }), ctx('reviewer')), 'sensitive');
});

test('不在白名单的工具被阻断，reason 带角色提示', () => {
  blocked(checkToolCall(call('flow_propose_tasks', { tasks: [] }), ctx('backend-engineer')), 'tool_whitelist', /backend-engineer/);
  blocked(checkToolCall(call('web_search', { query: 'x' }), ctx('backend-engineer')), 'tool_whitelist');
  allowed(checkToolCall(call('web_search', { query: 'x' }), ctx('researcher')));
  blocked(checkToolCall(call('bash', { command: 'ls' }), ctx('researcher')), 'tool_whitelist');
  blocked(checkToolCall(call('unknown_tool', {}), ctx('architect')), 'tool_whitelist');
});

test('worktree 中未被 git 跟踪的临时文件可以删除；被跟踪的 writes 之外的文件不能删', () => {
  const repo = mkdtempSync(path.join(base, 'repo-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  g('init', '-q');
  mkdirSync(path.join(repo, 'docs'), { recursive: true });
  writeFileSync(path.join(repo, 'docs/a.md'), 'x');
  g('add', '.');
  g('-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'init');
  mkdirSync(path.join(repo, '.tmpcheck'), { recursive: true });
  writeFileSync(path.join(repo, '.tmpcheck/x.js'), 'x');
  const c = { ...ctx('backend-engineer', { writes: ['src/server/**'] }), cwd: realpathSync(repo), workspaceRoot: realpathSync(repo) };
  allowed(checkToolCall(bash('rm -rf .tmpcheck'), c));
  blocked(checkToolCall(bash('rm docs/a.md'), c), 'bash');
  blocked(checkToolCall(bash('mv .tmpcheck/x.js .tmpcheck/y.js'), c), 'bash');
});

test('同一命令中字面量赋值的变量会被代入后校验；含命令替换或未知变量的仍阻断', () => {
  const scratch = path.join(base, 'scratch-r2');
  mkdirSync(scratch, { recursive: true });
  const c = ctx('backend-engineer', { writes: ['src/server/**'], scratchDir: scratch });
  allowed(checkToolCall(bash(`S=${scratch}; mkdir -p $S/a && cp src/server/a.ts $S/a/ && rm -rf "\${S}/a"`), c));
  blocked(checkToolCall(bash('S=/etc; rm -rf $S/x'), c), 'bash');
  blocked(checkToolCall(bash('F=.flow; echo x > $F/state.json'), c));
  blocked(checkToolCall(bash('S=$(pwd); rm -rf $S/x'), c), 'bash');
  blocked(checkToolCall(bash('rm -rf $UNKNOWN/x'), c), 'bash');
});

test('实现类任务可以在接口文档里追加（不受任务可写范围限制），其他路径照旧；没有该标记时不可写', () => {
  const impl = ctx('backend-engineer', { interfaceAdditions: true, writes: ['src/server/a.ts'] });
  allowed(checkToolCall(call('write', { path: 'docs/interfaces/web.md', content: '' }), impl));
  allowed(checkToolCall(call('write', { path: 'src/server/a.ts', content: '' }), impl));
  blocked(checkToolCall(call('write', { path: 'docs/requirements.md', content: '' }), impl), 'write_paths');
  blocked(checkToolCall(call('write', { path: 'workflow.yaml', content: '' }), impl));
  blocked(checkToolCall(call('write', { path: 'docs/interfaces/web.md', content: '' }), ctx('backend-engineer', { writes: ['src/server/a.ts'] })), 'write_paths');
});

test('禁止后台运行：单独的 & 被拦下，&& 与 2>&1 不受影响；setsid、disown 被拦下', () => {
  const c = ctx('backend-engineer');
  blocked(checkToolCall(bash('node --test tests/a.test.js &'), c), 'bash', /后台运行/);
  blocked(checkToolCall(bash('sleep 1 & echo done'), c), 'bash', /后台运行/);
  blocked(checkToolCall(bash('setsid node x.js'), c), 'bash');
  allowed(checkToolCall(bash('node --test 2>&1 | tail -5'), c));
  allowed(checkToolCall(bash('ls && echo ok'), c));
});

test('适配已有测试：列出的已有测试文件可以写（不受角色可写范围限制），其他测试与受保护路径照旧', () => {
  const c = ctx('backend-engineer', { writes: ['src/server/a.ts'], adjustableTests: ['tests/acceptance/api.test.js'] });
  allowed(checkToolCall(call('write', { path: 'tests/acceptance/api.test.js', content: '' }), c));
  allowed(checkToolCall(call('edit', { path: 'tests/acceptance/api.test.js', edits: [] }), c));
  blocked(checkToolCall(call('write', { path: 'tests/acceptance/new.test.js', content: '' }), c), 'write_paths');
  blocked(checkToolCall(bash('rm tests/acceptance/api.test.js'), c), 'bash');
  blocked(checkToolCall(call('write', { path: 'tests/acceptance/api.test.js', content: '' }), ctx('backend-engineer', { writes: ['src/server/a.ts'] })), 'write_paths');
});
