-- AlterTable
ALTER TABLE "PropositionPrivate" ADD COLUMN     "parentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "period" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active';

-- AlterTable
ALTER TABLE "PropositionPublic" ADD COLUMN     "parentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "period" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active';

-- CreateTable
CREATE TABLE "UpdateEvent" (
    "id" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "rawText" TEXT,
    "audioPath" TEXT,
    "filePath" TEXT,
    "filename" TEXT,
    "register" TEXT,
    "intent" TEXT NOT NULL DEFAULT 'chat',
    "intentSource" TEXT NOT NULL DEFAULT 'default',
    "correctionType" TEXT,
    "replyToEventId" TEXT,
    "retrievalLog" JSONB,
    "sensitivity" TEXT NOT NULL DEFAULT 'private',
    "status" TEXT NOT NULL DEFAULT 'captured',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UpdateEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HotNote" (
    "id" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "sourceEventId" TEXT NOT NULL,
    "pendingCaseId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "HotNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconCase" (
    "id" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "newPropId" TEXT NOT NULL,
    "oldPropId" TEXT NOT NULL,
    "newText" TEXT NOT NULL,
    "oldText" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolution" TEXT,
    "confidence" DOUBLE PRECISION,
    "question" TEXT,
    "theme" TEXT,
    "askedInChat" BOOLEAN NOT NULL DEFAULT false,
    "answerEventId" TEXT,
    "log" JSONB NOT NULL DEFAULT '[]',
    "sourceEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "ReconCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExemplarPair" (
    "id" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'written',
    "personaOriginal" TEXT NOT NULL,
    "correctedText" TEXT NOT NULL,
    "rule" TEXT,
    "sourceEventId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExemplarPair_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegressionCase" (
    "id" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "triggerInput" TEXT NOT NULL,
    "rejectedOutput" TEXT NOT NULL,
    "correctedOutput" TEXT NOT NULL,
    "sourceEventId" TEXT NOT NULL,
    "lastResult" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegressionCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoverageGap" (
    "id" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "weakCount" INTEGER NOT NULL DEFAULT 1,
    "lastInvitedAt" TIMESTAMP(3),
    "ignoredCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoverageGap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingApproval" (
    "id" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sourceEventId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "PendingApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoopJob" (
    "id" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoopJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScoreboardEntry" (
    "id" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "metrics" JSONB NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScoreboardEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelPref" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "voiceReplies" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ChannelPref_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UpdateEvent_personaId_createdAt_idx" ON "UpdateEvent"("personaId", "createdAt");

-- CreateIndex
CREATE INDEX "UpdateEvent_conversationId_createdAt_idx" ON "UpdateEvent"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "HotNote_personaId_active_idx" ON "HotNote"("personaId", "active");

-- CreateIndex
CREATE INDEX "ReconCase_personaId_status_idx" ON "ReconCase"("personaId", "status");

-- CreateIndex
CREATE INDEX "ExemplarPair_personaId_idx" ON "ExemplarPair"("personaId");

-- CreateIndex
CREATE INDEX "RegressionCase_personaId_idx" ON "RegressionCase"("personaId");

-- CreateIndex
CREATE UNIQUE INDEX "CoverageGap_personaId_topic_key" ON "CoverageGap"("personaId", "topic");

-- CreateIndex
CREATE INDEX "PendingApproval_personaId_status_idx" ON "PendingApproval"("personaId", "status");

-- CreateIndex
CREATE INDEX "LoopJob_status_idx" ON "LoopJob"("status");

-- CreateIndex
CREATE INDEX "ScoreboardEntry_personaId_runAt_idx" ON "ScoreboardEntry"("personaId", "runAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelPref_channel_conversationId_key" ON "ChannelPref"("channel", "conversationId");

-- CreateIndex
CREATE INDEX "PropositionPrivate_personaId_status_idx" ON "PropositionPrivate"("personaId", "status");

-- CreateIndex
CREATE INDEX "PropositionPublic_personaId_status_idx" ON "PropositionPublic"("personaId", "status");
