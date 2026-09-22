"use client";

import { Camera, Square } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { assetQrPath, parseAssetQrCode } from "@/lib/asset-qr";
import styles from "@/app/assets/asset-page.module.css";

type CameraState = "idle" | "starting" | "scanning";

function cameraError(error: unknown) {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Allow camera access, or enter the asset number below.";
  if (name === "NotFoundError") return "No camera found. Enter the asset number below.";
  return "Camera unavailable. Try again or enter the asset number below.";
}

export function AssetQrScanner() {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const stopRef = useRef<() => void>(() => {});
  const navigatingRef = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<CameraState>("idle");
  const [message, setMessage] = useState("");
  const [manualCode, setManualCode] = useState("");

  const openDevice = useCallback((value: string) => {
    const code = parseAssetQrCode(value);
    if (!code) {
      setMessage("Use a People Hub device QR or an asset number such as MAM-IT-000001.");
      return false;
    }
    if (navigatingRef.current) return true;
    navigatingRef.current = true;
    stopRef.current();
    setState("idle");
    setMessage("Opening device…");
    // Never navigate to decoded QR content. Rebuild the trusted local path.
    router.push(assetQrPath(code));
    return true;
  }, [router]);

  useEffect(() => {
    if (!attempt) return;
    let stopped = false;
    let stream: MediaStream | null = null;
    let frame = 0;
    const video = videoRef.current;
    const stop = () => {
      stopped = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => {
        track.removeEventListener("ended", onEnded);
        track.stop();
      });
      if (video) {
        video.pause();
        video.srcObject = null;
      }
    };
    function onEnded() {
      stop();
      setState("idle");
      setMessage("Camera stopped. Start the camera to try again.");
    }
    const onHidden = () => {
      if (document.hidden) {
        stop();
        setState("idle");
      }
    };
    stopRef.current = stop;
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", stop);

    async function scan() {
      try {
        if (!video || !window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
          throw new Error("Camera unsupported");
        }
        // jsQR reads local pixels, including on iOS Safari where BarcodeDetector
        // is unavailable. Neither video nor image data leaves this browser.
        const { default: jsQR } = await import("jsqr");
        if (stopped) return;
        const acquired = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        if (stopped) {
          acquired.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = acquired;
        stream.getTracks().forEach((track) => track.addEventListener("ended", onEnded));
        video.srcObject = stream;
        await video.play();
        if (stopped) return;
        setState("scanning");
        setMessage("Point the camera at the device QR.");
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("Camera unsupported");
        let lastRead = 0;
        const tick = (time: number) => {
          if (stopped) return;
          try {
            if (time - lastRead >= 140 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth) {
              lastRead = time;
              const scale = Math.min(1, 960 / video.videoWidth);
              canvas.width = Math.round(video.videoWidth * scale);
              canvas.height = Math.round(video.videoHeight * scale);
              context.drawImage(video, 0, 0, canvas.width, canvas.height);
              const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
              const qr = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: "attemptBoth" });
              if (qr && openDevice(qr.data)) return;
            }
            frame = requestAnimationFrame(tick);
          } catch (error) {
            stop();
            setState("idle");
            setMessage(cameraError(error));
          }
        };
        frame = requestAnimationFrame(tick);
      } catch (error) {
        if (stopped) return;
        stop();
        setState("idle");
        setMessage(cameraError(error));
      }
    }
    void scan();
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", stop);
    };
  }, [attempt, openDevice]);

  function submitManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    openDevice(manualCode);
  }

  return (
    <div className={styles.scanner}>
      <div className={styles.camera} hidden={state === "idle"}>
        <video ref={videoRef} autoPlay muted playsInline aria-label="Device QR camera preview" />
      </div>
      <div className={styles.actions}>
        {state === "idle" ? (
          <button className={`${styles.button} ${styles.primary}`} type="button" onClick={() => {
            navigatingRef.current = false;
            setState("starting");
            setMessage("Opening camera…");
            setAttempt((value) => value + 1);
          }}><Camera size={18} aria-hidden="true" />Start camera</button>
        ) : (
          <button className={styles.button} type="button" onClick={() => { stopRef.current(); setState("idle"); setMessage(""); }}>
            <Square size={16} aria-hidden="true" />Stop camera
          </button>
        )}
      </div>
      <p className={styles.message} role="status" aria-live="polite">{message}</p>
      <form className={styles.manual} onSubmit={submitManual}>
        <label htmlFor="asset-number">Asset number</label>
        <div>
          <input className={styles.input} id="asset-number" value={manualCode} onChange={(event) => setManualCode(event.target.value)}
            placeholder="MAM-IT-000001" autoCapitalize="characters" autoComplete="off" spellCheck={false} maxLength={64} required />
          <button className={styles.button} type="submit">Open</button>
        </div>
      </form>
    </div>
  );
}
