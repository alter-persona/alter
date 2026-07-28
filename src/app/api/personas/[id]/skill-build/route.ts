import { NextRequest, NextResponse } from "next/server";
import { buildSkillPack, SkillBuildError } from "@/skill/build";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const result = await buildSkillPack(id, { noLlm: true });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof SkillBuildError) {
      return NextResponse.json({ error: e.message }, { status: 422 });
    }
    throw e;
  }
}
