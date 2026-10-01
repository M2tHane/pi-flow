import { readFileSync } from 'node:fs';
import path from 'node:path';

export const TEMPLATE_YAML = readFileSync(path.join(import.meta.dirname, '../../templates/workflow.yaml'), 'utf8');

/** 模板已填入核实过的 serena、codegraph 工具名，测试直接使用 */
export const TEST_YAML = TEMPLATE_YAML;
