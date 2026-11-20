"use client";
import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

/** Camera QR scanner (BarcodeDetector when available, jsQR fallback). Calls onResult once. */
export function Scanner({ onResult }: { onResult: (text: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let cancelled = false;
    type BD = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> };
    let detector: BD | null = null;
    const W = window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => BD };
    if (W.BarcodeDetector) {
      try { detector = new W.BarcodeDetector({ formats: ["qr_code"] }); } catch { detector = null; }
    }
    async function start() {
      if (!window.isSecureContext) {
        setError("الكاميرا تحتاج رابط https — اكتب الرمز");
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("المتصفح لا يسمح بالكاميرا (في Fully Kiosk: فعّل Enable Webcam Access) — اكتب الرمز");
        return;
      }
      // back camera first, then any camera (some tablets / kiosk browsers refuse facingMode)
      const attempts: MediaStreamConstraints[] = [
        { video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false },
        { video: true, audio: false },
      ];
      let lastErr: unknown = null;
      for (const c of attempts) {
        try {
          stream = await navigator.mediaDevices.getUserMedia(c);
          break;
        } catch (e) {
          lastErr = e;
          if ((e as DOMException)?.name === "NotAllowedError") break; // permission refused: retrying will not help
        }
      }
      if (!stream) {
        const name = (lastErr as DOMException)?.name ?? "";
        setError(
          name === "NotAllowedError" ? "إذن الكاميرا مرفوض (أعطِ Fully Kiosk إذن الكاميرا وفعّل Enable Webcam Access) — اكتب الرمز"
          : name === "NotFoundError" || name === "OverconstrainedError" ? "لم يتم العثور على كاميرا — اكتب الرمز"
          : name === "NotReadableError" ? "الكاميرا مستعملة من تطبيق آخر — اكتب الرمز"
          : `لا يمكن فتح الكاميرا (${name || "خطأ"}) — اكتب الرمز`,
        );
        return;
      }
      try {
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        const v = videoRef.current!;
        v.setAttribute("playsinline", "true");
        v.srcObject = stream;
        await v.play();
        tick();
      } catch (e) {
        setError(`لا يمكن تشغيل الكاميرا (${(e as Error)?.name ?? "خطأ"}) — اكتب الرمز`);
      }
    }
    async function tick() {
      if (cancelled || done.current) return;
      const v = videoRef.current, c = canvasRef.current;
      if (v && c && v.readyState >= 2) {
        const w = v.videoWidth, h = v.videoHeight;
        c.width = w; c.height = h;
        const ctx = c.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(v, 0, 0, w, h);
        let text: string | null = null;
        if (detector) {
          try { const r = await detector.detect(c); text = r[0]?.rawValue ?? null; } catch { detector = null; }
        }
        if (!text) {
          const img = ctx.getImageData(0, 0, w, h);
          text = jsQR(img.data, w, h, { inversionAttempts: "dontInvert" })?.data ?? null;
        }
        if (text && !done.current) {
          done.current = true;
          onResult(text);
          return;
        }
      }
      raf = requestAnimationFrame(() => { void tick(); });
    }
    void start();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onResult]);

  return (
    <div className="relative w-full aspect-video bg-black rounded-2xl overflow-hidden">
      <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
      <canvas ref={canvasRef} className="hidden" />
      <div className="absolute inset-[15%] border-4 border-white/70 rounded-2xl pointer-events-none" />
      {error && <div className="absolute inset-0 flex items-center justify-center text-white text-2xl bg-black/70 p-6 text-center">{error}</div>}
    </div>
  );
}
