import { prisma } from "./db";

/**
 * Factory rule: no hardcoded person. The default persona is UNDERSTUDY_NAME
 * from the environment (set by the installer); on an existing single-persona
 * database the sole persona is the default. Creation without a configured
 * name falls back to "You" so nothing crashes pre-configuration.
 */
const CONFIGURED_NAME = () => process.env.UNDERSTUDY_NAME?.trim();

export async function ensureDefaultPersona() {
  const configured = CONFIGURED_NAME();
  let persona = configured
    ? await prisma.persona.findUnique({ where: { name: configured } })
    : null;
  if (!persona) {
    persona = await prisma.persona.findFirst({ orderBy: { createdAt: "asc" } });
  }
  if (!persona) {
    persona = await prisma.persona.create({ data: { name: configured ?? "You" } });
  }
  await prisma.session.updateMany({
    where: { personaId: null },
    data: { personaId: persona.id },
  });
  return persona;
}

export async function personaForSession(sessionId: string) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { persona: true },
  });
  if (session?.persona) return session.persona;
  const fallback = await ensureDefaultPersona();
  if (session && !session.personaId) {
    await prisma.session.update({ where: { id: sessionId }, data: { personaId: fallback.id } });
  }
  return fallback;
}

export async function resolvePersona(idOrName: string) {
  return (
    (await prisma.persona.findUnique({ where: { id: idOrName } }).catch(() => null)) ??
    (await prisma.persona.findUnique({ where: { name: idOrName } }))
  );
}
