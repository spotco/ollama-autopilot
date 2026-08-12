import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConfigHandler } from "./configHandler";
import { GuiHandler } from "./guiHandler";
import { OllamaClient } from "./ollamaClient";
import { AutopilotProvider } from "./autopilotProvider";

const DEBUG_LOG = path.join(os.tmpdir(), 'ollama-autopilot-debug.log');

function debugLog(msg: string): void {
	try {
		fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`);
	} catch {
		// ignore
	}
}

export async function activate(context: vscode.ExtensionContext) {
	debugLog(`ACTIVATE version extensionPath=${context.extensionPath}`);

	const configHandler = new ConfigHandler();
	const guiHandler = new GuiHandler(context, configHandler);
	const ollamaClient = new OllamaClient(configHandler, guiHandler);
	const autopilotProvider = new AutopilotProvider(ollamaClient, configHandler, guiHandler, debugLog);

	context.subscriptions.push(configHandler);
	context.subscriptions.push(guiHandler);
	context.subscriptions.push(autopilotProvider);

	context.subscriptions.push(
		vscode.commands.registerCommand("ollama-autopilot.showMenu", () => {
			guiHandler.showMenu();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("ollama-autopilot.enable", () => {
			configHandler.setAutopilotEnabledState(true);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("ollama-autopilot.disable", () => {
			configHandler.setAutopilotEnabledState(false);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("ollama-autopilot.snooze", () => {
			autopilotProvider.snoozeAutopilot();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("ollama-autopilot.selectModel", () => {
			ollamaClient.selectModelAndPreload();
		}),
	);

	// run initializeAccordingToConfig once at startup:
	initializeAccordingToConfig(configHandler, guiHandler, ollamaClient);

	// re-run initializeAccordingToConfig on every config change:
	configHandler.onConfigDidChange(() => initializeAccordingToConfig(configHandler, guiHandler, ollamaClient));

	// Match ALL documents (saved, untitled, notebooks). Upstream only used scheme:file.
	const providerRegistration = vscode.languages.registerInlineCompletionItemProvider(
		{ pattern: '**' },
		autopilotProvider,
	);
	context.subscriptions.push(providerRegistration);
	debugLog(`PROVIDER registered pattern=** log=${DEBUG_LOG}`);
	vscode.window.setStatusBarMessage(`Autopilot active (log: ${DEBUG_LOG})`, 5000);
}

export function deactivate() {
	debugLog('DEACTIVATE');
}

async function initializeAccordingToConfig(configHandler: ConfigHandler, guiHandler: GuiHandler, ollamaClient: OllamaClient) {
	debugLog(`INIT enabled=${configHandler.autopilotEnabled} model=${configHandler.modelName} baseUrl=${configHandler.baseUrl}`);
	if (!configHandler.autopilotEnabled) {
		guiHandler.indicateAutopilotDisabled();
	} else {
		guiHandler.indicateOllamaEnabled();
		await ollamaClient.initialization();
	}
}
