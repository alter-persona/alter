-- Invariant 2: physically separate private/public indexes.
CREATE TABLE "VectorChunkPrivate" (
    "id" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "domain" TEXT,
    "date" TIMESTAMP(3),
    "origin" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "tokens" INTEGER NOT NULL,
    "embedding" vector(384),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VectorChunkPrivate_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "VectorChunkPublic" (
    "id" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "domain" TEXT,
    "date" TIMESTAMP(3),
    "origin" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "tokens" INTEGER NOT NULL,
    "embedding" vector(384),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VectorChunkPublic_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "VectorChunkPrivate_personaId_idx" ON "VectorChunkPrivate"("personaId");
CREATE INDEX "VectorChunkPublic_personaId_idx" ON "VectorChunkPublic"("personaId");
ALTER TABLE "VectorChunkPrivate" ADD CONSTRAINT "VectorChunkPrivate_personaId_fkey"
    FOREIGN KEY ("personaId") REFERENCES "Persona"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VectorChunkPublic" ADD CONSTRAINT "VectorChunkPublic_personaId_fkey"
    FOREIGN KEY ("personaId") REFERENCES "Persona"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve existing index rows, routed by sensitivity.
INSERT INTO "VectorChunkPrivate" ("id","personaId","sourceType","label","domain","date","origin","text","tokens","embedding","createdAt")
SELECT "id","personaId","sourceType","label","domain","date","origin","text","tokens","embedding","createdAt"
FROM "VectorChunk" WHERE "sensitivity" = 'private';
INSERT INTO "VectorChunkPublic" ("id","personaId","sourceType","label","domain","date","origin","text","tokens","embedding","createdAt")
SELECT "id","personaId","sourceType","label","domain","date","origin","text","tokens","embedding","createdAt"
FROM "VectorChunk" WHERE "sensitivity" = 'public';

DROP TABLE "VectorChunk";
