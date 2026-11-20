import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-6 p-8">
      <h1 className="h1">نظام المقهى</h1>
      <div className="flex gap-4">
        <Link href="/pos" className="btn text-xl px-8 py-4">شاشة الطلبات (التابلت)</Link>
        <Link href="/admin" className="btn btn-ghost text-xl px-8 py-4">لوحة الإدارة</Link>
      </div>
    </main>
  );
}
