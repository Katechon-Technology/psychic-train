import Link from "next/link";
import SessionView from "./SessionView";
import GlitchTransition from "../../../components/GlitchTransition";

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <GlitchTransition token={id}>
      <main className="mx-auto max-w-6xl p-4 space-y-4">
        <Link href="/" className="text-sm text-neutral-500 hover:text-neutral-300">← home</Link>
        <SessionView sessionId={id} />
      </main>
    </GlitchTransition>
  );
}
