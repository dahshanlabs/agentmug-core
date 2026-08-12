import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run this contract through npm so its CLI path is available.');
const runNpm = (arguments_, options) => execFile(process.execPath, [npmCli, ...arguments_], options);
const packageUrl = new URL('../package.json', import.meta.url);
const manifest = JSON.parse(await readFile(packageUrl, 'utf8'));
const packageDirectory = new URL('..', import.meta.url);

assert.equal(manifest.overrides, undefined, 'n8n community-node packages may not use npm overrides.');
for (const field of ['dependencies', 'optionalDependencies', 'bundledDependencies', 'bundleDependencies']) {
	assert.ok(
		!manifest[field] || Object.keys(manifest[field]).length === 0,
		`${field} must stay empty so the package ships no third-party runtime dependencies.`,
	);
}

const { stdout: productionTree } = await runNpm(['ls', '--omit=dev', '--all', '--json'], {
	cwd: packageDirectory,
});
const productionDependencies = JSON.parse(productionTree).dependencies ?? {};
assert.deepEqual(
	productionDependencies,
	{},
	`The production tree must be empty; found ${JSON.stringify(productionDependencies)}.`,
);

const { stdout: packedPackage } = await runNpm(['pack', '--dry-run', '--json'], {
	cwd: packageDirectory,
});
const [tarball] = JSON.parse(packedPackage);
assert.ok(tarball, 'npm pack did not return a tarball manifest.');
const forbiddenTarballFiles = tarball.files
	.map(({ path }) => path)
	.filter((path) => /(^|\/)(node_modules|package-lock\.json|npm-shrinkwrap\.json)(\/|$)/.test(path));
assert.deepEqual(forbiddenTarballFiles, [], 'The tarball must not contain installed or lockfile dependencies.');

console.log(`Verified an empty production tree and dependency-free tarball for ${manifest.name}.`);
