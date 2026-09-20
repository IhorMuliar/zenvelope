import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";

interface Props {
  value: string;
  size?: number;
}

/** Renders a payment URI to a canvas. Nothing leaves the browser. */
export function Qr({ value, size = 232 }: Props) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const canvas = ref.current;
    if (!canvas) return;
    QRCode.toCanvas(canvas, value, {
      width: size,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#000000ff", light: "#ffffffff" },
    })
      .then(() => {
        if (!cancelled) setError(null);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  return (
    <div className="qr">
      <canvas ref={ref} width={size} height={size} aria-label="Payment QR code" />
      {error ? <p className="error">QR could not be drawn: {error}</p> : null}
    </div>
  );
}
