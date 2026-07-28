import Interview from "./Interview";
import FilesPanel from "./FilesPanel";

export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <>
      <Interview sessionId={id} />
      <FilesPanel sessionId={id} />
    </>
  );
}
