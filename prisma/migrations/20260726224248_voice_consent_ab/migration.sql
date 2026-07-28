-- AlterTable
ALTER TABLE "Persona" ADD COLUMN     "voiceConsentAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "VoiceAbResult" (
    "id" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "listener" TEXT NOT NULL,
    "sentenceIdx" INTEGER NOT NULL,
    "positionOfLocal" TEXT NOT NULL,
    "pick" TEXT NOT NULL,
    "pickedLocal" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoiceAbResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VoiceAbResult_personaId_idx" ON "VoiceAbResult"("personaId");
