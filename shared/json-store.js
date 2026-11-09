import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

// 단일 Node 프로세스용: 동기식 read-modify-write와 rename으로 중간 파일 노출을 막는다.
export class JsonStore {
  constructor(path) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
  }

  read() {
    try {
      const items = JSON.parse(readFileSync(this.path, 'utf8'));
      if (!Array.isArray(items)) throw new Error('저장 파일이 배열이 아닙니다.');
      return items;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  prepend(item, keep = items => items) {
    const items = keep([item, ...this.read()]);
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(items, null, 2), { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
