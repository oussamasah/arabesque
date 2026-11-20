/** Ticket QR URLs reveal nothing (spec §9). The token is only meaningful to the tablet scanner. */
export default function TicketPublicPage() {
  return (
    <main className="min-h-screen flex items-center justify-center p-8 text-center">
      <p className="text-lg">تذكرة — تُستعمل فقط في المقهى.</p>
    </main>
  );
}
