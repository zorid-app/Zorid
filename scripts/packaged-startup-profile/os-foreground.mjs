// Existing Electron-only boundary, extracted for the missing OS activation test.
export async function requestOwnedForeground({readWindow,focusWindow,receipt={}}){receipt.beforeWindow=await readWindow();receipt.request=await focusWindow();return receipt;}
