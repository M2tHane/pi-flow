import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function tmpRepo(): { dir: string; git: (...args: string[]) => string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-flow-test-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'tester');
  git('config', 'user.email', 'tester@example.com');
  git('config', 'commit.gpgsign', 'false');
  return { dir, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
