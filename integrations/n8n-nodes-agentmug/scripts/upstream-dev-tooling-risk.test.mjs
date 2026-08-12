import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run this contract through npm so its CLI path is available.');
const runNpm = (arguments_, options) => execFile(process.execPath, [npmCli, ...arguments_], options);

let report;
try {
	const { stdout } = await runNpm(['audit', '--json'], {
		cwd: new URL('..', import.meta.url),
	});
	report = JSON.parse(stdout);
} catch (error) {
	if (!error.stdout) throw error;
	report = JSON.parse(error.stdout);
}

const counts = report.metadata?.vulnerabilities;
assert.deepEqual(
	{ moderate: counts?.moderate, high: counts?.high, total: counts?.total },
	{ moderate: 5, high: 8, total: 13 },
	'Upstream n8n development-tooling risk changed; review the audit before releasing.',
);

const nanoid = report.vulnerabilities?.nanoid;
assert.equal(nanoid?.severity, 'high');
assert.ok(nanoid.via.some((advisory) => advisory.range === '<3.3.17'));

const uuid = report.vulnerabilities?.uuid;
assert.equal(uuid?.severity, 'moderate');
assert.ok(uuid.via.some((advisory) => advisory.range === '<11.1.1'));

console.log(
	'Known upstream development-tooling audit risk: 13 findings (8 high, 5 moderate). ' +
		'Production dependencies are separately audited and contract-tested as empty.',
);
