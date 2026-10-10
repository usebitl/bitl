// For `pnpm test:dumps` only: validates the real dumps collected on this PC ($BITL_DUMP_DIR or ~/.bitl/dumps).
// Results differ per user, so it is not part of the default `pnpm test` (not a *.test.ts).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describeDumpRecords } from './dump-records.js';

const dir = process.env.BITL_DUMP_DIR ?? join(homedir(), '.bitl', 'dumps');
describeDumpRecords(`my dumps (${dir})`, dir);
