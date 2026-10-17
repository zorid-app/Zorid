const parameters = new URLSearchParams(location.search);
const config = {
  moduleUrl: new URL(parameters.get('module') ?? '/target/browser-wasm/generated/zorid_wasm.js', location.href).href,
  corpusUrl: new URL(parameters.get('corpus') ?? '../document-semantics/markdown/corpus.json', location.href).href,
};
config.wasmUrl = new URL(parameters.get('wasm') ?? 'zorid_wasm_bg.wasm', config.moduleUrl).href;
const status = document.querySelector('#status');
const facts = document.querySelector('#facts');
const failures = document.querySelector('#failures');
const runButton = document.querySelector('#run');
const resultsButton = document.querySelector('#download-results');
const reportButton = document.querySelector('#download-report');
let worker;
let report;

function showFacts(entries) {
  facts.replaceChildren();
  for (const [label, value] of Object.entries(entries)) {
    const term = document.createElement('dt');
    const detail = document.createElement('dd');
    term.textContent = label;
    detail.textContent = typeof value === 'object' ? JSON.stringify(value) : String(value);
    facts.append(term, detail);
  }
}
function finish(value) {
  report = value;
  window.__zoridDocumentSemantics = value;
  status.textContent = value.status === 'passed' ? `PASS ${value.passed} corpus cases and ${value.requestChecks?.length ?? 0} request checks` : `FAIL: ${value.failures?.length ?? 1} failures`;
  showFacts(Object.fromEntries(Object.entries(value).filter(([key]) => !['results', 'failures'].includes(key))));
  failures.textContent = value.failures?.length ? JSON.stringify(value.failures, null, 2) : 'No failures.';
  resultsButton.disabled = !Array.isArray(value.results);
  reportButton.disabled = false;
  runButton.disabled = false;
  worker?.terminate();
  worker = undefined;
  window.dispatchEvent(new CustomEvent('zorid-document-semantics-complete', { detail: value }));
}
function run() {
  worker?.terminate();
  report = undefined;
  window.__zoridDocumentSemantics = { status: 'running', ...config };
  runButton.disabled = true;
  resultsButton.disabled = true;
  reportButton.disabled = true;
  status.textContent = 'Loading canonical corpus and generated WASM…';
  failures.textContent = '';
  showFacts(config);
  worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') {
      status.textContent = `Running ${data.completed}/${data.total} fixtures…`;
      return;
    }
    if (data.type === 'complete') finish(data.report);
  };
  worker.onerror = event => finish({ status: 'failed', ...config, failures: [{ phase: 'worker', message: event.message }] });
  worker.postMessage(config);
}
function download(value, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
runButton.addEventListener('click', run);
resultsButton.addEventListener('click', () => download(report.results, 'browser-document-results.json'));
reportButton.addEventListener('click', () => download(report, 'browser-document-report.json'));
if (parameters.get('autorun') !== '0') run();
