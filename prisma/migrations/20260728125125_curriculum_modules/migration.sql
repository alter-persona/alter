-- AlterTable
ALTER TABLE "Question" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "artifactInvite" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "module" TEXT;
