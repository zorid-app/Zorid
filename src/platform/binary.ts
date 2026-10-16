/** Encode in bounded chunks; spreading an attachment into function arguments can overflow. */
export function bytesToBase64(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) throw new Error('Attachment contents must be a Uint8Array');
  const chunks: string[] = [];
  const chunkSize = 24_576; // divisible by three, so only the final chunk needs padding
  for (let start = 0; start < bytes.length; start += chunkSize) {
    let chunk = '';
    const end = Math.min(start + chunkSize, bytes.length);
    for (let index = start; index < end; index++) chunk += String.fromCharCode(bytes[index]);
    chunks.push(btoa(chunk));
  }
  return chunks.join('');
}

export function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
