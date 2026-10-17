/** Original worker protocol around an independently supplied upstream Prism bundle. */
interface PrismToken { type: string; alias?: string | string[]; content: string | PrismToken | (string | PrismToken)[] }
interface PrismEngine { manual: boolean; disableWorkerMessageHandler: boolean; languages: Record<string, unknown>; tokenize(source: string, grammar: unknown): (string | PrismToken)[] }
const scope = globalThis as unknown as { Prism: PrismEngine; importScripts(url: string): void; postMessage(value: unknown): void; onmessage: ((event: MessageEvent) => void) | null };
let loadedURL = '';
scope.onmessage = event => {
  const { id, source, language, engineURL } = event.data as { id: number; source: string; language: string; engineURL: string };
  try {
    if (!loadedURL) {
      scope.Prism = { manual: true, disableWorkerMessageHandler: true } as PrismEngine;
      scope.importScripts(engineURL); loadedURL = engineURL;
    }
    const grammar = Object.hasOwn(scope.Prism.languages, language) && typeof scope.Prism.languages[language] === 'object' ? scope.Prism.languages[language] : undefined;
    const tokens: { from: number; to: number; classes: string[] }[] = [];
    let offset = 0;
    const visit = (token: string | PrismToken | (string | PrismToken)[], inherited: string[] = []): void => {
      if (typeof token === 'string') { if (token.length && inherited.length) tokens.push({ from: offset, to: offset + token.length, classes: inherited }); offset += token.length; }
      else if (Array.isArray(token)) for (const child of token) visit(child, inherited);
      else visit(token.content, [...new Set([...inherited, token.type, ...(typeof token.alias === 'string' ? [token.alias] : token.alias ?? [])])]);
    };
    if (grammar) visit(scope.Prism.tokenize(source, grammar));
    scope.postMessage({ id, tokens });
  } catch (error) { scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
};

