import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { AgentMugApi } = require('../dist/credentials/AgentMugApi.credentials.js');
const { AgentMug } = require('../dist/nodes/AgentMug/AgentMug.node.js');

const VALID_KEY = 'am_user_test-key_123';
const DEFAULT_CREDENTIALS = {
	apiKey: VALID_KEY,
	baseUrl: 'https://self-hosted.example.test/root/',
};

function createExecutionContext({
	items = [{ json: { source: 'first' } }],
	credentials = DEFAULT_CREDENTIALS,
	parameters = {
		agentId: ['agent/default'],
		message: ['Do the work'],
		outputField: ['full'],
	},
	continueOnFail = false,
	request,
} = {}) {
	const calls = [];
	const context = {
		getInputData() {
			return items;
		},
		async getCredentials(name) {
			assert.equal(name, 'agentMugApi');
			return credentials;
		},
		getNodeParameter(name, itemIndex) {
			return parameters[name][itemIndex];
		},
		getNode() {
			return {
				id: 'agentmug-test-node',
				name: 'AgentMug',
				type: 'n8n-nodes-agentmug.agentMug',
				typeVersion: 1,
				position: [0, 0],
				parameters: {},
			};
		},
		continueOnFail() {
			return continueOnFail;
		},
		helpers: {
			async httpRequestWithAuthentication(credentialType, options) {
				assert.equal(this, context);
				calls.push({ credentialType, options });
				if (request) {
					return request({ credentialType, options, callIndex: calls.length - 1 });
				}
				return { output: 'complete', runId: 'run-1' };
			},
		},
	};

	return { calls, context };
}

function credentialFixture(data) {
	return {
		id: 'credential-test',
		name: 'AgentMug test credential',
		type: 'agentMugApi',
		data,
	};
}

test('credential descriptor restricts the API key to AgentMug and injects it as a header', () => {
	const credential = new AgentMugApi();

	assert.deepEqual(credential.supportedNodes, ['agentMug']);
	assert.equal(credential.restrictToSupportedNodes, true);
	assert.deepEqual(credential.authenticate, {
		type: 'generic',
		properties: {
			headers: {
				'X-API-Key': '={{$credentials.apiKey}}',
			},
		},
	});

	const node = new AgentMug();
	assert.deepEqual(node.description.credentials, [
		{
			name: 'agentMugApi',
			required: true,
			testedBy: 'agentMugApiCredentialTest',
		},
	]);
});

for (const statusCode of [200, 403, 404]) {
	test(`credential test accepts authenticated HTTP ${statusCode} without running an agent`, async () => {
		const node = new AgentMug();
		const requests = [];
		const result = await node.methods.credentialTest.agentMugApiCredentialTest.call(
			{
				helpers: {
					async httpRequest(options) {
						requests.push(options);
						return { statusCode };
					},
				},
			},
			credentialFixture(DEFAULT_CREDENTIALS),
		);

		assert.deepEqual(result, {
			status: 'OK',
			message: 'Authentication succeeded',
		});
		assert.deepEqual(requests, [
			{
				method: 'GET',
				url:
					'https://self-hosted.example.test/root/api/external/agents/' +
					'00000000-0000-0000-0000-000000000000',
				headers: { 'X-API-Key': VALID_KEY },
				json: true,
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
				timeout: 10000,
			},
		]);
		assert.equal(requests[0].body, undefined);
	});
}

test('credential test reports an HTTP 401 as an invalid key', async () => {
	const node = new AgentMug();
	const result = await node.methods.credentialTest.agentMugApiCredentialTest.call(
		{
			helpers: {
				async httpRequest() {
					return { statusCode: 401 };
				},
			},
		},
		credentialFixture(DEFAULT_CREDENTIALS),
	);

	assert.deepEqual(result, {
		status: 'Error',
		message: 'AgentMug rejected this API key',
	});
});

test('credential test validates key and Base URL before making a request', async () => {
	const node = new AgentMug();
	let requests = 0;
	const testFunctions = {
		helpers: {
			async httpRequest() {
				requests += 1;
				return { statusCode: 200 };
			},
		},
	};

	assert.deepEqual(
		await node.methods.credentialTest.agentMugApiCredentialTest.call(
			testFunctions,
			credentialFixture({
				apiKey: 'not-a-key',
				baseUrl: 'https://agentmug.com',
			}),
		),
		{
			status: 'Error',
			message: 'Enter a valid AgentMug user or agent API key',
		},
	);
	assert.deepEqual(
		await node.methods.credentialTest.agentMugApiCredentialTest.call(
			testFunctions,
			credentialFixture({
				apiKey: VALID_KEY,
				baseUrl: 'file:///tmp/agentmug',
			}),
		),
		{
			status: 'Error',
			message: 'AgentMug Base URL must use HTTP or HTTPS',
		},
	);
	assert.deepEqual(
		await node.methods.credentialTest.agentMugApiCredentialTest.call(
			testFunctions,
			credentialFixture({
				apiKey: VALID_KEY,
				baseUrl: 'not a URL',
			}),
		),
		{
			status: 'Error',
			message: 'AgentMug Base URL is not valid',
		},
	);
	assert.equal(requests, 0);
});

test('execute encodes the agent ID and builds the authenticated request', async () => {
	const node = new AgentMug();
	const { calls, context } = createExecutionContext({
		parameters: {
			agentId: ['team/agent ?#'],
			message: ['Summarize this file'],
			outputField: ['full'],
		},
		request() {
			return {
				output: 'summary',
				runId: 'run-42',
				toolCalls: [],
			};
		},
	});

	const result = await node.execute.call(context);

	assert.deepEqual(calls, [
		{
			credentialType: 'agentMugApi',
			options: {
				method: 'POST',
				url:
					'https://self-hosted.example.test/root/api/external/agents/' +
					'team%2Fagent%20%3F%23/invoke',
				headers: { 'Content-Type': 'application/json' },
				body: { message: 'Summarize this file' },
				json: true,
				timeout: 180000,
			},
		},
	]);
	assert.deepEqual(result, [
		[
			{
				json: {
					output: 'summary',
					runId: 'run-42',
					toolCalls: [],
				},
				pairedItem: { item: 0 },
			},
		],
	]);
});

test('execute maps output-only results and preserves paired-item lineage', async () => {
	const node = new AgentMug();
	const { context } = createExecutionContext({
		items: [{ json: { n: 1 } }, { json: { n: 2 } }],
		parameters: {
			agentId: ['agent-1', 'agent-2'],
			message: ['first', 'second'],
			outputField: ['output', 'output'],
		},
		request({ callIndex }) {
			return callIndex === 0 ? { output: 'one' } : { runId: 'run-without-output' };
		},
	});

	assert.deepEqual(await node.execute.call(context), [
		[
			{ json: { output: 'one' }, pairedItem: { item: 0 } },
			{ json: { output: '' }, pairedItem: { item: 1 } },
		],
	]);
});

test('execute emits item-scoped errors when continueOnFail is enabled', async () => {
	const node = new AgentMug();
	const { context } = createExecutionContext({
		items: [{ json: { n: 1 } }, { json: { n: 2 } }],
		parameters: {
			agentId: ['agent-1', 'agent-2'],
			message: ['fail', 'succeed'],
			outputField: ['full', 'full'],
		},
		continueOnFail: true,
		request({ callIndex }) {
			if (callIndex === 0) {
				throw new Error('upstream unavailable');
			}
			return { output: 'recovered', runId: 'run-2' };
		},
	});

	assert.deepEqual(await node.execute.call(context), [
		[
			{
				json: { error: 'upstream unavailable' },
				pairedItem: { item: 0 },
			},
			{
				json: { output: 'recovered', runId: 'run-2' },
				pairedItem: { item: 1 },
			},
		],
	]);
});

test('execute validates credentials before making an HTTP request', async () => {
	const node = new AgentMug();
	let requests = 0;
	const invalidKey = createExecutionContext({
		credentials: {
			apiKey: 'wrong',
			baseUrl: 'https://agentmug.com',
		},
		request() {
			requests += 1;
		},
	});
	const invalidUrl = createExecutionContext({
		credentials: {
			apiKey: VALID_KEY,
			baseUrl: 'ftp://agentmug.example.test',
		},
		request() {
			requests += 1;
		},
	});

	await assert.rejects(
		() => node.execute.call(invalidKey.context),
		/Enter a valid AgentMug user or agent API key/,
	);
	await assert.rejects(
		() => node.execute.call(invalidUrl.context),
		/AgentMug Base URL must use HTTP or HTTPS/,
	);
	assert.equal(requests, 0);
});
