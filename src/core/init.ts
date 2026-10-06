// /flow init：检查 git、运行 preflight、生成骨架与模板、.codegraph/ 写入 .gitignore、初始化 .flow/、做一次初始提交。
// 可重复执行：不覆盖已有文件，只补缺，并报告与模板不同的文件。
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { StateStore } from './state-store.ts';
import { git, gitOk } from './git.ts';
import { preflight, type PreflightItem } from './preflight.ts';

export interface InitReport {
  created: string[];
  existing: string[];
  differs: string[];
  commit: string | null;
  preflight: PreflightItem[];
}

export function skeleton(packageRoot: string, projectName: string): Map<string, string> {
  const t = (rel: string) => readFileSync(path.join(packageRoot, rel), 'utf8');
  const files = new Map<string, string>();
  files.set('workflow.yaml', t('templates/workflow.yaml').replace(/^project: .*$/m, `project: ${projectName}`));
  files.set('AGENTS.md', t('templates/AGENTS.md'));
  // 通用规则；项目专属规则 rules/project.md 由规划阶段的 architect 起草、用户批准时写入
  for (const f of readdirSync(path.join(packageRoot, 'rules')).filter((x) => x.endsWith('.md')).sort()) files.set(`rules/${f}`, t(`rules/${f}`));
  files.set('docs/interfaces/.gitkeep', '');
  files.set('docs/research/.gitkeep', '');
  return files;
}

export async function initProject(root: string, packageRoot: string, deps?: { piVersion: string; packageRoots: string[] }): Promise<InitReport> {
  if (!gitOk(root, ['rev-parse', '--git-dir'])) throw new Error(`${root} 不是 git 仓库，请先执行 git init`);
  const top = git(root, ['rev-parse', '--show-toplevel']).trim();
  if (realpathSync(top) !== realpathSync(root)) throw new Error(`请在仓库根目录 ${top} 执行 /flow init`);
  const created: string[] = [];
  const existing: string[] = [];
  const differs: string[] = [];

  for (const [rel, content] of skeleton(packageRoot, path.basename(root))) {
    const abs = path.join(root, rel);
    if (existsSync(abs)) {
      existing.push(rel);
      if (rel !== 'workflow.yaml' && readFileSync(abs, 'utf8') !== content) differs.push(rel);
      continue;
    }
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    created.push(rel);
  }
  const gi = path.join(root, '.gitignore');
  const giText = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  if (!/^\.codegraph\/?$/m.test(giText)) {
    const block = readFileSync(path.join(packageRoot, 'templates/gitignore.append'), 'utf8').replace(/^\n+/, '');
    appendFileSync(gi, `${giText && !giText.endsWith('\n') ? '\n' : ''}${giText ? '\n' : ''}${block}`);
    created.push('.gitignore（追加 .codegraph/）');
  }

  let commit: string | null = null;
  const paths = [...created.map((c) => c.replace(/（.*$/, ''))];
  if (paths.length) {
    git(root, ['add', '--', ...paths]);
    if (!gitOk(root, ['rev-parse', '--verify', 'HEAD']) || !gitOk(root, ['diff', '--cached', '--quiet', '--', ...paths])) {
      git(root, ['commit', '-q', '--no-verify', '-m', 'pi-flow: 初始化项目骨架', '--', ...paths], { engineIdentity: true });
      commit = git(root, ['rev-parse', 'HEAD']).trim();
    }
  }
  if (!existsSync(path.join(root, '.flow', 'state.json'))) {
    if (!gitOk(root, ['rev-parse', '--verify', 'HEAD'])) {
      git(root, ['commit', '-q', '--allow-empty', '--no-verify', '-m', 'pi-flow: 初始提交'], { engineIdentity: true });
    }
    await StateStore.init(root);
    created.push('.flow/');
  } else {
    existing.push('.flow/');
  }
  return { created, existing, differs, commit, preflight: preflight({ root, ...deps }) };
}

export function formatInit(r: InitReport): string {
  return [
    r.created.length ? `新建：\n${r.created.map((c) => `  + ${c}`).join('\n')}` : '没有需要新建的文件。',
    r.existing.length ? `已存在（未覆盖）：${r.existing.length} 项` : '',
    r.differs.length ? `与模板不同（保留你的版本）：\n${r.differs.map((c) => `  ~ ${c}`).join('\n')}` : '',
    r.commit ? `已提交：${r.commit.slice(0, 8)} pi-flow: 初始化项目骨架` : '',
  ].filter(Boolean).join('\n');
}
