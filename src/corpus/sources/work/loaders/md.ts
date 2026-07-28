export async function loadMd(_filePath: string, buffer: Buffer): Promise<string> {
  return buffer.toString("utf8");
}
