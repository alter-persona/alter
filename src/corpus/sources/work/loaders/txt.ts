export async function loadTxt(_filePath: string, buffer: Buffer): Promise<string> {
  return buffer.toString("utf8");
}
