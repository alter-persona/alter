import mammoth from "mammoth";

export async function loadDocx(_filePath: string, buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value ?? "";
}
