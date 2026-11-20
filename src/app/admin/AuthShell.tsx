export function AuthShell({ title, children, err }: { title: string; children: React.ReactNode; err?: string }) {
  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <div className="card w-full max-w-md">
        <div className="flex items-center gap-3 mb-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.svg" alt="" width={40} height={40} />
          <h1 className="h1">{title}</h1>
        </div>
        {err && <div className="rounded-xl px-4 py-3 mb-4 bg-red-50 text-red-800 border border-red-200">{err}</div>}
        {children}
      </div>
    </main>
  );
}
