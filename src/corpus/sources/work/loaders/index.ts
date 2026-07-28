import { loadMd } from "./md";
import { loadTxt } from "./txt";
import { loadPdf } from "./pdf";
import { loadDocx } from "./docx";
import { loadHtml } from "./html";
import { loadEml } from "./eml";

/** One loader per extension. New format = one loader file + one entry here. */
export type FileLoader = (filePath: string, buffer: Buffer) => Promise<string>;

export const LOADERS: Record<string, FileLoader> = {
  ".md": loadMd,
  ".txt": loadTxt,
  ".pdf": loadPdf,
  ".docx": loadDocx,
  ".html": loadHtml,
  ".htm": loadHtml,
  ".eml": loadEml,
};
