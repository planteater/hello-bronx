"use strict";
import {
	createConnection,
	InitializedParams,
	InitializeParams,
	InitializeResult,
	ProposedFeatures,
	TextDocuments,
	TextDocumentSyncKind
} from "vscode-languageserver";
import { CodeStreamAgent, FileLspLogger, NullLspLogger } from "./agent";
import { Logger } from "./logger";
import { AgentOptions, LogoutReason } from "./protocol/agent.protocol";

let logPath;
process.argv.forEach(function(val, index, array) {
	if (val && val.indexOf("--log=") === 0) {
		logPath = val.substring(6);
	}
});
const logger = logPath != null ? new FileLspLogger(logPath) : undefined;

// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

let initializeParams: InitializeParams | undefined;

const documents = new TextDocuments();

const agentConfig = {
	documents: documents,
	logger: logger,
	onInitialize: async (e: InitializeParams) => {
		initializeParams = e;

		const agentOptions = e.initializationOptions! as AgentOptions;

		Logger.log(
			`Agent for CodeStream v${agentOptions.extension.versionFormatted} in ${agentOptions.ide.name} (v${agentOptions.ide.version}) initializing...`
		);

		return {
			capabilities: {
				textDocumentSync: TextDocumentSyncKind.Full
			},
			result: null
		} as InitializeResult;
	},
	// This doesn't get called by Visual Studio, so just ignore it
	onInitialized: (e: InitializedParams) => {
		Logger.log("onInitialized");
	}
};

let agent = new CodeStreamAgent(connection, agentConfig);

connection.onRequest("codestream/onInitialized", async (agentOptions: AgentOptions) => {
	if (agent.signedIn) {
		restartAgent();
	}

	Logger.log(`Agent(${agentOptions.ide.name}) initializing...`);

	const params = {
		...initializeParams,
		initializationOptions: agentOptions
	} as InitializeParams;

	let response;
	try {
		response = await agent.onInitialize(params);

		if (response.result!.error == null) {
			Logger.log("onInitialized...");
			await agent.onInitialized({});
			Logger.log(`Agent(${agentOptions.ide.name}) initialize`);
		}
	} catch (ex) {
		Logger.error(ex);

		response = {
			result: {
				error: ex.message
			}
		};
	}

	return response;
});

connection.onRequest("codestream/logout", async _ => {
	await agent.logout(LogoutReason.Unknown);
	restartAgent();
});

function restartAgent() {
	Logger.log("Restarting agent...");

	if (agent != null) {
		agent.dispose();
	}
	agent = new CodeStreamAgent(connection, agentConfig);
}

connection.listen();
