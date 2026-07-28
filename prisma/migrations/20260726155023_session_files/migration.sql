-- CreateEnum
CREATE TYPE "FileSensitivity" AS ENUM ('private', 'public');

-- CreateTable
CREATE TABLE "SessionFile" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "storedPath" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "domain" TEXT,
    "sensitivity" "FileSensitivity" NOT NULL DEFAULT 'private',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionFile_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "SessionFile" ADD CONSTRAINT "SessionFile_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
