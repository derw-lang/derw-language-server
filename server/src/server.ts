/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import { generateDerw } from 'derw/build/generators/Derw';
import { parse, parseWithContext } from 'derw/build/parser';
import { Const, ContextModule, Function, Module, Type } from 'derw/build/types';
import { readdir, readFile } from 'fs/promises';
import * as path from 'path';
import { Range, TextDocument } from 'vscode-languageserver-textdocument';
import {
  CompletionItem,
  CompletionItemKind,
  createConnection,
  DefinitionLink,
  DefinitionParams,
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
        triggerCharacters: [ '"', '.', '/' ],
      },
      hoverProvider: true,
      definitionProvider: true,
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

type FileEntry = { name: string; kind: 'FileEntry' };
type FolderEntry = { name: string; kind: 'FolderEntry' };

type Entry = FileEntry | FolderEntry;

async function listDirectories(rootPath: string): Promise<Entry[]> {
  const filesAndFolders: Entry[] = [ ];
  for (const dir of await readdir(rootPath, {
    withFileTypes: true,
  })) {
    if (dir.isDirectory()) {
      filesAndFolders.push({ name: dir.name, kind: 'FolderEntry' });
    } else if (
      (dir.isFile() && dir.name.endsWith('.derw')) ||
      dir.name.endsWith('.js') ||
      dir.name.endsWith('.ts')
    ) {
      let alreadySeen = false;
      for (const file of filesAndFolders) {
        if (
          file.name.split('.').slice(-1).join('.') ===
          dir.name.split('.').slice(-1).join('.')
        ) {
          alreadySeen = true;
          break;
        }
      }
      if (!alreadySeen) {
        filesAndFolders.push({ name: dir.name, kind: 'FileEntry' });
      }
    }
  }
  return filesAndFolders;
}

// This handler provides the initial list of the completion items.
connection.onCompletion(async (textDocumentPosition: TextDocumentPositionParams): Promise<
  CompletionItem[]
> => {
  // The pass parameter contains the position of the text document in
  // which code complete got requested. For the example we ignore this
  // info and always provide the same completion items.

  const doc = documents.get(textDocumentPosition.textDocument.uri);
  if (!doc) return [ ];

  try {
    const line = doc?.getText().split('\n')[textDocumentPosition.position.line] || '';
    if (line.startsWith('import')) {
      const isParentDirectory = line.includes('..');
      let workingPath =
        line
          .split('.')
          .slice(1)
          .join('.')
          .split('"')[0]
          .split('/')
          .slice(0, -1)
          .join('/') || '/';

      workingPath = path.join(
        textDocumentPosition.textDocument.uri
          .split('file:/')[1]
          .split('/')
          .slice(0, -1)
          .join('/'),
        isParentDirectory ? '.' + workingPath : workingPath
      );

      return (await listDirectories(workingPath)).map((entry: Entry) => {
        return {
          label:
            entry.kind === 'FileEntry'
              ? entry.name.split('.').slice(-1).join('.')
              : entry.name,
          kind:
            entry.kind === 'FileEntry'
              ? CompletionItemKind.File
              : CompletionItemKind.Folder,
        };
      });
    }
  } catch {
    return [ ];
  }

  return [ ];
});

function isAlphaNumeric(str: string): boolean {
  const len = str.length;
  for (let i = 0; i < len; i++) {
    const code = str.charCodeAt(i);
    if (
      !(code > 47 && code < 58) && // numeric (0-9)
      !(code > 64 && code < 91) && // upper alpha (A-Z)
      !(code > 96 && code < 123) &&
      code !== 46 // .
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
      return '(' + type.args.map(typeToString).join(' -> ') + ')';
    }
    case 'ObjectLiteralType': {
      const output = [ ];

      for (const prop of Object.keys(type.properties)) {
        const value = type.properties[prop];

        output.push(`${prop}: ${typeToString(value)}`);
      }

      return `{ ${output.join(', ')} }`;
    }
  }
}

/* eslint-disable-next-line */
function functionToMarkupContent(block: Function): MarkupContent {
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
      `${block.name}`,
      '```elm',
      `${types} -> ${typeToString(block.returnType)}`,
      `${args} -> `,
      '```',
    ].join('\n'),
  };
}

function constToMarkupContent(block: Const): MarkupContent {
  return {
    kind: 'markdown',
    value: [ `${block.name}`, '```elm', typeToString(block.type), '```' ].join('\n'),
  };
}

async function getMarkdownFromModuleReference(
  moduleName: string,
  tokenName: string,
  parsed: ContextModule,
  directory: string
): Promise<MarkupContent | null> {
  for (const block of parsed.body) {
    switch (block.kind) {
      case 'Import': {
        for (const module of block.modules) {
          if (module.namespace === 'Global') continue;
          if (module.alias.kind === 'Just' && module.alias.value === moduleName) {
            const filename = path.join(directory, module.name.slice(1, -1) + '.derw');
            try {
              const content = await readFile(filename, 'utf-8');
              const newParsed = parseWithContext(content);
              return await getMarkdown(tokenName, newParsed, directory, null);
            } catch (e) {
              continue;
            }
          }
        }
      }
    }
  }
  return null;
}

async function getMarkdown(
  tokenAtHover: string,
  parsed: ContextModule,
  directory: string,
  lineNumber: number | null
): Promise<MarkupContent | null> {
  let i = -1;

  for (const block of parsed.body) {
    i++;
    const unparsedBlock = parsed.unparsedBody[i];

    const isWithinCurrentBlock =
      lineNumber === null
        ? false
        : lineNumber >= unparsedBlock.lineStart &&
          lineNumber <= unparsedBlock.lineStart + unparsedBlock.lines.length;

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
                const newParsed = parseWithContext(content);
                return await getMarkdown(tokenAtHover, newParsed, directory, null);
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
          return constToMarkupContent(block);
        } else if (isWithinCurrentBlock) {
          for (const letBlock of block.letBody) {
            switch (letBlock.kind) {
              case 'Function': {
                if (letBlock.name === tokenAtHover) {
                  return functionToMarkupContent(letBlock);
                }
                break;
              }
              case 'Const': {
                if (letBlock.name === tokenAtHover) {
                  return constToMarkupContent(letBlock);
                }
                break;
              }
            }
          }
        }
        break;
      }

      case 'Function': {
        if (block.name === tokenAtHover) {
          return functionToMarkupContent(block);
        } else if (isWithinCurrentBlock) {
          for (const letBlock of block.letBody) {
            switch (letBlock.kind) {
              case 'Function': {
                if (letBlock.name === tokenAtHover) {
                  return functionToMarkupContent(letBlock);
                }
                break;
              }
              case 'Const': {
                if (letBlock.name === tokenAtHover) {
                  return constToMarkupContent(letBlock);
                }
                break;
              }
            }
          }
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

      case 'UnionUntaggedType': {
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
  const parsed = parseWithContext(text);
  const isModuleReference = tokenAtHover.split('.').length === 2;
  const directory = dirName.split('file://')[1];

  let markdown: MarkupContent | null = null;
  if (isModuleReference) {
    const moduleName = tokenAtHover.split('.')[0];
    const tokenName = tokenAtHover.split('.')[1];
    markdown = await getMarkdownFromModuleReference(
      moduleName,
      tokenName,
      parsed,
      directory
    );
  } else {
    markdown = await getMarkdown(tokenAtHover, parsed, directory, params.position.line);
  }

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

async function findIdentifierLocationInImport(
  tokenName: string,
  moduleName: string,
  parsed: Module,
  directory: string
): Promise<Range | null> {
  for (const block of parsed.body) {
    switch (block.kind) {
      case 'Import': {
        for (const module of block.modules) {
        }
      }
    }
  }
  return null;
}

type IdentiferLocation = {
  range: Range;
  uri: string;
};

async function findIdentifierLocation(
  identifier: string,
  allText: string,
  uri: string
): Promise<IdentiferLocation | null> {
  const isModuleReference = identifier.split('.').length === 2;
  const moduleName = identifier.split('.')[0] || '';
  const tokenName = identifier.split('.')[1] || '';

  const parsed = parseWithContext(allText);
  for (let i = 0; i < parsed.body.length; i++) {
    const block = parsed.body[i];
    const unparsedBlock = parsed.unparsedBody[i];

    switch (block.kind) {
      case 'Const':
      case 'Function': {
        if (block.name === identifier) {
          return {
            uri: uri,
            range: {
              start: { line: unparsedBlock.lineStart, character: 0 },
              end: {
                line: unparsedBlock.lineStart + unparsedBlock.lines.length,
                character: 0,
              },
            },
          };
        }
        continue;
      }

      case 'TypeAlias': {
        if (block.type.name === identifier) {
          return {
            uri: uri,
            range: {
              start: { line: unparsedBlock.lineStart, character: 0 },
              end: {
                line: unparsedBlock.lineStart + unparsedBlock.lines.length,
                character: 0,
              },
            },
          };
        }
        continue;
      }

      case 'UnionType': {
        const isATag = block.tags.filter((tag) => tag.name === identifier).length > 0;
        if (block.type.name === identifier || isATag) {
          return {
            uri: uri,
            range: {
              start: { line: unparsedBlock.lineStart, character: 0 },
              end: {
                line: unparsedBlock.lineStart + unparsedBlock.lines.length,
                character: 0,
              },
            },
          };
        }
        continue;
      }

      case 'UnionUntaggedType': {
        if (block.type.name === identifier) {
          return {
            uri: uri,
            range: {
              start: { line: unparsedBlock.lineStart, character: 0 },
              end: {
                line: unparsedBlock.lineStart + unparsedBlock.lines.length,
                character: 0,
              },
            },
          };
        }
        continue;
      }

      case 'Import': {
        for (const module of block.modules) {
          if (module.namespace === 'Global') continue;
          if (
            module.exposing.includes(identifier) ||
            (isModuleReference &&
              module.alias.kind == 'Just' &&
              module.alias.value === moduleName)
          ) {
            const dirName = path.dirname(uri);
            const directory = dirName.split('file://')[1];
            const filename = path.join(directory, module.name.slice(1, -1) + '.derw');
            const identifierToUse = isModuleReference ? tokenName : identifier;
            try {
              const content = await readFile(filename, 'utf-8');
              return await findIdentifierLocation(
                identifierToUse,
                content,
                `file://${filename}`
              );
            } catch (e) {
              continue;
            }
          }
        }
      }
    }
  }

  return null;
}

connection.onDefinition(async (params: DefinitionParams): Promise<DefinitionLink[]> => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [ ];

  let tokenAtHover = '';
  try {
    tokenAtHover = closestToken(
      doc?.getText().split('\n')[params.position.line] || '',
      params.position.character
    );
  } catch {
    return [ ];
  }

  const location = await findIdentifierLocation(
    tokenAtHover,
    doc?.getText(),
    params.textDocument.uri
  );

  if (!location) return [ ];

  return [
    {
      targetUri: location.uri,
      targetRange: location.range,
      targetSelectionRange: location.range,
    },
  ];
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
