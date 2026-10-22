import assert from 'node:assert/strict';
export const vaultName='Native select probe';
const book='---\ntype: book\ntopics: [Design]\nuntouched: preserve\n---\nNative select probe body.\n';
const base='filters: \'note.type == "book"\'\nviews:\n  - type: table\n    name: Probe\n    order: [file.name, note.topics]\n';
const definitions={properties:{topics:{type:'multiselect',options:[{value:'Rust',color:'orange'},{value:'Design',color:'blue'},{value:'Writing',color:'green'}]}}};
export function fixtureFiles(){return new Map([['Book 001.md',book],['Library.base',base],['Properties.yaml',JSON.stringify(definitions,null,2)+'\n']]);}
const active='.pane.is-active .bases-session',dialog='[role="dialog"][aria-label="Property settings"]';
export async function journey(c){
  c.evidence.scope='Native macOS SELECT input diagnostics through an ordinary production property panel; not full heavy-user or Q3 acceptance.';
  c.evidence.limitations.push('DOM :open and Chromium screenshots cannot establish a macOS native menu state or OS keyboard routing. Passive frames add CDP round trips and can affect timing.');
  await c.launch('native-select-same-production-control');await c.ui.openFile('Library.base');await c.ui.idle();
  await c.ui.wait(`return document.querySelector('${active} [role="grid"]')?.getAttribute('aria-rowcount')==='2';`,'One authored book admitted');
  await c.ui.button('Properties',active);await c.ui.button('Configure property topics','[role="dialog"][aria-label="Properties"]');await c.ui.button('Property type','[role="dialog"][aria-label="Property"]');
  await c.ui.wait(`return !!document.querySelector(${JSON.stringify(dialog)});`,'Ordinary shared property panel');
  await c.ui.button('Add option',dialog);
  const row=`${dialog} .bases-property-option-row:nth-child(4)`,select=`${row} select[aria-label="Option color"]`;
  await c.ui.type(`${row} input[aria-label="Stored option value"]`,'Research');await c.ui.type(`${row} input[aria-label="Option label"]`,'Research');
  await c.screenshot('native-select-before-input');
  // Identical first recipe to the full journey: click, Home, eight Down, Enter.
  // UI.select keeps its exact expected-value readback; any failure stops here.
  await c.ui.select(select,'purple');await c.screenshot('native-select-after-readback');
  await c.ui.button('Apply',dialog);await c.ui.wait(`return !document.querySelector(${JSON.stringify(dialog)});`,'Explicit property definition Apply');
  await c.saved('Properties.yaml',source=>assert.deepEqual(c.yaml.parse(source),{properties:{topics:{type:'multiselect',options:[{value:'Rust',color:'orange'},{value:'Design',color:'blue'},{value:'Writing',color:'green'},{value:'Research',label:'Research',color:'purple'}]}}}),'native-select-purple-durable-definition');
  await c.saved('Book 001.md',source=>assert.equal(source,book),'native-select-note-exactly-unchanged');
  await c.saved('Library.base',source=>assert.equal(source,base),'native-select-base-exactly-unchanged');
  await c.quit('native-select-probe-normal-quit');
}
