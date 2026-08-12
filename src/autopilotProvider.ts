import * as vscode from "vscode";
import { OllamaClient } from "./ollamaClient";
import { ConfigHandler } from "./configHandler";
import { GuiHandler } from "./guiHandler";

type DebugFn = (msg: string) => void;

export class AutopilotProvider implements vscode.InlineCompletionItemProvider {
    private ollamaClient: OllamaClient;
    private configHandler: ConfigHandler;
    private guiHandler: GuiHandler;
    private debugLog: DebugFn;
    private abortController?: AbortController;
    private debounceTimer?: NodeJS.Timeout;
    private snoozeTimeout?: NodeJS.Timeout;
    private isSnoozeActive: boolean;
    private configChangeDisposable?: vscode.Disposable;

    constructor(ollamaClient: OllamaClient, configHandler: ConfigHandler, guiHandler: GuiHandler, debugLog: DebugFn = () => {}) {
        this.ollamaClient = ollamaClient;
        this.configHandler = configHandler;
        this.guiHandler = guiHandler;
        this.debugLog = debugLog;
        this.isSnoozeActive = false;

        this.configChangeDisposable =
            this.configHandler.onConfigDidChange(() => {
                if (!this.configHandler.autopilotEnabled) {
                    this.clearSnoozeTimer();
                }
            });
    }

    public dispose(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        if (this.snoozeTimeout) {
            clearTimeout(this.snoozeTimeout);
        }
        this.abortController?.abort();
        this.configChangeDisposable?.dispose();
    }


    private async clearSnoozeTimer(): Promise<void> {
        if (this.isSnoozeActive) {
            if (this.snoozeTimeout) {
                clearTimeout(this.snoozeTimeout);
                this.snoozeTimeout = undefined;
            }
            this.isSnoozeActive = false;
        }
    }

    private getTextBeforeCursor(document: vscode.TextDocument, cursorPosition: vscode.Position): string {
        const textBeforeCursor = document.getText(
            new vscode.Range(document.lineAt(0).range.start, cursorPosition),
        );
        const maxTextBeforeCursorSize = this.configHandler.textBeforeCursorSize;
        const currentTextLength = textBeforeCursor.length;

        if (currentTextLength > maxTextBeforeCursorSize) {
            return textBeforeCursor.slice(
                currentTextLength-maxTextBeforeCursorSize, currentTextLength
            );
        }
        else {
            return textBeforeCursor;
        }
    }

    private getTextAfterCursor(document: vscode.TextDocument, cursorPosition: vscode.Position): string {
        const textAfterCursor = document.getText(
            new vscode.Range(cursorPosition, document.lineAt(document.lineCount-1).range.end),
        );
        const maxTextAfterCursorSize = this.configHandler.textAfterCursorSize;
        const currentTextLength = textAfterCursor.length;

        if (currentTextLength > maxTextAfterCursorSize) {
            return textAfterCursor.slice(
                0, maxTextAfterCursorSize
            );
        }
        else {
            return textAfterCursor;
        }
    }

    private createPromptString(document: vscode.TextDocument, cursorPosition: vscode.Position): string {
        const textAfterCursorIntermediatePlaceholder: string = "pS7inMQx6FhGs289J3Uw7szRes";
        const textBeforeCursorIntermediatePlaceholder: string = "R1jq1M19LlM7XYhu5233y6OrqI";

        const replacements: Array<[string, string]> = [
            ["${workspaceName}", vscode.workspace.name || "no-workspace-name"],
            ["${fileName}", document.fileName],
            ["${languageId}", document.languageId],
            ["${textAfterCursor}", textAfterCursorIntermediatePlaceholder],
            ["${textBeforeCursor}", textBeforeCursorIntermediatePlaceholder],
            [textAfterCursorIntermediatePlaceholder, this.getTextAfterCursor(document, cursorPosition)],
            [textBeforeCursorIntermediatePlaceholder, this.getTextBeforeCursor(document, cursorPosition)],
        ];

        let promptText = this.configHandler.promptText;
        for (const [key, value] of replacements) {
            promptText = promptText.replaceAll(key, value);
        }

        return promptText;
    }

    private cleanResponseString(responseString: string): string {
        if (!responseString) {
            return '';
        }

        let s = responseString.trim();

        // Drop common chatty prefixes models invent for "completion" prompts
        s = s.replace(/^```[^\r\n]*\r?\n/, '');
        s = s.replace(/\r?\n```[ \t]*$/, '');
        s = s.trim();

        // If model echoed a full fence block only, empty is correct
        return s;
    }

    private debounce(delay: number, token: vscode.CancellationToken): Promise<void> {
        return new Promise((resolve, reject) => {
            if (token.isCancellationRequested) {
                return reject(new Error("Cancelled before debounce"));
            }

            this.debounceTimer = setTimeout(() => {
                resolve();
            }, delay);

            token.onCancellationRequested(() => {
                if (this.debounceTimer) {
                    clearTimeout(this.debounceTimer);
                    this.debounceTimer = undefined;
                }
                reject(new Error("Cancelled during debounce"));
            });
        });
    }

    public async snoozeAutopilot(): Promise<void> {
        if (this.configHandler.autopilotEnabled) {
            this.guiHandler.showSnoozeMessage();
            await this.configHandler.setAutopilotEnabledState(false);
            if (this.snoozeTimeout) {
                clearTimeout(this.snoozeTimeout);
            }
            this.isSnoozeActive = true;
            this.snoozeTimeout = setTimeout(async () => {
                if (this.isSnoozeActive) {
                    this.configHandler.setAutopilotEnabledState(true);
                    this.snoozeTimeout = undefined;
                    this.isSnoozeActive = false;
                }
            }, this.configHandler.snoozeTimeMin * 60 * 1000);
        }
    }

    public async provideInlineCompletionItems(
        document: vscode.TextDocument,
        cursorPosition: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken,
    ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | undefined> {
        this.debugLog(
            `PROVIDE scheme=${document.uri.scheme} lang=${document.languageId} ` +
            `trigger=${context.triggerKind} enabled=${this.configHandler.autopilotEnabled} ` +
            `pos=${cursorPosition.line}:${cursorPosition.character}`
        );

        if (!this.configHandler.autopilotEnabled) {
            this.debugLog('SKIP disabled');
            return undefined;
        }

        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = undefined;
        }

        if (this.abortController) {
            this.abortController.abort();
            this.abortController = undefined;
        }
        this.abortController = new AbortController();

        try {
            if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) {
                if (this.configHandler.suggestionTrigger === "manual") {
                    this.debugLog('SKIP manual-only mode');
                    return undefined;
                }

                await this.debounce(this.configHandler.autocompleteDelayMs, token);
            }

            if (token.isCancellationRequested) {
                this.debugLog('SKIP cancelled after debounce');
                return undefined;
            }

            const model = this.configHandler.modelName;
            const prompt = this.createPromptString(document, cursorPosition);
            const temperature = this.configHandler.temperature;
            const num_ctx = this.configHandler.contextSize;
            const num_predict = this.configHandler.maxAutocompleteTokens;
            // Prefer mild stops — "\\n\\n" as default often kills useful completions early
            // and some models emit nothing useful under aggressive stop lists.
            let stop = this.configHandler.stopSequences;
            if (!stop || stop.length === 0) {
                stop = ["```", "<EOT>"];
            }

            this.debugLog(`REQUEST model=${model} promptChars=${prompt.length} num_predict=${num_predict}`);

            const responseString = await this.ollamaClient.generateResponse(
                {
                    model,
                    prompt,
                    options: {
                        temperature,
                        num_ctx,
                        num_predict,
                        stop,
                    },
                },
                this.abortController.signal,
            );

            if (token.isCancellationRequested) {
                this.debugLog('SKIP cancelled after generate');
                return undefined;
            }

            const cleanedCodeCompletion = this.cleanResponseString(responseString);
            this.debugLog(
                `RESPONSE rawLen=${(responseString || '').length} cleanLen=${cleanedCodeCompletion.length} ` +
                `preview=${JSON.stringify(cleanedCodeCompletion.slice(0, 80))}`
            );

            if (!cleanedCodeCompletion) {
                return undefined;
            }

            return [
                new vscode.InlineCompletionItem(
                    cleanedCodeCompletion,
                    new vscode.Range(cursorPosition, cursorPosition),
                ),
            ];
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.debugLog(`ERROR ${msg}`);
            return undefined;
        }
        finally {
            this.abortController = undefined;
        }
    }
}
