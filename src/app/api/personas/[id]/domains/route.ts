import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

/** Distinct domains already used by this persona — feeds the uploader's suggestions. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const [privDomains, pubDomains, fileDomains] = await Promise.all([
    prisma.vectorChunkPrivate.findMany({
      where: { personaId: id, domain: { not: null } },
      distinct: ["domain"],
      select: { domain: true },
    }),
    prisma.vectorChunkPublic.findMany({
      where: { personaId: id, domain: { not: null } },
      distinct: ["domain"],
      select: { domain: true },
    }),
    prisma.sessionFile.findMany({
      where: { session: { personaId: id }, domain: { not: null } },
      distinct: ["domain"],
      select: { domain: true },
    }),
  ]);
  const domains = [
    ...new Set([
      "general",
      ...[...privDomains, ...pubDomains, ...fileDomains].map((d) => d.domain!),
    ]),
  ].sort();
  return NextResponse.json({ domains });
}
