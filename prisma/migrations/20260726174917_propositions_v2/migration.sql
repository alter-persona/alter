-- CreateTable
CREATE TABLE "PropositionPrivate" (
    "id" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "strength" TEXT,
    "date" TIMESTAMP(3),
    "topics" TEXT[],
    "sourceOrigins" TEXT[],
    "supportIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "embedding" vector(384),
    "indexVersion" INTEGER NOT NULL DEFAULT 2,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PropositionPrivate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropositionPublic" (
    "id" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "strength" TEXT,
    "date" TIMESTAMP(3),
    "topics" TEXT[],
    "sourceOrigins" TEXT[],
    "supportIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "embedding" vector(384),
    "indexVersion" INTEGER NOT NULL DEFAULT 2,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PropositionPublic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StyleFingerprint" (
    "personaId" TEXT NOT NULL,
    "spoken" JSONB NOT NULL,
    "written" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StyleFingerprint_pkey" PRIMARY KEY ("personaId")
);

-- CreateIndex
CREATE INDEX "PropositionPrivate_personaId_idx" ON "PropositionPrivate"("personaId");

-- CreateIndex
CREATE INDEX "PropositionPublic_personaId_idx" ON "PropositionPublic"("personaId");

-- AddForeignKey
ALTER TABLE "PropositionPrivate" ADD CONSTRAINT "PropositionPrivate_personaId_fkey" FOREIGN KEY ("personaId") REFERENCES "Persona"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropositionPublic" ADD CONSTRAINT "PropositionPublic_personaId_fkey" FOREIGN KEY ("personaId") REFERENCES "Persona"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StyleFingerprint" ADD CONSTRAINT "StyleFingerprint_personaId_fkey" FOREIGN KEY ("personaId") REFERENCES "Persona"("id") ON DELETE CASCADE ON UPDATE CASCADE;
