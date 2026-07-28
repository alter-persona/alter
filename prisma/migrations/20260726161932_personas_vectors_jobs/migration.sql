CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "IngestStatus" AS ENUM ('queued', 'running', 'embedded', 'failed');

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "personaId" TEXT;

-- AlterTable
ALTER TABLE "SessionFile" ADD COLUMN     "ingestError" TEXT,
ADD COLUMN     "ingestStatus" "IngestStatus" NOT NULL DEFAULT 'queued';

-- CreateTable
CREATE TABLE "Persona" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "voiceRefPath" TEXT,
    "voiceId" TEXT,
    "modelBinding" TEXT NOT NULL DEFAULT 'ollama/local-large',
    "packVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Persona_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VectorChunk" (
    "id" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "sensitivity" "FileSensitivity" NOT NULL,
    "sourceType" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "domain" TEXT,
    "date" TIMESTAMP(3),
    "origin" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "tokens" INTEGER NOT NULL,
    "embedding" vector(384),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VectorChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StylometryRecord" (
    "personaId" TEXT NOT NULL,
    "totalWords" INTEGER NOT NULL DEFAULT 0,
    "totalSentences" INTEGER NOT NULL DEFAULT 0,
    "totalLines" INTEGER NOT NULL DEFAULT 0,
    "listLines" INTEGER NOT NULL DEFAULT 0,
    "wordFreq" JSONB NOT NULL DEFAULT '{}',
    "phraseFreq" JSONB NOT NULL DEFAULT '{}',
    "sentenceLenHist" JSONB NOT NULL DEFAULT '{}',
    "distinctive" JSONB NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StylometryRecord_pkey" PRIMARY KEY ("personaId")
);

-- CreateTable
CREATE TABLE "IngestJob" (
    "id" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fileId" TEXT,
    "responseId" TEXT,
    "zipPath" TEXT,
    "status" "IngestStatus" NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngestJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Persona_name_key" ON "Persona"("name");

-- CreateIndex
CREATE INDEX "VectorChunk_personaId_sensitivity_idx" ON "VectorChunk"("personaId", "sensitivity");

-- CreateIndex
CREATE INDEX "IngestJob_status_idx" ON "IngestJob"("status");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_personaId_fkey" FOREIGN KEY ("personaId") REFERENCES "Persona"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VectorChunk" ADD CONSTRAINT "VectorChunk_personaId_fkey" FOREIGN KEY ("personaId") REFERENCES "Persona"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StylometryRecord" ADD CONSTRAINT "StylometryRecord_personaId_fkey" FOREIGN KEY ("personaId") REFERENCES "Persona"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngestJob" ADD CONSTRAINT "IngestJob_personaId_fkey" FOREIGN KEY ("personaId") REFERENCES "Persona"("id") ON DELETE CASCADE ON UPDATE CASCADE;