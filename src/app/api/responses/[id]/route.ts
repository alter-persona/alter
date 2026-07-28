import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const response = await prisma.response.findUnique({ where: { id } });
  if (!response) return NextResponse.json({ error: "response not found" }, { status: 404 });
  return NextResponse.json({ response });
}
