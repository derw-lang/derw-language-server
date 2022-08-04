/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import { generateDerw } from 'derw/build/generators/derw';
import { parse } from 'derw/build/parser';
import { Module, Type } from 'derw/build/types';
import { readFile } from 'fs/promises';
import * as path from 'path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
	CompletionItem,
	createConnection,
	Diagnostic,
	DiagnosticSeverity,
	DidChangeConfigurationNotification,
	Hover,
	InitializeParams,
	InitializeResult,
	MarkupContent,
	ProposedFeatures,
	TextDocumentPositionParams,
	TextDocuments,
	TextDocumentSyncKind,
} from 'vscode-languageserver/node';

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

connection.onInitialize((params: InitializeParams) => {
	const capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we fall back using global settings.
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);
	hasDiagnosticRelatedInformationCapability = !!(
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation
	);

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			// Tell the client that this server supports code completion.
			completionProvider: {
				resolveProvider: true,
			},
			hoverProvider: true,
		},
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true,
			},
		};
	}
	return result;
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders((_event) => {
			connection.console.log('Workspace folder change event received.');
		});
	}
});

// The example settings
interface ExampleSettings {
	maxNumberOfProblems: number;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: ExampleSettings = { maxNumberOfProblems: 1000 };
let globalSettings: ExampleSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<ExampleSettings>> = new Map();

connection.onDidChangeConfiguration((change) => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear();
	} else {
		globalSettings = <ExampleSettings>(
			(change.settings.languageServerExample || defaultSettings)
		);
	}

	// Revalidate all open text documents
	documents.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource: string): Thenable<ExampleSettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}
	let result = documentSettings.get(resource);
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: 'derwLanguageServer',
		});
		documentSettings.set(resource, result);
	}
	return result;
}

// Only keep settings for open documents
documents.onDidClose((e) => {
	documentSettings.delete(e.document.uri);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent((change) => {
	validateTextDocument(change.document);
});

type LineInfo = {
	start: number;
	end: number;
};

function lineNumberToIndex(lineNumber: number, text: string): LineInfo {
	const split = text.split('\n');
	const priorLines = split.slice(0, lineNumber);
	const priorLength = priorLines.join('\n').length;
	const lineEnd = priorLength + split[lineNumber].length;

	return {
		start: priorLength,
		end: lineEnd,
	};
}

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
	// In this simple example we get the settings for every validate run.
	const settings = await getDocumentSettings(textDocument.uri);

	// The validator creates diagnostics for all uppercase words length 2 and more
	const text = textDocument.getText();
	let problems = 0;
	const diagnostics: Diagnostic[] = [ ];

	const parsed = parse(text);

	for (const error of parsed.errors) {
		if (error.startsWith('Line')) {
			const lineNumber = parseInt(error.split('Line')[1].split(':')[0].trim(), 10);
			const indexes = lineNumberToIndex(lineNumber, text);

			problems++;
			const diagnostic: Diagnostic = {
				severity: DiagnosticSeverity.Error,
				range: {
					start: textDocument.positionAt(indexes.start + 1),
					end: textDocument.positionAt(indexes.end - 1),
				},
				message: error,
			};
			diagnostics.push(diagnostic);
		} else if (error.startsWith('Error on lines')) {
			const numberRange = error.split('Error on lines')[1].trim();
			const startLine = parseInt(numberRange.split('-')[0].trim(), 10);
			const endLine = parseInt(numberRange.split('-')[1].trim(), 10) - 1;
			const indexes = lineNumberToIndex(startLine, text);
			const endIndexes = lineNumberToIndex(endLine, text);

			problems++;
			const diagnostic: Diagnostic = {
				severity: DiagnosticSeverity.Error,
				range: {
					start: textDocument.positionAt(indexes.start + 1),
					end: textDocument.positionAt(endIndexes.end + 1),
				},
				message: error,
			};
			diagnostics.push(diagnostic);
		} else if (error.startsWith('The name')) {
			const ranges = error
				.split('\n')
				.filter((line) => line.includes(' - ') && line.endsWith(':'));

			for (const range of ranges) {
				const startLine = parseInt(range.split('-')[0].trim(), 10);
				const endLine = parseInt(range.split('-')[1].trim(), 10) - 1;
				const indexes = lineNumberToIndex(startLine, text);
				const endIndexes = lineNumberToIndex(endLine, text);

				problems++;
				const diagnostic: Diagnostic = {
					severity: DiagnosticSeverity.Error,
					range: {
						start: textDocument.positionAt(indexes.start + 1),
						end: textDocument.positionAt(endIndexes.end + 1),
					},
					message: error,
				};
				diagnostics.push(diagnostic);
			}
		}
	}

	// Send the computed diagnostics to VSCode.
	connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

connection.onDidChangeWatchedFiles((_change) => {
	// Monitored files have change in VSCode
});

// This handler provides the initial list of the completion items.
connection.onCompletion(
	(textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
		// The pass parameter contains the position of the text document in
		// which code complete got requested. For the example we ignore this
		// info and always provide the same completion items.

		const currentLine = textDocumentPosition.textDocument;

		return [ ];
	}
);

function isAlphaNumeric(str: string): boolean {
	const len = str.length;
	for (let i = 0; i < len; i++) {
		const code = str.charCodeAt(i);
		if (
			!(code > 47 && code < 58) && // numeric (0-9)
			!(code > 64 && code < 91) && // upper alpha (A-Z)
			!(code > 96 && code < 123)
		) {
			// lower alpha (a-z)
			return false;
		}
	}
	return true;
}

function closestToken(line: string, index: number): string {
	if (!isAlphaNumeric(line[index])) return '';
	const previousChars: string[] = [ ];
	const afterChars: string[] = [ ];

	let i = index - 1;
	while (i >= 0) {
		if (!isAlphaNumeric(line[i])) {
			break;
		} else {
			previousChars.splice(0, 0, line[i]);
		}
		i--;
	}

	i = index + 1;
	while (i < line.length) {
		if (!isAlphaNumeric(line[i])) {
			break;
		} else {
			afterChars.push(line[i]);
		}
		i++;
	}

	return [ ...previousChars, line[index], ...afterChars ].join('');
}

function typeToString(type: Type): string {
	switch (type.kind) {
		case 'GenericType': {
			return type.name;
		}
		case 'FixedType': {
			const typeArgs =
				type.args.length === 0 ? '' : ' (' + type.args.map(typeToString).join(' ') + ')';
			return `${type.name}${typeArgs}`.trim();
		}
		case 'FunctionType': {
			return type.args.map(typeToString).join('->');
		}
	}
}

async function getMarkdown(
	tokenAtHover: string,
	parsed: Module,
	directory: string
): Promise<MarkupContent | null> {
	for (const block of parsed.body) {
		switch (block.kind) {
			case 'Comment':
			case 'Export':
			case 'MultilineComment': {
				break;
			}

			case 'Import': {
				for (const module of block.modules) {
					if (module.namespace === 'Global') continue;
					for (const exposing of module.exposing) {
						if (exposing === tokenAtHover) {
							const filename = path.join(directory, module.name.slice(1, -1) + '.derw');
							try {
								const content = await readFile(filename, 'utf-8');
								const newParsed = parse(content);
								return await getMarkdown(tokenAtHover, newParsed, directory);
							} catch (e) {
								continue;
							}
						}
					}
				}
				break;
			}

			case 'Const': {
				if (block.name === tokenAtHover) {
					return {
						kind: 'markdown',
						value: [ `${tokenAtHover}`, '```elm', typeToString(block.type), '```' ].join(
							'\n'
						),
					};
				}
				break;
			}

			case 'Function': {
				if (block.name === tokenAtHover) {
					const types = block.args
						.map((value) => {
							if (value.kind === 'FunctionArg') {
								return typeToString(value.type);
							} else {
								return typeToString(value.type);
							}
						})
						.join(' -> ');

					const args = block.args
						.map((value) => {
							if (value.kind === 'FunctionArg') {
								return value.name;
							} else {
								return value.index;
							}
						})
						.join(' -> ');

					return {
						kind: 'markdown',
						value: [
							`${tokenAtHover}`,
							'```elm',
							`${types} -> ${typeToString(block.returnType)}`,
							`${args} -> `,
							'```',
						].join('\n'),
					};
				}
				break;
			}

			case 'UnionType': {
				if (
					block.type.name === tokenAtHover ||
					block.tags.filter((t) => t.name === tokenAtHover).length > 0
				) {
					return {
						kind: 'markdown',
						value: [
							`${tokenAtHover}`,
							'```elm',
							generateDerw({
								kind: 'Module',
								name: 'Main',
								body: [ block ],
								errors: [ ],
							}),
							'```',
						].join('\n'),
					};
				}
				break;
			}

			case 'TypeAlias': {
				if (block.type.name === tokenAtHover) {
					return {
						kind: 'markdown',
						value: [
							`${tokenAtHover}`,
							'```elm',
							generateDerw({
								kind: 'Module',
								name: 'Main',
								body: [ block ],
								errors: [ ],
							}),
							'```',
						].join('\n'),
					};
				}
				break;
			}
		}
	}

	return null;
}

connection.onHover(async (params: TextDocumentPositionParams): Promise<
	Hover | undefined
> => {
	const doc = documents.get(params.textDocument.uri);
	if (!doc) return;

	let tokenAtHover = '';
	try {
		tokenAtHover = closestToken(
			doc?.getText().split('\n')[params.position.line] || '',
			params.position.character
		);
	} catch {
		return;
	}

	const dirName = path.dirname(params.textDocument.uri);
	if (tokenAtHover.length === 0) return;

	const text = doc?.getText();
	const parsed = parse(text);

	const markdown: MarkupContent | null = await getMarkdown(
		tokenAtHover,
		parsed,
		dirName.split('file://')[1]
	);

	if (!markdown) return;

	return {
		contents: markdown,
	};
});

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
	return item;
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
