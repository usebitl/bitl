// `pnpm test:dumps` 전용: 내 PC 에 쌓인 실제 덤프($BITL_DUMP_DIR 또는 ~/.bitl/dumps)를 검증한다.
// 사용자마다 결과가 다르므로 기본 `pnpm test` 에는 포함하지 않는다 (*.test.ts 가 아님).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describeDumpRecords } from './dump-records.js';

const dir = process.env.BITL_DUMP_DIR ?? join(homedir(), '.bitl', 'dumps');
describeDumpRecords(`내 덤프 (${dir})`, dir);
