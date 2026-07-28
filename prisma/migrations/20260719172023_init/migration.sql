-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('in_progress', 'complete');

-- CreateEnum
CREATE TYPE "QuestionType" AS ENUM ('voice', 'likert');

-- CreateEnum
CREATE TYPE "TranscriptStatus" AS ENUM ('pending', 'done', 'failed');

-- CreateEnum
CREATE TYPE "OceanDomain" AS ENUM ('O', 'C', 'E', 'A', 'N');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "isTrial" BOOLEAN NOT NULL DEFAULT false,
    "status" "SessionStatus" NOT NULL DEFAULT 'in_progress',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Question" (
    "id" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL,
    "section" TEXT NOT NULL,
    "type" "QuestionType" NOT NULL,
    "promptText" TEXT NOT NULL,
    "oceanDomain" "OceanDomain",
    "facet" TEXT,
    "reverseScored" BOOLEAN NOT NULL DEFAULT false,
    "isValidation" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Response" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "type" "QuestionType" NOT NULL,
    "audioPath" TEXT,
    "audioDurationSec" DOUBLE PRECISION,
    "transcript" TEXT,
    "transcriptStatus" "TranscriptStatus",
    "transcriptSource" TEXT,
    "transcriptEditedByUser" BOOLEAN NOT NULL DEFAULT false,
    "likertValue" INTEGER,
    "skipped" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Response_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Question_orderIndex_key" ON "Question"("orderIndex");

-- CreateIndex
CREATE UNIQUE INDEX "Response_sessionId_questionId_key" ON "Response"("sessionId", "questionId");

-- AddForeignKey
ALTER TABLE "Response" ADD CONSTRAINT "Response_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Response" ADD CONSTRAINT "Response_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
